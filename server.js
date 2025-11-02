import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import crypto from "crypto";

// === Local disk usernames store (disk-only) ================================
const DATA_DIR = "/data";
fs.mkdirSync(DATA_DIR, { recursive: true });
const USER_FILE = path.join(DATA_DIR, "usernames.json");

function loadUserFile(fallback = { players: {} }) {
  try {
    if (fs.existsSync(USER_FILE)) {
      return JSON.parse(fs.readFileSync(USER_FILE, "utf8"));
    }
  } catch (e) {
    console.error("[usernames load]", e?.message || e);
  }
  return fallback;
}
function saveUserFile(obj) {
  try {
    fs.writeFileSync(USER_FILE, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    console.error("[usernames save]", e?.message || e);
    return false;
  }
}
// Paths + app config  (MOVE THIS UP)
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;

const ADMIN_TOKEN          = process.env.ADMIN_TOKEN || "";
const GITHUB_TOKEN         = process.env.GITHUB_TOKEN;
const GITHUB_REPO          = process.env.GITHUB_REPO;
const GITHUB_FILE_PATH     = process.env.GITHUB_FILE_PATH     || "keys.json";
const USERKEYS_FILE_PATH   = process.env.USERKEYS_FILE_PATH   || "userkeys.json";
const USERNAMES_FILE_PATH  = process.env.USERNAMES_FILE_PATH  || "usernames.json";


// --- Core version + meta helpers ---
const CORE_PATH = path.join(__dirname, "core.js");
let ACTIVE_VERSION = process.env.ACTIVE_VERSION || "1.1.1"; // default
function sha256Hex(s){ return crypto.createHash('sha256').update(s,'utf8').digest('hex'); }


function readCoreBytes() {
  const code = fs.readFileSync(CORE_PATH, "utf8");
  return code;
}

app.use(express.static(__dirname));
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

// Load usernames file to memory (compatible with your existing schema)
let dbUsernamesMem = loadUserFile();
let dbDirty = false;

async function dbPollShard(serverKey) {
  try {
    const rsp = await fetch(dbToGamePlayersUrl(serverKey), { method: 'GET' });
    if (!rsp.ok) throw new Error(`HTTP ${rsp.status}`);
    const data = await rsp.json();
    const players = Array.isArray(data.players) ? data.players : [];

    // Keep only real DIDs, non-anon names, size > 1
    const filtered = players.filter(p => {
      const did  = typeof p?.privyId === 'string' && p.privyId.startsWith('did:privy:');
      const name = (p?.name || '').trim();
      const size = typeof p?.size === 'number' ? p.size : 0;
      return did && size > 3 && name && !/^anonymous player$/i.test(name);
    });

    // Leaderboard: require monetaryValue > 2, sort desc by monetaryValue
    const top = filtered
      .filter(p => typeof p.monetaryValue === 'number' && p.monetaryValue > 2)
      .sort((a, b) => (b.monetaryValue || 0) - (a.monetaryValue || 0))
      .map((p, i) => ({
        privyId: p.privyId,
        name: p.name.trim(),
        size: p.size,
        monetaryValue: p.monetaryValue,   // included for ordering/display
        rank: i + 1
      }));

    dbShardCache[serverKey] = { updatedAt: Date.now(), players: [], top };

    // Username ticks (persist DID + name + Region only)
    const region = serverKey.startsWith('us-') ? 'US' : 'EU';
    if (!dbUsernamesMem.players) dbUsernamesMem.players = {};
    for (const pl of filtered) {
      const did  = pl.privyId;
      const name = pl.name.trim();
      if (!dbUsernamesMem.players[did]) {
        dbUsernamesMem.players[did] = { realName: null, Region: region, usernames: {} };
      }
      const rec = dbUsernamesMem.players[did];
      rec.Region = region;                                 // single tag (US | EU)
      rec.usernames[name] = (rec.usernames[name] || 0) + 1;
    }

    dbDirty = true;
  } catch (e) {
    console.error('[poll]', serverKey, e?.message || e);
  }
}

// Poll all shards every 5s (fire-and-forget)
setInterval(() => { DB_SHARDS.forEach(dbPollShard); }, 5000);

// Persist usernames every 15s; keep polling/caching between writes
setInterval(() => {
  if (!dbDirty) return;
  if (saveUserFile(dbUsernamesMem)) dbDirty = false;
}, 15000);

// === Read-only endpoints (client consumes these) ============================
// GET /api/game/leaderboard?serverKey=us-1
app.get('/api/game/leaderboard', (req, res) => {
  const serverKey = String(req.query.serverKey || '');
  if (!DB_SHARDS.includes(serverKey)) return res.status(400).json({ ok:false, error:'invalid_serverKey' });
  const snap = dbShardCache[serverKey] || { updatedAt:0, top:[] };
  const stale = nowMs() - (snap.updatedAt || 0) > 8000;
  res.json({ ok:true, serverKey, updatedAt: snap.updatedAt || 0, stale, entries: snap.top || [] });
});

// GET /api/game/usernames?serverKey=us-1
app.get('/api/game/usernames', (req, res) => {
  const serverKey = String(req.query.serverKey || '');
  if (!DB_SHARDS.includes(serverKey)) return res.status(400).json({ ok:false, error:'invalid_serverKey' });
  res.json({ ok:true, serverKey, updatedAt: nowMs(), usernames: dbUsernamesMem });
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


app.post("/api/user/admin/set-name", (req, res) => {
  const { did, name } = req.body;
  if (!did?.startsWith("did:privy:") || !name) {
    return res.status(400).json({ message: "Invalid DID or name" });
  }

  try {
    let data = {};
    if (fs.existsSync(USER_FILE)) {
      data = JSON.parse(fs.readFileSync(USER_FILE, "utf8") || "{}");
    }

    // ensure top-level structure
    if (!data.players) data.players = {};

    // ensure player object exists
    if (!data.players[did])
      data.players[did] = { realName: null, usernames: {} };

    // update real name
    data.players[did].realName = name;

    fs.writeFileSync(USER_FILE, JSON.stringify(data, null, 2));
    res.json({ ok: true, message: `✅ Set ${did} → ${name}` });
  } catch (err) {
    console.error("set-name error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
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
app.get("/api/user/mapping", (req, res) => {
  try {
    const data = loadUserFile(); // reads /data/usernames.json
    const out = {};
    for (const [id, obj] of Object.entries(data.players || {})) {
      const top = Object.entries(obj.usernames || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([n, c]) => ({ name: n, count: c }));
      out[id] = {
        realName: obj.realName || null,
        topUsernames: top,
        allUsernames: obj.usernames || {},
        Region: obj.Region || null
      };
    }
    res.json({ ok: true, players: out });
  } catch (err) {
    console.error("mapping:", err);
    res.status(500).json({ ok: false, error: "read_failed" });
  }
});
app.get("/api/user/core/download", (req, res) => {
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


const VERSION_PATH = path.join(__dirname, "version.json");


app.get("/api/user/core/meta", (req, res) => {
  try {
    const sha256 = fileSha256Hex(CORE_PATH);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.json({ ok: true, activeVersion: ACTIVE_VERSION, sha256 });
  } catch (err) {
    console.error("meta:", err);
    res.status(500).json({ ok: false, error: "meta_read_failed" });
  }
});



// 🕐 username join queue

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


app.get("/api/core/version", (req, res) => {
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
app.post("/api/user/admin/delete-player", (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok:false, error:"unauthorized" });

  const { privyId } = req.body || {};
  if (!privyId) return res.status(400).json({ ok:false, error:"missing_privyId" });

  const data = loadUserFile();
  if (!data.players || !data.players[privyId])
    return res.status(404).json({ ok:false, error:"not_found" });

  delete data.players[privyId];
  saveUserFile(data);
  res.json({ ok:true, message:`Deleted ${privyId}` });
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

app.listen(PORT, ()=> console.log(`✅ Combined server running on :${PORT}`));
