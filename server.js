import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";              // sync APIs
import { promises as fsp } from "fs";
import crypto from "crypto";

// === Local disk usernames store (disk-only) ================================
const DATA_DIR = process.env.DATA_DIR || "/data";
fs.mkdirSync(DATA_DIR, { recursive: true });
const USER_FILE = path.join(DATA_DIR, "usernames.json");
const XP_FILE = path.join(DATA_DIR, "client-xp.json");
const XP_LOG_ENDPOINT = "https://dbserver-8bhx.onrender.com/api/user/client-xp";
const DASHBOARD_USER = process.env.DASHUSER || "";
const DASHBOARD_PASS = process.env.DASHPASS || "";

// Basic auth for dashboard
function requireDashboardAuth(req, res, next) {
  const header = req.headers["authorization"] || "";
  const [scheme, encoded] = header.split(" ");

  const sendAuth = () => {
    res.setHeader("WWW-Authenticate", 'Basic realm="DamnBruh Dashboard"');
    return res.status(401).send("Authentication required");
  };

  if (scheme !== "Basic" || !encoded) {
    return sendAuth();
  }

  let user = "";
  let pass = "";
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx === -1) return sendAuth();
    user = decoded.slice(0, idx);
    pass = decoded.slice(idx + 1);
  } catch {
    return sendAuth();
  }

  if (!DASHBOARD_USER || !DASHBOARD_PASS) {
    console.error("DASHUSER / DASHPASS not set in env");
    return res.status(500).send("Dashboard credentials not configured");
  }

  if (user !== DASHBOARD_USER || pass !== DASHBOARD_PASS) {
    return sendAuth();
  }

  // ok
  return next();
}
function loadUserKeys() {
  try {
    if (!fs.existsSync(USERKEYS_FILE_PATH)) {
      return { keys: [] };
    }
    const raw = fs.readFileSync(USERKEYS_FILE_PATH, "utf8");
    if (!raw.trim()) return { keys: [] };
    const data = JSON.parse(raw);
    if (!Array.isArray(data.keys)) data.keys = [];
    return data;
  } catch (e) {
    console.error("[userkeys load]", e);
    return { keys: [] };
  }
}

function requireUsernameKey(req, res, next) {
  const auth = String(req.headers["authorization"] || "");
  if (!auth.startsWith("Bearer ")) {
    return res.status(404).end(); // hide details
  }

  const key = auth.slice("Bearer ".length).trim();
  if (!key) return res.status(404).end();

  const data = loadUserKeys();
  const list = Array.isArray(data.keys) ? data.keys : [];
  const found = list.find(k => k.key === key && !k.revoked);

  if (!found) return res.status(404).end();

  // optional: stash it if you need the record later
  req.userKey = key;
  req.userLicense = found;
  return next();
}


function loadXpStore(fallback = {}) {
  try {
    if (fs.existsSync(XP_FILE)) {
      return JSON.parse(fs.readFileSync(XP_FILE, "utf8"));
    }
  } catch (e) {
    console.error("[xp load]", e?.message || e);
  }
  return fallback;
}

