// server.timeline.v5.js
// Express server with activity timeline support
// - Polls game instances for /players snapshots and records pings in-memory
// - Merges sessions when gaps < 3 minutes
// - Serves /api/overlay/activity/batch for 1h/1d/1w/1m windows
// - Aligns bins to the CLIENT'S local time via tzOffsetMin
// - Caps batch to 50 ids
//
// Drop-in: replace your server.js or merge the routes. Safe defaults keep other
// endpoints working (mapping/alerts/leaderboard minimal stubs).

// -------------------- bootstrap --------------------
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

// -------------------- config -----------------------
const INACT_MS = 3 * 60 * 1000;         // inactivity threshold (merge gap)
const RETAIN_MS = 35 * 24 * 60 * 60 * 1000; // keep ~35 days
const BATCH_CAP = 50;

// Known game instances to poll (can override with SERVERS env as CSV like "us-1,us-5,us-20,eu-1")
const DEFAULT_SERVERS = ['us-1', 'us-5', 'us-20'];
const SERVERS = (process.env.SERVERS || DEFAULT_SERVERS.join(',')).split(',').map(s => s.trim()).filter(Boolean);

const WINDOWS = {
  '1h': { binMs:  5 * 60 * 1000, count: 12 },
  '1d': { binMs: 60 * 60 * 1000, count: 24 },
  '1w': { binMs: 12 * 60 * 60 * 1000, count: 14 },
  '1m': { binMs: 24 * 60 * 60 * 1000, count: 30 },
};

// -------------------- in-memory store ---------------
/**
 * store: Map<privyId, {
 *   sessions: Array<{start:number,end:number}>,
 *   pings: Array<{ts:number, username?:string, region?:string}>
 * }>
 */
const store = new Map();

function parseRegionFromServerKey(serverKey) {
  const m = String(serverKey || '').match(/^(us|eu)\b/i);
  return m ? m[1].toUpperCase() : 'US';
}

function ensureRec(id) {
  if (!store.has(id)) {
    store.set(id, { sessions: [], pings: [] });
  }
  return store.get(id);
}

function pruneOld(rec, now) {
  const cutoff = now - RETAIN_MS;
  rec.sessions = rec.sessions.filter(s => s.end >= cutoff);
  rec.pings = rec.pings.filter(p => p.ts >= cutoff);
}

function addPing({ id, ts, username, region }) {
  if (!id || !Number.isFinite(ts)) return;
  const rec = ensureRec(id);
  pruneOld(rec, ts);

  // append ping
  rec.pings.push({ ts, username, region });

  // extend or start a session
  const arr = rec.sessions;
  const last = arr[arr.length - 1];
  if (last && ts - last.end <= INACT_MS) {
    last.end = ts;
  } else {
    arr.push({ start: ts, end: ts });
  }
}

// -------------------- polling game servers ----------
async function fetchPlayers(serverKey) {
  const [region, amount] = String(serverKey).split('-');
  const url = `https://damnbruh-game-server-instance-${amount}-${region}.onrender.com/players`;
  const rsp = await fetch(url, { cache: 'no-store' }).catch(() => null);
  if (!rsp || !rsp.ok) return [];
  let j = null;
  try { j = await rsp.json(); } catch {}
  const arr = Array.isArray(j) ? j : (Array.isArray(j?.players) ? j.players : []);
  return arr;
}

async function pollOnce() {
  const ts = Date.now();
  for (const key of SERVERS) {
    try {
      const region = parseRegionFromServerKey(key);
      const players = await fetchPlayers(key);
      for (const p of players) {
        const id  = p.privyId || p.id || p.playerId;
        const mv  = Number(p.monetaryValue ?? p.value ?? p.money ?? 0);
        const name = p.name || p.username || p.playerName || '';
        if (!id || !(mv > 0)) continue;            // user rule: only monetaryValue > 0
        addPing({ id, ts, username: name, region });
      }
    } catch {}
  }
}

// start poller
setInterval(pollOnce, 5_000);
pollOnce().catch(()=>{});

// -------------------- helpers -----------------------
function alignWindowStart(now, binMs, count, tzOffsetMin) {
  // convert server 'now' to client's local 'now' using the offset the client sent
  const offMs = (Number(tzOffsetMin) || 0) * 60 * 1000;
  const localNow = now - offMs; // pretend we're in the client's timezone
  const alignedRight = Math.floor(localNow / binMs) * binMs;
  const startLocal = alignedRight - (count - 1) * binMs;
  return startLocal + offMs; // convert back to UTC epoch
}

