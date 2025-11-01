// --- server.js (ESM) ---------------------------------------------------------
// This file is compatible with `"type": "module"` in package.json.
// It polls the 6 game shards on the backend, caches leaderboards, and exposes
// read-only endpoints. It also maintains usernames.json (per-privy per-name
// counts + a Region tag) and saves every 15 seconds.
//
// Key behaviors (per your specs):
// - Poll shards every 5s: us-1, us-5, us-20, eu-1, eu-5, eu-20
// - Leaderboard includes only players with monetaryValue > 2
// - Client NEVER calls the game's /players directly
// - usernames.json schema per privyId:
//     {
//       "realName": "<manual only>",
//       "Region": "US" | "EU",
//       "usernames": { "<seenName>": <count>, ... }
//     }
// - Save usernames.json every 15s. While waiting, keep polling/caching so
//   you accumulate counts between writes.
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';

// ---- ESM __dirname shim ----------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---- Config ----------------------------------------------------------------
const SHARDS = ['us-1','us-5','us-20','eu-1','eu-5','eu-20'];
const SAVE_INTERVAL_MS = 15_000; // save usernames.json every 15s
const POLL_INTERVAL_MS = 5_000;  // poll all shards every 5s
const USERNAMES_PATH = path.join(__dirname, 'data', 'usernames.json'); // adjust if needed

// Ensure data dir exists
try { fs.mkdirSync(path.dirname(USERNAMES_PATH), { recursive: true }); } catch {}

// ---- Helpers ---------------------------------------------------------------
function toGamePlayersUrl(serverKey) {
  const [region, num] = serverKey.split('-');
  return `https://damnbruh-game-server-instance-${num}-${region}.onrender.com/players`;
}

function regionFromKey(serverKey) {
  return serverKey.startsWith('us-') ? 'US' : 'EU';
}

function now() { return Date.now(); }

// ---- State -----------------------------------------------------------------
/** @type {Record<string, { updatedAt: number, players: any[], top: any[] }>} */
const shardCache = Object.fromEntries(
  SHARDS.map(k => [k, { updatedAt: 0, players: [], top: [] }])
);

/** usernamesStore layout:
 * {
 *   [privyId]: {
 *     realName?: string,     // manual only, never auto-write here
 *     Region: "US"|"EU",
 *     usernames: { [name: string]: number }
 *   }
 * }
 */
let usernamesStore = {};

function loadUsernames() {
  try {
    const raw = fs.readFileSync(USERNAMES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') usernamesStore = parsed;
  } catch (err) {
    usernamesStore = {};
  }
}

function saveUsernames() {
  try {
    fs.writeFileSync(USERNAMES_PATH, JSON.stringify(usernamesStore, null, 2));
  } catch (err) {
    console.error('[usernames] save failed:', err?.message || err);
  }
}

loadUsernames();

// ---- Polling ---------------------------------------------------------------
async function pollShard(serverKey) {
  const url = toGamePlayersUrl(serverKey);
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.players)) return;

    const players = data.players;
    const updatedAt = now();

    // Build top[] filtered and sorted
    const top = players
      .filter(p => typeof p.monetaryValue === 'number' && p.monetaryValue > 2)
      .sort((a,b) => b.monetaryValue - a.monetaryValue)
      .map((p, idx) => ({
        privyId: p.privyId || p.id || '',
        name: p.name || '',
        size: p.size || 0,
        monetaryValue: p.monetaryValue || 0,
        rank: idx + 1
      }));

    shardCache[serverKey] = { updatedAt, players, top };

    // Update usernamesStore: per-name tick + single Region tag
    const region = regionFromKey(serverKey);
    for (const p of players) {
      const privyId = p.privyId || p.id;
      const name = p.name || '';
      if (!privyId || !name) continue;

      const rec = usernamesStore[privyId] || {
        // realName is manual only — do NOT set here
        Region: region,
        usernames: {}
      };

      // Keep a single Region tag; overwrite to reflect current shard if needed
      rec.Region = region;

      // Tick this observed display name (no global pings count)
      rec.usernames[name] = (rec.usernames[name] || 0) + 1;

      usernamesStore[privyId] = rec;
    }
  } catch (err) {
    console.error(`[poll ${serverKey}]`, err?.message || err);
  }
}

function startPollers() {
  setInterval(async () => {
    for (const key of SHARDS) {
      // Fire without awaiting each to cover all shards within the window
      pollShard(key);
    }
  }, POLL_INTERVAL_MS);

  setInterval(() => {
    saveUsernames();
  }, SAVE_INTERVAL_MS);
}

startPollers();

// ---- Express app -----------------------------------------------------------
const app = express();

// (Optional) CORS for clients hosted elsewhere
try {
  const cors = (await import('cors')).default;
  app.use(cors());
} catch { /* if cors not installed, ignore */ }

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: now() }));

function validateServerKey(key) {
  return SHARDS.includes(key);
}

// GET /api/game/leaderboard?serverKey=us-1
app.get('/api/game/leaderboard', (req, res) => {
  const serverKey = (req.query.serverKey || '').toString();
  if (!validateServerKey(serverKey)) {
    return res.status(400).json({ ok: false, error: 'invalid_serverKey' });
  }
  const snap = shardCache[serverKey] || { updatedAt: 0, top: [] };
  const age = now() - (snap.updatedAt || 0);
  const stale = age > 8_000;
  res.json({
    ok: true,
    serverKey,
    updatedAt: snap.updatedAt || 0,
    stale,
    entries: snap.top || []
  });
});

// GET /api/game/usernames?serverKey=us-1
app.get('/api/game/usernames', (req, res) => {
  const serverKey = (req.query.serverKey || '').toString();
  if (!validateServerKey(serverKey)) {
    return res.status(400).json({ ok: false, error: 'invalid_serverKey' });
  }
  res.json({ ok: true, serverKey, updatedAt: now(), usernames: usernamesStore });
});

// ---- Listen (Render expects you to listen) ---------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
