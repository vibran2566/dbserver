// --- server.js (drop-in replacement or merge) -------------------------------
// Purpose: Poll game shards on the backend, cache leaderboards, and expose
// read-only endpoints for clients. Also maintain usernames.json (per-privy
// per-name counts + a Region tag), saving every 15 seconds.
//
// Notes based on user requirements:
// - Poll these 6 shards every 5s: us-1, us-5, us-20, eu-1, eu-5, eu-20
// - Leaderboard includes only players with monetaryValue > 2
// - Client NEVER calls the game /players directly anymore
// - usernames.json schema (per privyId):
//     {
//       "realName": "<manual only, do NOT auto-update here>",
//       "Region": "US" | "EU",
//       "usernames": { "<seenName>": <count>, ... }
//     }
// - Save usernames.json every 15s. While waiting, continue polling and
//   accumulating in memory so we never lose interim counts.
//
// Merge guidance:
// 1) Keep your existing Express app/server listen, auth, etc.
// 2) Paste this whole block near the top-level of server.js (after you create `app`)
// 3) If you already have body parser, CORS, etc., keep them.
// 4) Ensure Node 18+ (global fetch). If not, `npm i node-fetch` and import it.
//
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const express = require('express'); // If already imported, you can remove this line.

// ---- Config ----------------------------------------------------------------
const SHARDS = ['us-1','us-5','us-20','eu-1','eu-5','eu-20'];
const SAVE_INTERVAL_MS = 15_000; // save usernames.json every 15s
const POLL_INTERVAL_MS = 5_000;  // poll all shards every 5s
const USERNAMES_PATH = path.join(__dirname, 'data', 'usernames.json'); // adjust if needed

// Optional: create data dir if missing
try { fs.mkdirSync(path.dirname(USERNAMES_PATH), { recursive: true }); } catch {}

// ---- Helpers ---------------------------------------------------------------
function toGamePlayersUrl(serverKey) {
  // serverKey like "us-1" or "eu-5"
  const [region, num] = serverKey.split('-');
  // Game uses "damnbruh-game-server-instance-<num>-<region>.onrender.com/players"
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
    // fresh start if file missing or invalid
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

    // Update shard cache
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

    // Update usernamesStore (per-name counts, plus Region tag)
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

      // Keep Region as a single tag; overwrite with latest seen region if desired
      // (User allowed a simple Region tag; overwrite keeps it current)
      rec.Region = region;

      // Tick this observed display name
      rec.usernames[name] = (rec.usernames[name] || 0) + 1;

      usernamesStore[privyId] = rec;
    }
  } catch (err) {
    console.error(`[poll ${serverKey}]`, err?.message || err);
  }
}

function startPollers() {
  // One interval that loops shards every POLL_INTERVAL_MS
  setInterval(async () => {
    for (const key of SHARDS) {
      // fire-and-forget to avoid serial slowdown; you may also await sequentially
      pollShard(key);
    }
  }, POLL_INTERVAL_MS);

  // Separate saver for usernames.json every 15s
  setInterval(() => {
    saveUsernames();
  }, SAVE_INTERVAL_MS);
}

startPollers();

// ---- Express routes --------------------------------------------------------
// attach to your existing app; if you already have `app`, reuse it.
const app = (global.__APP__) || express(); // if you have an app elsewhere, replace this line

// Validate serverKey against whitelist
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
  const stale = age > 8_000; // about one and a half poll cycles
  res.json({
    ok: true,
    serverKey,
    updatedAt: snap.updatedAt || 0,
    stale,
    entries: snap.top || []
  });
});

// GET /api/game/usernames?serverKey=us-1
// Optionally, you could filter by serverKey (e.g., only ids present in shardCache[serverKey].players)
// but user asked to keep existing shape; we'll return the whole store for compatibility.
app.get('/api/game/usernames', (req, res) => {
  const serverKey = (req.query.serverKey || '').toString();
  if (!validateServerKey(serverKey)) {
    return res.status(400).json({ ok: false, error: 'invalid_serverKey' });
  }
  res.json({ ok: true, serverKey, updatedAt: now(), usernames: usernamesStore });
});

// If this file is your entrypoint, uncomment to listen
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

module.exports = app; // If you import into an existing server, export the app or attach routes accordingly.