function buildBinsForId(id, startMs, binMs, count) {
  const rec = store.get(id);
  if (!rec) return { bins: '0'.repeat(count), meta: Array.from({length:count}, ()=>({})) };

  // Pre-scan sessions to mark actives
  const active = new Array(count).fill(0);
  for (const s of rec.sessions) {
    // clip session to window
    const L = Math.max(s.start, startMs);
    const R = Math.min(s.end, startMs + count * binMs - 1);
    if (R < L) continue;
    let i0 = Math.floor((L - startMs) / binMs);
    let i1 = Math.floor((R - startMs) / binMs);
    i0 = Math.max(0, Math.min(count - 1, i0));
    i1 = Math.max(0, Math.min(count - 1, i1));
    for (let i = i0; i <= i1; i++) active[i] = 1;
  }

  // Build metadata per bin from pings
  const meta = Array.from({ length: count }, () => ({
    topUsername: undefined,
    pings: 0,
    topRegion: undefined,
    topRegionPings: 0,
  }));

  // Quick bucket of pings
  for (const { ts, username, region } of rec.pings) {
    if (ts < startMs || ts >= startMs + count * binMs) continue;
    const idx = Math.floor((ts - startMs) / binMs);
    const m = meta[idx];
    m.pings += 1;
    if (username) {
      m._u = m._u || {};
      m._u[username] = (m._u[username] || 0) + 1;
    }
    if (region) {
      m._r = m._r || {};
      m._r[region] = (m._r[region] || 0) + 1;
    }
  }
  // finalize meta tops
  for (const m of meta) {
    if (m._u) {
      let bestU = '', bestC = -1;
      for (const [u, c] of Object.entries(m._u)) if (c > bestC) { bestC = c; bestU = u; }
      m.topUsername = bestU || undefined;
    }
    if (m._r) {
      let bestR = '', bestC = -1;
      for (const [r, c] of Object.entries(m._r)) if (c > bestC) { bestC = c; bestR = r; }
      m.topRegion = bestR || undefined;
      m.topRegionPings = bestC > 0 ? bestC : 0;
    }
    delete m._u; delete m._r;
  }

  // Build the compact binary string
  const bins = active.map(v => (v ? '1' : '0')).join('');
  return { bins, meta };
}

// -------------------- API: overlay activity ---------
/**
 * Batch activity for ids
 * POST /api/overlay/activity/batch?window=1h|1d|1w|1m&tzOffsetMin=XXX
 * body: { ids: string[] }
 * response: { ok:true, startMs, binMs, data: { [id]: "010101..." }, meta: { [id]: [ {topUsername,pings,topRegion,topRegionPings}, ...] } }
 */
app.post('/api/overlay/activity/batch', (req, res) => {
  try {
    const winKey = (req.query.window || '1h').toString();
    const spec = WINDOWS[winKey] || WINDOWS['1h'];
    const tzOffsetMin = Number(req.query.tzOffsetMin || 0);

    let ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    ids = ids.filter(id => typeof id === 'string' && id.length > 0);
    if (ids.length > BATCH_CAP) ids = ids.slice(0, BATCH_CAP);

    const now = Date.now();
    const startMs = alignWindowStart(now, spec.binMs, spec.count, tzOffsetMin);

    const data = {};
    const meta = {};

    for (const id of ids) {
      const { bins, meta: m } = buildBinsForId(id, startMs, spec.binMs, spec.count);
      data[id] = bins;
      meta[id] = m;
    }

    res.json({ ok: true, startMs, binMs: spec.binMs, data, meta });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Optional ingestion endpoint if you want to push snapshots from elsewhere.
 * Accepts the exact snapshot you pasted earlier.
 */
app.post('/api/overlay/activity/ingest', (req, res) => {
  try {
    const body = req.body || {};
    const serverId = body.serverId || body.server || 'us-1';
    const region = parseRegionFromServerKey(serverId);
    const ts = Number(body.timestamp) || Date.now();
    const players = Array.isArray(body.players) ? body.players : [];
    for (const p of players) {
      const id  = p.privyId || p.id || p.playerId;
      const mv  = Number(p.monetaryValue ?? p.value ?? p.money ?? 0);
      const name = p.name || p.username || p.playerName || '';
      if (!id || !(mv > 0)) continue;
      addPing({ id, ts, username: name, region });
    }
    res.json({ ok: true, added: players.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------- minimal stubs (keep old routes working) ----
app.get('/api/user/mapping', (req, res) => {
  res.json({ players: {} });
});

app.get('/api/user/alerts', (req, res) => {
  res.json({ alerts: [] });
});

// Simple leaderboard proxy so your core continues to work if needed.
app.get('/api/game/leaderboard', async (req, res) => {
  try {
    const serverKey = req.query.serverKey || 'us-1';
    const players = await fetchPlayers(serverKey);
    const entries = players
      .map((p, i) => ({
        name: p.name || p.username || p.playerName || '#' + (i + 1),
        privyId: p.privyId || p.id || p.playerId,
        monetaryValue: Number(p.monetaryValue ?? p.value ?? p.money ?? 0),
        size: Number(p.size ?? p.snakeSize ?? p.length ?? 0),
      }))
      .filter(e => e.monetaryValue > 0 && e.size > 2);
    res.json({ entries });
  } catch (e) {
    res.status(500).json({ entries: [] });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

app.listen(PORT, () => {
  console.log('server listening on', PORT, 'servers=', SERVERS.join(','));
});