function saveXpStore(obj) {
  try {
    fs.writeFileSync(XP_FILE, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    console.error("[xp save]", e?.message || e);
    return false;
  }
}

const __filename = fileURLToPath(import.meta.url);
const INACTIVITY_MS = 3 * 60 * 1000;            // 3 minutes
const RETAIN_MS     = 31 * 24 * 60 * 60 * 1000; // ~31 days

function trimOld(p, now){
  const cutoff = now - RETAIN_MS;
  p.sessions = (p.sessions||[]).filter(s => (s.end ?? s.start) >= cutoff);
  p.pings    = (p.pings   || []).filter(x => x.ts >= cutoff);
}


function alignWindowStart(now, binMs, count, tzOffsetMin){
  const off = (tzOffsetMin|0) * 60 * 1000;
  const localNow = now - off;
  const alignedRight = Math.floor(localNow / binMs) * binMs;
  const startLocal = alignedRight - (count - 1) * binMs;
  return startLocal + off;
}
const app  = express();
const jsonBody = express.json({ limit: "256kb" });






// XP cache + flush state
let xpCache = {};
let xpInitialized = false;
let xpDirty = false;


function flushXpStore() {
  if (!xpDirty) return;
  try {
    fs.writeFileSync(XP_FILE, JSON.stringify(xpCache, null, 2));
    xpDirty = false;
    // console.log("[xp] flushed to disk");
  } catch (e) {
    console.error("[xp save]", e?.message || e);
  }
}

// flush every 60s
setInterval(flushXpStore, 60 * 1000);
// Paths + app config  (MOVE THIS UP)

const __dirname  = path.dirname(__filename);


const PORT = process.env.PORT || 3000;

const ADMIN_TOKEN          = process.env.ADMIN_TOKEN || "";
const GITHUB_TOKEN         = process.env.GITHUB_TOKEN;
const GITHUB_REPO          = process.env.GITHUB_REPO;
const GITHUB_FILE_PATH     = process.env.GITHUB_FILE_PATH     || "keys.json";
const USERKEYS_FILE_PATH   = process.env.USERKEYS_FILE_PATH   || "userkeys.json";
const USERNAMES_FILE_PATH = path.join(DATA_DIR, "usernames.json");


// --- Core version + meta helpers ---
const CORE_PATH = path.join(__dirname, "core.js");
let ACTIVE_VERSION = process.env.ACTIVE_VERSION || "1.1.1"; // default
function sha256Hex(s){ return crypto.createHash('sha256').update(s,'utf8').digest('hex'); }
// In-memory state
let __JOIN_BUFFER__ = [];                   // events queued between flushes
let __USERNAME_MAPPING__ = { players: {}, updatedAt: 0 };
let __IS_FLUSHING__ = false;



function readCoreBytes() {
  const code = fs.readFileSync(CORE_PATH, "utf8");
  return code;
}

app.use(morgan("tiny"));
app.use(express.json({ limit: "256kb" }));
app.use(cors());
// app.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));
function fileSha256Hex(p) {
  const buf = fs.readFileSync(p);               // exact bytes you will send
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// --- write /version.json so /api/user/core/meta reflects the bump ---
async function writeVersionJSON(v) {
  const payload = { version: String(v), bumpedAt: new Date().toISOString() };
  fs.writeFileSync(VERSION_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

// --- sync the version onto every app key record in both key files ---
async function syncCoreVersionAcrossKeys(newVersion) {
  const files = [GITHUB_FILE_PATH, USERKEYS_FILE_PATH]; // size keys + username keys
  for (const FILE of files) {
    const { data, sha } = await ghLoad(FILE, { keys: [] });
    let changed = false;

    // set whichever field name you actually use in your admin panel
    const FIELDS = ["coreVersion", "requiredCore", "version"];
    for (const k of (data.keys || [])) {
      for (const f of FIELDS) {
        if (k[f] !== newVersion) { k[f] = newVersion; changed = true; }
      }
    }

    if (changed) await ghSave(FILE, data, sha);
  }
}

// === DamnBruh shard polling & usernames (ADD) ===============================
// Poll these 6 shards every 5s (server-side only; client never hits /players)
const DB_SHARDS = ['us-1','us-5','us-20','eu-1','eu-5','eu-20'];

// Per-shard cache: { updatedAt, players[], top[] }
const dbShardCache = Object.fromEntries(
  DB_SHARDS.map(k => [k, { updatedAt: 0, players: [], top: [] }])
);

function dbToGamePlayersUrl(serverKey) {
  const [region, num] = serverKey.split('-'); // "us-1" -> ["us","1"]
  return `https://damnbruh-game-server-instance-${num}-${region}.onrender.com/players`;
}
function dbRegion(serverKey) { return serverKey.startsWith('us-') ? 'US' : 'EU'; }
function nowMs() { return Date.now(); }

// --- Activity timeline helpers ---
function ensureActivityPlayer(privyId) {
  if (!__USERNAME_MAPPING__.players[privyId]) {
    __USERNAME_MAPPING__.players[privyId] = {
      realName: undefined,
      usernames: {},
      topUsernames: [],
      regionCounts: { US:0, EU:0 },
      topRegion: null,
      firstSeen: Date.now(),
      lastSeen: 0,
      sessions: [],  // NEW
      pings: []      // NEW
    };
  }
  const p = __USERNAME_MAPPING__.players[privyId];
  if (!Array.isArray(p.sessions)) p.sessions = [];
  if (!Array.isArray(p.pings))    p.pings    = [];
  return p;
}
function trimOldSessions(p) {
  const cutoff = nowMs() - RETAIN_MS;
  p.sessions = (p.sessions||[]).filter(s => (s.end ?? s.start) >= cutoff);
}
function recordActivity(privyId, now, joinTime) {
  const p = ensureActivityPlayer(privyId);
  const last = p.sessions[p.sessions.length - 1];
  const firstTimeSeen = !last && !p.lastSeenActivity;
  const startMs = (firstTimeSeen && Number.isFinite(joinTime)) ? Number(joinTime) : now;
  if (!last) {
    p.sessions.push({ start: startMs, end: now });
  } else if ((now - p.lastSeenActivity) > INACTIVITY_MS) {
    p.sessions.push({ start: Math.min(startMs, now), end: now });
  } else {
    last.end = now;
  }
  compactTailSessions(p);
  trimOldSessions(p);
  p.lastSeenActivity = now;
}

function recordPing(privyId, username, region, ts){
  const p = ensureActivityPlayer(privyId);
  const t = Number(ts) || Date.now();
  trimOld(p, t);
  if (!Array.isArray(p.pings)) p.pings = [];
  p.pings.push({
    ts: t,
    username: typeof username === 'string' ? username.slice(0,48) : '',
    region: typeof region === 'string' ? region : undefined
  });
}


function compactTailSessions(p){
  if (!p || !Array.isArray(p.sessions) || p.sessions.length < 2) return;

  const a = p.sessions;
  const n = a.length;
  const A = a[n - 2];
  const B = a[n - 1];

  const Aend   = Number(A.end ?? A.start);
  const Bstart = Number(B.start);
  const Bend   = Number(B.end ?? B.start);
  if (!Number.isFinite(Aend) || !Number.isFinite(Bstart) || !Number.isFinite(Bend)) return;

  // Merge if the gap between A and B is less than INACTIVITY_MS
  if ((Bstart - Aend) < INACTIVITY_MS) {
    A.end = Math.max(Aend, Bend);
    a.pop();
  }
}



// Binning
const WINDOW_SPECS = {
  '1h': { binMs:  5 * 60 * 1000, count: 12 },
  '1d': { binMs: 60 * 60 * 1000, count: 24 },
  '1w': { binMs: 12 * 60 * 60 * 1000, count: 14 },
  '1m': { binMs: 24 * 60 * 60 * 1000, count: 30 },
};



function makeBinsAndMeta(p, windowKey, tzOffsetMin){
  const spec = WINDOW_SPECS[windowKey] || WINDOW_SPECS["1h"];
  const now = Date.now();
  const startMs = alignWindowStart(now, spec.binMs, spec.count, tzOffsetMin);
  const endMs = startMs + spec.count * spec.binMs;

  // sessions → on/off bins
  const bins = new Uint8Array(spec.count);
  const sessions = Array.isArray(p.sessions) ? p.sessions : [];
  for (const s of sessions) {
    const a = Math.max(s.start, startMs);
    const b = Math.min((s.end ?? s.start), endMs);
    if (b <= a) continue;
    let i = Math.max(0, Math.floor((a - startMs) / spec.binMs));
    let j = Math.min(spec.count - 1, Math.floor((b - 1 - startMs) / spec.binMs));
    for (let k=i;k<=j;k++) bins[k] = 1;
  }

  // pings → meta per bin
  const meta = Array.from({ length: spec.count }, () => ({
    topUsername: undefined,
    pings: 0,
    topRegion: undefined,
    topRegionPings: 0,
  }));
  const pings = Array.isArray(p.pings) ? p.pings : [];
  for (const x of pings) {
    if (x.ts < startMs || x.ts >= endMs) continue;
    const idx = Math.floor((x.ts - startMs) / spec.binMs);
    const m = meta[idx];
    m.pings += 1;
    if (x.username){ m._u = m._u || {}; m._u[x.username] = (m._u[x.username] || 0) + 1; }
    if (x.region){   m._r = m._r || {}; m._r[x.region]   = (m._r[x.region]   || 0) + 1; }
  }
  for (const m of meta) {
    if (m._u){ let bu="",bc=-1; for (const [u,c] of Object.entries(m._u)) if (c>bc){ bc=c; bu=u; } m.topUsername = bu || undefined; delete m._u; }
    if (m._r){ let br="",bc=-1; for (const [r,c] of Object.entries(m._r)) if (c>bc){ bc=c; br=r; } m.topRegion = br || undefined; m.topRegionPings = Math.max(0,bc); delete m._r; }
  }

  return { startMs, binMs: spec.binMs, bins: Array.from(bins).join(""), meta };
}



// Load usernames file to memory (compatible with your existing schema)


async function dbPollShard(serverKey) {
  try {
    const rsp = await fetch(dbToGamePlayersUrl(serverKey), { method: 'GET' });
    if (!rsp.ok) throw new Error(`HTTP ${rsp.status}`);

    const data = await rsp.json();

    // ✅ handle both shapes: top-level array OR { players: [...] }
    const playersRaw = Array.isArray(data) ? data
                      : (Array.isArray(data.players) ? data.players : []);

    // ✅ your spec: keep real DIDs, non-anon names, size > 2
    const filtered = playersRaw.filter(p => {
      const did  = typeof p?.privyId === 'string' && p.privyId.startsWith('did:privy:');
      const name = (p?.name || '').trim();
      const size = Number(p?.size) || 0;
      return did && name && !/^anonymous player$/i.test(name) && size > 2;
    });

    // ✅ your spec: monetaryValue > 0, sort high → low
    const top = filtered
      .filter(p => (Number(p?.monetaryValue) || 0) > 0)
      .sort((a, b) => (Number(b?.monetaryValue) || 0) - (Number(a?.monetaryValue) || 0))
      
      .map((p, i) => ({
    privyId: p.privyId,
    name: (p.name || '').trim(),
    size: Number(p.size) || 0,
    monetaryValue: Number(p.monetaryValue) || 0,
    joinTime: Number(p.joinTime) || undefined,
    rank: i + 1
  }));
// record session + a ping for mv>0 players
// record session + a ping for mv>0 players
// record session + a ping for mv>0 players
const ts = Date.now();
const region = dbRegion(serverKey); // "US" or "EU"
for (const p of top) {
  recordActivity(p.privyId, ts, p.joinTime);
  recordPing(p.privyId, p.name, region, ts);
}

// feed usernames mapping so icons / admin panel have data
for (const p of filtered) {
  const id   = p.privyId;
  const name = (p.name || '').trim();
  if (id && name && !/^anonymous player$/i.test(name)) {
    recordUsername({
      privyId:  id,
      username: name,
      realName: null,
      region
    });
  }
}





    // ✅ keep filtered (for debugging) and top (for clients)
    dbShardCache[serverKey] = {
      updatedAt: Date.now(),
      players: filtered,
      top
    };
  } catch (e) {
    console.error('[poll]', serverKey, e?.message || e);
  }
}


// Poll all shards every 5s (fire-and-forget)
setInterval(() => { DB_SHARDS.forEach(dbPollShard); }, 5000);



await fsp.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
try {
  const raw = await fsp.readFile(USERNAMES_FILE_PATH, "utf8");
  const j = JSON.parse(raw);
  if (j && typeof j === "object") {
    const players = (j.players && typeof j.players === "object") ? j.players : {};
    __USERNAME_MAPPING__.players   = players;
    __USERNAME_MAPPING__.updatedAt = j.updatedAt || Date.now();
  }
} catch (e) {
  if (e && e.code === "ENOENT") {
    // Truly first boot: create an empty file
    await fsp.writeFile(
      USERNAMES_FILE_PATH,
      JSON.stringify(__USERNAME_MAPPING__, null, 2)
    );
  } else {
    console.error("[usernames load] NOT resetting file; JSON is invalid or unreadable:", e);
    // optional: copy to backup here if you want
    // await fsp.copyFile(USERNAMES_FILE_PATH, USERNAMES_FILE_PATH + ".bak");
  }
}

// Backfill region fields for old records (idempotent)
for (const p of Object.values(__USERNAME_MAPPING__.players || {})) {
  if (!p.regionCounts) p.regionCounts = { US: 0, EU: 0 };
  const us = Number(p.regionCounts.US || 0);
  const eu = Number(p.regionCounts.EU || 0);
  p.topRegion = (us >= eu) ? 'US' : 'EU';
}

// Record a single username event into in-memory map
function recordUsername({ privyId, username, realName, region }) {
  if (!privyId || !username) return;

  const id  = String(privyId);
  const nm  = String(username).slice(0, 48);
  const rnm = realName ? String(realName).slice(0, 64) : null;

  if (!__USERNAME_MAPPING__.players[id]) {
    __USERNAME_MAPPING__.players[id] = {
      realName: rnm || undefined,
      usernames: {},
      topUsernames: [],
      regionCounts: { US: 0, EU: 0 }, // NEW
      topRegion: null,                // NEW
      firstSeen: Date.now(),
      lastSeen: 0,
    };
  }
  const p = __USERNAME_MAPPING__.players[id];

  if (rnm) p.realName = rnm;

  // username counts
  p.usernames[nm] = (p.usernames[nm] || 0) + 1;

  // region counts (only US/EU accepted)
  if (!p.regionCounts) p.regionCounts = { US: 0, EU: 0 };
  if (region === 'US' || region === 'EU') {
    p.regionCounts[region] = (p.regionCounts[region] || 0) + 1;
  }

  // compute topRegion on every write (ties → US by default)
  const us = Number(p.regionCounts.US || 0);
  const eu = Number(p.regionCounts.EU || 0);
  p.topRegion = (us >= eu) ? 'US' : 'EU';

  // top 3 usernames cache
  p.topUsernames = Object.entries(p.usernames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));

  p.lastSeen = Date.now();
}


// Flush buffer to disk atomically
async function flushUsernamesNow() {
  if (__IS_FLUSHING__) return false;
  __IS_FLUSHING__ = true;
  try {
    if (__JOIN_BUFFER__.length) {
      for (const evt of __JOIN_BUFFER__) recordUsername(evt);
      __JOIN_BUFFER__ = [];
    }
    __USERNAME_MAPPING__.updatedAt = Date.now();

    const tmp = USERNAMES_FILE_PATH + ".tmp";
    const json = JSON.stringify(__USERNAME_MAPPING__, null, 2);
    await fsp.writeFile(tmp, json);
    await fsp.rename(tmp, USERNAMES_FILE_PATH);   // atomic swap
    return true;
  } finally { __IS_FLUSHING__ = false; }
}

// Schedule 15s periodic flush
setInterval(flushUsernamesNow, 15000); // not 15_000


// === Read-only endpoints (client consumes these) ============================
// GET /api/game/leaderboard?serverKey=us-1
app.get('/api/game/leaderboard', requireUsernameKey, (req, res) => {
  const serverKey = String(req.query.serverKey || '');
  if (!DB_SHARDS.includes(serverKey)) return res.status(400).json({ ok:false, error:'invalid_serverKey' });
  const snap = dbShardCache[serverKey] || { updatedAt:0, top:[] };
  const stale = nowMs() - (snap.updatedAt || 0) > 8000;
  res.json({ ok:true, serverKey, updatedAt: snap.updatedAt || 0, stale, entries: snap.top || [] });
});
// GET /api/overlay/activity
app.get("/api/overlay/activity", requireUsernameKey, (req, res) => {
  try {
    const privyId     = String(req.query.privyId || "");
    const windowKey   = String(req.query.window || "1h");
    const tzOffsetMin = Number(req.query.tzOffsetMin || 0);
    const spec        = WINDOW_SPECS[windowKey] || WINDOW_SPECS["1h"];
    const p           = __USERNAME_MAPPING__.players[privyId];
    const startMs     = alignWindowStart(Date.now(), spec.binMs, spec.count, tzOffsetMin);

    if (!p) {
      return res.json({ ok:true, privyId, window:windowKey, startMs, binMs:spec.binMs,
                        bins: "".padStart(spec.count, "0"),
                        meta: Array.from({length:spec.count}, ()=>({})) });
    }
    const out = makeBinsAndMeta(p, windowKey, tzOffsetMin);
    res.json({ ok:true, privyId, window:windowKey, ...out });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});


// POST /api/overlay/activity/batch
app.post("/api/overlay/activity/batch", requireUsernameKey, express.json(), (req, res) => {
  try {
    const body = req.body || {};
    let ids = Array.isArray(body.ids) ? body.ids : [];
    ids = ids.filter(x => typeof x === "string" && x.length > 0).slice(0, 50);

    const windowKey   = String(req.query.window || body.window || "1h");
    const tzOffsetMin = Number(req.query.tzOffsetMin || body.tzOffsetMin || 0);
    const spec = WINDOW_SPECS[windowKey] || WINDOW_SPECS["1h"];

    const data = {};
    const meta = {};
    for (const id of ids) {
      const p = __USERNAME_MAPPING__.players[id];
      if (!p) {
        data[id] = "".padStart(spec.count, "0");
        meta[id] = Array.from({ length: spec.count }, () => ({}));
      } else {
        const out = makeBinsAndMeta(p, windowKey, tzOffsetMin);
        data[id] = out.bins;
        meta[id] = out.meta;
      }
    }
    const startMs = alignWindowStart(Date.now(), spec.binMs, spec.count, tzOffsetMin);
    res.json({ ok:true, window:windowKey, startMs, binMs: spec.binMs, data, meta });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || String(e) });
  }
});



// GET /api/game/usernames?serverKey=us-1
// Protected usernames list — requires Authorization: Bearer <username_key>
// GET /api/game/usernames?serverKey=us-1
// Protected usernames list — requires Authorization: Bearer <username_key>
app.get("/api/game/usernames", requireUsernameKey, (req, res) => {
  try {
    const serverKey = String(req.query.serverKey || "");
    if (!DB_SHARDS.includes(serverKey)) {
      return res.status(404).json({ ok: false, error: "invalid_serverKey" });
    }

    const players =
      __USERNAME_MAPPING__.players && typeof __USERNAME_MAPPING__.players === "object"
        ? __USERNAME_MAPPING__.players
        : {};

    return res.json({
      ok: true,
      serverKey,
      updatedAt: __USERNAME_MAPPING__.updatedAt || nowMs(),
      usernames: { players },
    });
  } catch (err) {
    console.error("/api/game/usernames:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});



// Paths


// ---------- App config ----------

// app.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));




const MAPPING_FILE = path.join(DATA_DIR, "mapping.json");

let mapping = { players: {} };
function timeAgo(isoDate) {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins !== 1 ? "s" : ""} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? "s" : ""} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days !== 1 ? "s" : ""} ago`;
}



// Load mapping on startup
try {
  if (fs.existsSync(MAPPING_FILE)) {
    mapping = JSON.parse(fs.readFileSync(MAPPING_FILE, "utf-8"));
    console.log("✅ Loaded mapping from disk");
  } else {
    console.log("🆕 No mapping file found — starting fresh");
  }
} catch (e) {
  console.error("❌ Failed to load mapping:", e);
}


app.post("/api/user/admin/set-name", express.json(), async (req, res) => {
  try {
    const { did, name } = req.body || {};
    if (!did || !did.startsWith("did:privy:") || !name) {
      return res.status(400).json({ ok:false, error:"invalid_input" });
    }
    const clean = String(name).trim().slice(0, 64);

    // ensure player exists in the in-memory map
    const p = (__USERNAME_MAPPING__.players[did] ||= {
      realName: null,
      usernames: {},
      topUsernames: [],
      firstSeen: Date.now(),
      lastSeen: 0
    });

    p.realName = clean;
    __USERNAME_MAPPING__.updatedAt = Date.now();

    // persist immediately so the file and memory match
    await flushUsernamesNow();

    res.json({ ok:true, did, realName: p.realName });
  } catch (e) {
    console.error("set-name:", e);
    res.status(500).json({ ok:false, error:"flush_failed" });
  }
});

// Save periodically (every 60s)
setInterval(() => {
  try {
    fs.writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2));
  } catch (e) {
    console.error("❌ Failed to save mapping:", e);
  }
}, 60000);

// Disk-only mapping (single source of truth)
app.get("/api/user/mapping", requireUsernameKey, (req, res) => {
  res.json(__USERNAME_MAPPING__);
});
app.get("/api/user/core/download", requireUsernameKey, (req, res) => {
  try {
    if (!fs.existsSync(CORE_PATH)) return res.status(404).json({ ok:false, error:"core_missing" });
    const etag = fileSha256Hex(CORE_PATH);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.setHeader("ETag", etag);
    res.sendFile(CORE_PATH);
  } catch (err) {
    console.error("download:", err);
    res.status(500).json({ ok:false, error:"download_failed" });
  }
});
app.post("/api/user/client-xp", requireUsernameKey, jsonBody, (req, res) => {
  try {
    const { key, headers, endpoint } = req.body || {};

    if (typeof key !== "string" || !key.startsWith("KEY-")) {
      return res.status(400).json({ ok: false, error: "invalid_key" });
    }

    const store = loadXpStore({});
    const now = new Date().toISOString();

    const existing = (store[key] && typeof store[key] === "object") ? store[key] : {};
    const entry = {
      lastused: now,
      headers: existing.headers || {},
      endpoints: Array.isArray(existing.endpoints) ? existing.endpoints.slice() : []
    };

    // If XP headers were sent, update them
    if (headers && typeof headers === "object") {
      entry.headers = headers;
    }

    // If an endpoint string was sent, add it (POST/PUT only, handled on client)
    if (typeof endpoint === "string" && endpoint.length) {
      if (!entry.endpoints.includes(endpoint)) {
        entry.endpoints.push(endpoint);
      }
    }

    store[key] = entry;
    saveXpStore(store);

    return res.json({ ok: true });
  } catch (err) {
    console.error("client-xp:", err);
    return res.status(500).json({ ok: false, error: "xp_save_failed" });
  }
});

app.get("/api/user/admin/client-xp", (req, res) => {
  const hdr = req.headers["admin-token"];
  if (hdr !== ADMIN_TOKEN) {
    return res.status(403).json({ ok: false, error: "unauthorized" });
  }

  const store = loadXpStore({});
  return res.json(store);
});
app.post("/api/user/admin/client-xp/delete", jsonBody, (req, res) => {
  const hdr = req.headers["admin-token"];
  if (hdr !== ADMIN_TOKEN) {
    return res.status(403).json({ ok: false, error: "unauthorized" });
  }

  const { key } = req.body || {};
  if (typeof key !== "string" || !key.startsWith("KEY-")) {
    return res.status(400).json({ ok: false, error: "invalid_key" });
  }

  const store = loadXpStore({});
  if (!store[key]) {
    return res.json({ ok: true, note: "no entry for key" });
  }

  // 🔥 Only wipe headers, keep key + endpoints + lastused
  store[key].headers = {};
  // optional: update lastused timestamp for “header clear” action
  store[key].lastused = new Date().toISOString();

  saveXpStore(store);
  return res.json({ ok: true });
});



app.post("/api/user/record", requireUsernameKey, jsonBody, (req, res) => {
  const body = req.body || {};
  const arr = Array.isArray(body)
    ? body
    : Array.isArray(body.events)
    ? body.events
    : [body];

  let queued = 0;
  for (const e of arr) {
    if (!e) continue;
    const privyId = e.privyId || e.id || e.playerId;
    const username = e.username || e.name;
    const realName = e.realName;
    if (privyId && username) {
      __JOIN_BUFFER__.push({ privyId, username, realName });
      queued++;
    }
  }
  res.json({ ok: true, queued });
});

const VERSION_PATH = path.join(__dirname, "version.json");


app.get("/api/user/core/meta", requireUsernameKey, (req, res) => {
  try {
    const sha256 = fileSha256Hex(CORE_PATH);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.json({ ok: true, activeVersion: ACTIVE_VERSION, sha256 });
  } catch (err) {
    console.error("meta:", err);
    res.status(500).json({ ok: false, error: "meta_read_failed" });
  }
});


app.post("/api/user/admin/flush-now", jsonBody, async (req, res) => {
  const token = req.header("x-admin-token");
  if (token !== (process.env.ADMIN_TOKEN || "vibran2566")) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  try {
    const ok = await flushUsernamesNow();
    res.json({ ok: true, flushed: !!ok, updatedAt: __USERNAME_MAPPING__.updatedAt });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});
// 🕐 username join queue
app.get("/api/user/debug/state", requireUsernameKey, async (req, res) => {
  try {
    let size = 0, mtime = null;
    try {
      const st = await fsp.stat(USERNAMES_FILE_PATH);
      size = st.size; mtime = st.mtime;
    } catch {}
    res.json({
      bufferQueued: __JOIN_BUFFER__.length,
      mappingCount: Object.keys(__USERNAME_MAPPING__.players || {}).length,
      updatedAt: __USERNAME_MAPPING__.updatedAt || null,
      file: { path: USERNAMES_FILE_PATH, size, mtime }
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});
// flush queued joins to GitHub every 2 min 30 sec


// ---------- GitHub helpers ----------
async function ghLoad(filePath, fallback = {}) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    if (res.status === 404) return { data: fallback, sha: null };
    throw new Error(`GitHub read failed: ${res.status}`);
  }
  const json = await res.json();
  const content = Buffer.from(json.content, "base64").toString();
  let data;
  try { data = JSON.parse(content); } catch { data = fallback; }
  return { data, sha: json.sha };
}

async function ghSave(filePath, data, sha) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`;
  const body = {
    message: `Update ${filePath} via combined server`,
    content: Buffer.from(JSON.stringify(data, null, 2)).toString("base64"),
    sha: sha || undefined,
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub push failed (${res.status})`);
}

function genKey() {
  return "KEY-" + Math.random().toString(36).substring(2, 10).toUpperCase();
}







// 🕓 flush queued joins every 2 min 30 sec


/* =======================================================
   =============== SIZE SYSTEM (default) ==================
   ======================================================= */

// list / add / revoke / validate / register
app.get("/api/admin/list-keys", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const { data } = await ghLoad(GITHUB_FILE_PATH, { keys: [] });
    res.json(data);
  } catch (err) {
    console.error("list-keys:", err);
    res.status(500).json({ ok: false, error: "read_failed" });
  }
});
app.post("/api/admin/delete-key", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok:false, error:"unauthorized" });

  const { key } = req.body || {};
  if (!key) return res.status(400).json({ ok:false, error:"missing_key" });

  try {
    const { data, sha } = await ghLoad(GITHUB_FILE_PATH, { keys: [] });
    const before = data.keys.length;
    data.keys = data.keys.filter(k => k.key !== key);
    await ghSave(GITHUB_FILE_PATH, data, sha);
    res.json({ ok:true, removed: before - data.keys.length });
  } catch (err) {
    console.error("delete-key:", err);
    res.status(500).json({ ok:false, error:"write_failed" });
  }
});
// 🔔 Admin-only broadcast alert
app.post("/api/admin/alert", async (req, res) => {
  const { target, key, message } = req.body || {};

  // ✅ Require admin token
  const adminToken = req.headers["admin-token"];
  if (adminToken !== ADMIN_TOKEN)
    return res.status(403).json({ ok: false, error: "unauthorized" });

  if (!message)
    return res.status(400).json({ ok: false, error: "missing_message" });

  const FILE = "/data/alerts.json";
  const alertObj = {
    id: Date.now(),
    target, // "all" or "key"
    key,
    message,
    createdAt: new Date().toISOString(),
  };

  let alerts = [];
  try {
    if (fs.existsSync(FILE)) alerts = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (err) {
    console.error("Failed to load alerts.json:", err);
  }

  alerts.push(alertObj);

  try {
    fs.writeFileSync(FILE, JSON.stringify(alerts, null, 2));
    res.json({ ok: true, alert: alertObj });
  } catch (err) {
    console.error("Failed to save alert:", err);
    res.status(500).json({ ok: false, error: "save_failed" });
  }
});
// Admin: cleanup usernames in-memory and persist to /data
// Admin: hard reset usernames mapping and persist to /data
app.post('/api/user/admin/cleanup-now', async (req, res) => {
  if (req.header('admin-token') !== ADMIN_TOKEN) {
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }

  try {
    // wipe all players
    __USERNAME_MAPPING__.players = {};
    __USERNAME_MAPPING__.updatedAt = Date.now();

    // write a fresh, empty usernames.json to /data
    await flushUsernamesNow();

    res.json({ ok:true, stats:{ cleared:true, total:0 } });
  } catch (e) {
    console.error('cleanup-now:', e);
    res.status(500).json({ ok:false, error:String(e) });
  }
});


app.post("/api/admin/unuse-key", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok:false, error:"unauthorized" });

  const { key } = req.body || {};
  if (!key) return res.status(400).json({ ok:false, error:"missing_key" });

  try {
    const { data, sha } = await ghLoad(GITHUB_FILE_PATH, { keys: [] });
    const found = data.keys.find(k => k.key === key);
    if (!found) return res.status(404).json({ ok:false, error:"not_found" });

    found.used = false;
    delete found.usedAt;
    delete found.boundProof;

    await ghSave(GITHUB_FILE_PATH, data, sha);
    res.json({ ok:true, message:`${key} reset to unused` });
  } catch (err) {
    console.error("unuse-key:", err);
    res.status(500).json({ ok:false, error:"write_failed" });
  }
});

app.post("/api/admin/add-keys", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });
  const count = req.body.count || 1;
  try {
    const { data, sha } = await ghLoad(GITHUB_FILE_PATH, { keys: [] });
    for (let i = 0; i < count; i++) {
      data.keys.push({
        key: genKey(),
        used: false,
        revoked: false,
        createdAt: new Date().toISOString(),
      });
    }
    await ghSave(GITHUB_FILE_PATH, data, sha);
    res.json({ ok: true, added: count });
  } catch (err) {
    console.error("add-keys:", err);
    res.status(500).json({ ok: false, error: "write_failed" });
  }
});

app.post("/api/admin/revoke", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });
  const { key } = req.body;
  if (!key) return res.status(400).json({ ok: false, error: "missing_key" });
  try {
    const { data, sha } = await ghLoad(GITHUB_FILE_PATH, { keys: [] });
    const found = data.keys.find(k => k.key === key);
    if (!found) return res.status(404).json({ ok: false, error: "not_found" });
    found.revoked = true;
    await ghSave(GITHUB_FILE_PATH, data, sha);
    res.json({ ok: true });
  } catch (err) {
    console.error("revoke:", err);
    res.status(500).json({ ok: false, error: "write_failed" });
  }
});

app.post("/api/validate", async (req, res) => {
  const { key, proof } = req.body || {};
  if (!key)
    return res.status(400).json({ ok: false, error: "missing_key" });

  try {
    const { data, sha } = await ghLoad(GITHUB_FILE_PATH, { keys: [] });
    const found = data.keys.find(k => k.key === key);

    if (!found)
      return res.status(404).json({ ok: false, error: "not_found" });
    if (found.revoked)
      return res.status(403).json({ ok: false, error: "revoked" });

    if (!found.used)
      return res.status(200).json({ ok: true, usable: true, used: false });

    if (found.boundProof && proof && proof === found.boundProof) {
      // ✅ Add lastUsedAt and save using the correct sha
      try {
        found.lastUsedAt = new Date().toISOString();
        await ghSave(GITHUB_FILE_PATH, data, sha); // now includes sha
      } catch (err) {
        console.error("Failed to update lastUsedAt:", err);
      }

      return res.status(200).json({ ok: true, valid: true, bound: true, used: true });
    }

    return res.status(409).json({ ok: false, used: true, error: "bound_mismatch" });

  } catch (err) {
    console.error("validate:", err);
    res.status(500).json({ ok: false, error: "read_failed" });
  }
});
// === Core update endpoints ===

// Serve current version


app.get("/api/core/version", requireUsernameKey, (req, res) => {
  res.json({ version: ACTIVE_VERSION });
});

app.post("/api/core/bump", (req, res) => {
  // auth: choose one. If you want x-admin-token:
  const hdr = req.headers["x-admin-token"];
  if (hdr !== ADMIN_TOKEN) return res.status(403).json({ error: "unauthorized" });

  const { version } = req.body || {};
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    return res.status(400).json({ error: "invalid version format (x.y.z)" });
  }
  // must be higher
  const toNum = v => v.split(".").map(Number);
  const [a,b,c] = toNum(ACTIVE_VERSION);
  const [x,y,z] = toNum(version);
  const newer = x>a || (x===a && (y>b || (y===b && z>c)));
  if (!newer) return res.status(400).json({ error: "version must be higher than current" });

  ACTIVE_VERSION = version;
  console.log(`✅ CORE activeVersion -> ${ACTIVE_VERSION}`);
  res.json({ ok:true, activeVersion: ACTIVE_VERSION });
});





app.post("/api/register", async (req, res) => {
  const { key, proof } = req.body || {};
  if (!key) return res.status(400).json({ ok:false, error:"missing_key" });
  if (!proof) return res.status(400).json({ ok:false, error:"missing_proof" });
  try {
    const { data, sha } = await ghLoad(GITHUB_FILE_PATH, { keys: [] });
    const found = data.keys.find(k => k.key === key);
    if (!found) return res.status(404).json({ ok:false, error:"not_found" });
    if (found.revoked) return res.status(403).json({ ok:false, error:"revoked" });
    if (found.used) {
      if (found.boundProof && proof === found.boundProof)
        return res.json({ ok:true, used:true, bound:true, already:true });
      return res.status(409).json({ ok:false, used:true, error:"already_used" });
    }
    found.used = true;
    found.usedAt = new Date().toISOString();
    found.boundProof = String(proof);
    await ghSave(GITHUB_FILE_PATH, data, sha);
    res.json({ ok:true, used:true, bound:true });
  } catch (err) {
    console.error("register:", err);
    res.status(500).json({ ok:false, error:"write_failed" });
  }
});

/* =======================================================
   =============== USERNAME SYSTEM (new) =================
   ======================================================= */

// license routes: same behavior but prefixed /api/user/*
app.get("/api/user/admin/list-keys", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok:false, error:"unauthorized" });
  try {
    const { data } = await ghLoad(USERKEYS_FILE_PATH, { keys: [] });
    res.json(data);
  } catch (err) {
    console.error("user-list:", err);
    res.status(500).json({ ok:false, error:"read_failed" });
  }
});
app.post("/api/admin/add-note", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });

  const { key, note } = req.body || {};
  if (!key || typeof note !== "string")
    return res.status(400).json({ ok: false, error: "missing_fields" });

  try {
    const { data, sha } = await ghLoad(GITHUB_FILE_PATH, { keys: [] });
    const found = data.keys.find(k => k.key === key);
    if (!found)
      return res.status(404).json({ ok: false, error: "not_found" });

    found.note = note.trim();
    await ghSave(GITHUB_FILE_PATH, data, sha);
    res.json({ ok: true, message: `Note added to ${key}` });
  } catch (err) {
    console.error("add-note:", err);
    res.status(500).json({ ok: false, error: "write_failed" });
  }
});


app.post("/api/user/admin/add-keys", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok:false, error:"unauthorized" });
  const count = req.body.count || 1;
  try {
    const { data, sha } = await ghLoad(USERKEYS_FILE_PATH, { keys: [] });
    for (let i=0;i<count;i++){
      data.keys.push({ key:genKey(), used:false, revoked:false, createdAt:new Date().toISOString() });
    }
    await ghSave(USERKEYS_FILE_PATH, data, sha);
    res.json({ ok:true, added:count });
  } catch(err){ console.error("user-add:",err); res.status(500).json({ok:false,error:"write_failed"}); }
});
app.post("/api/user/admin/delete-key", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok:false, error:"unauthorized" });

  const { key } = req.body || {};
  if (!key) return res.status(400).json({ ok:false, error:"missing_key" });

  try {
    const { data, sha } = await ghLoad(USERKEYS_FILE_PATH, { keys: [] });
    const before = data.keys.length;
    data.keys = data.keys.filter(k => k.key !== key);
    await ghSave(USERKEYS_FILE_PATH, data, sha);
    res.json({ ok:true, removed: before - data.keys.length });
  } catch (err) {
    console.error("user-delete-key:", err);
    res.status(500).json({ ok:false, error:"write_failed" });
  }
});
app.post("/api/user/admin/unuse-key", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok:false, error:"unauthorized" });

  const { key } = req.body || {};
  if (!key) return res.status(400).json({ ok:false, error:"missing_key" });

  try {
    const { data, sha } = await ghLoad(USERKEYS_FILE_PATH, { keys: [] });
    const found = data.keys.find(k => k.key === key);
    if (!found) return res.status(404).json({ ok:false, error:"not_found" });

    found.used = false;
    delete found.usedAt;
    delete found.boundProof;

    await ghSave(USERKEYS_FILE_PATH, data, sha);
    res.json({ ok:true, message:`${key} reset to unused` });
  } catch (err) {
    console.error("user-unuse-key:", err);
    res.status(500).json({ ok:false, error:"write_failed" });
  }
});
app.post("/api/user/admin/add-note", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok:false, error:"unauthorized" });

  const { key, note } = req.body || {};
  if (!key || typeof note !== "string")
    return res.status(400).json({ ok:false, error:"missing_fields" });

  try {
    const { data, sha } = await ghLoad(USERKEYS_FILE_PATH, { keys: [] });
    const found = data.keys.find(k => k.key === key);
    if (!found) return res.status(404).json({ ok:false, error:"not_found" });

    found.note = note.trim();
    await ghSave(USERKEYS_FILE_PATH, data, sha);
    res.json({ ok:true, message:`Note added to ${key}` });
  } catch (err) {
    console.error("user-add-note:", err);
    res.status(500).json({ ok:false, error:"write_failed" });
  }
});
app.post("/api/user/admin/delete-player", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok:false, error:"unauthorized" });

  const { privyId } = req.body || {};
  if (!privyId) return res.status(400).json({ ok:false, error:"missing_privyId" });

  const players = (__USERNAME_MAPPING__.players && typeof __USERNAME_MAPPING__.players === "object")
    ? __USERNAME_MAPPING__.players
    : (__USERNAME_MAPPING__.players = {});

  if (!players[privyId])
    return res.status(404).json({ ok:false, error:"not_found" });

  delete players[privyId];
  __USERNAME_MAPPING__.updatedAt = Date.now();

  try {
    await flushUsernamesNow();
    res.json({ ok:true, message:`Deleted ${privyId}` });
  } catch (e) {
    console.error("[admin delete-player] flush failed", e);
    res.status(500).json({ ok:false, error:"flush_failed" });
  }
});


app.post("/api/user/admin/revoke", async (req,res)=>{
  if (req.header("admin-token")!==ADMIN_TOKEN)
    return res.status(401).json({ok:false,error:"unauthorized"});
  const {key}=req.body;
  if(!key)return res.status(400).json({ok:false,error:"missing_key"});
  try{
    const {data,sha}=await ghLoad(USERKEYS_FILE_PATH,{keys:[]});
    const found=data.keys.find(k=>k.key===key);
    if(!found)return res.status(404).json({ok:false,error:"not_found"});
    found.revoked=true;
    await ghSave(USERKEYS_FILE_PATH,data,sha);
    res.json({ok:true});
  }catch(err){console.error("user-revoke:",err);res.status(500).json({ok:false,error:"write_failed"});}
});

app.post("/api/user/validate", async (req, res) => {
  const { key, proof } = req.body || {};
  if (!key)
    return res.status(400).json({ ok: false, error: "missing_key" });

  try {
    const { data, sha } = await ghLoad(USERKEYS_FILE_PATH, { keys: [] });
    const found = data.keys.find(k => k.key === key);

    if (!found)
      return res.status(404).json({ ok: false, error: "not_found" });
    if (found.revoked)
      return res.status(403).json({ ok: false, error: "revoked" });

    if (!found.used)
      return res.status(200).json({ ok: true, usable: true, used: false });

    if (found.boundProof && proof && proof === found.boundProof) {
      // ✅ same logic: update lastUsedAt and save
      try {
        found.lastUsedAt = new Date().toISOString();
        await ghSave(USERKEYS_FILE_PATH, data, sha);
      } catch (err) {
        console.error("Failed to update lastUsedAt (user):", err);
      }

      return res.status(200).json({ ok: true, valid: true, bound: true, used: true });
    }

    return res.status(409).json({ ok: false, used: true, error: "bound_mismatch" });

  } catch (err) {
    console.error("user-validate:", err);
    res.status(500).json({ ok: false, error: "read_failed" });
  }
});


app.post("/api/user/register", async (req,res)=>{
  const {key,proof}=req.body||{};
  if(!key)return res.status(400).json({ok:false,error:"missing_key"});
  if(!proof)return res.status(400).json({ok:false,error:"missing_proof"});
  try{
    const {data,sha}=await ghLoad(USERKEYS_FILE_PATH,{keys:[]});
    const f=data.keys.find(k=>k.key===key);
    if(!f)return res.status(404).json({ok:false,error:"not_found"});
    if(f.revoked)return res.status(403).json({ok:false,error:"revoked"});
    if(f.used){
      if(f.boundProof&&proof===f.boundProof)
        return res.json({ok:true,used:true,bound:true,already:true});
      return res.status(409).json({ok:false,used:true,error:"already_used"});
    }
    f.used=true; f.usedAt=new Date().toISOString(); f.boundProof=String(proof);
    await ghSave(USERKEYS_FILE_PATH,data,sha);
    res.json({ok:true,used:true,bound:true});
  }catch(err){console.error("user-register:",err);res.status(500).json({ok:false,error:"write_failed"});}
});
app.get("/api/user/alerts", async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ ok:false, error:"missing_key" });

  try {
    const alerts = JSON.parse(fs.readFileSync("/data/alerts.json", "utf8"));
    const visible = alerts.filter(a => a.target === "all" || (a.target === "key" && a.key === key));
    res.json({ ok:true, alerts: visible });
  } catch (e) {
    console.error("alerts:", e);
    res.status(500).json({ ok:false, alerts: [] });
  }
});

// ---------- username tracking ----------







/* =======================================================
   ================== Default & Start ====================
   ======================================================= */

app.get("/", (req,res)=>
  res.send("✅ Combined License + Username Tracker Active")
);

// Admin dashboard page (protected)
app.get("/dashboard.html", requireDashboardAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});


app.get("/dashboard", requireDashboardAuth, (req, res) => {
  res.redirect("/dashboard.html");
});

app.listen(PORT, ()=> console.log(`✅ Combined server running on :${PORT}`));
