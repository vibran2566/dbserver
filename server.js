import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";


// Paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- App config ----------
const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_FILE_PATH = process.env.GITHUB_FILE_PATH || "keys.json";           // size system
const USERKEYS_FILE_PATH = process.env.USERKEYS_FILE_PATH || "userkeys.json";   // username system keys
const USERNAMES_FILE_PATH = process.env.USERNAMES_FILE_PATH || "usernames.json";// username data
app.use(express.static(__dirname));


// ---------- Middleware ----------
app.use(morgan("tiny"));
app.use(express.json({ limit: "256kb" }));
app.use(cors());
// app.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));



const DATA_DIR = "/data"; // persistent path on Render
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

const USER_FILE = "/data/usernames.json";

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

// Example API
app.get("/api/user/mapping", async (req, res) => {
  try {
    let data = {};
    if (fs.existsSync(USER_FILE)) {
      data = JSON.parse(fs.readFileSync(USER_FILE, "utf8"));
    } else {
      const { data: ghData } = await ghLoad(USERNAMES_FILE_PATH, { players: {} });
      data = ghData;
    }

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
      };
    }

    res.json({ ok: true, players: out });
  } catch (err) {
    console.error("mapping:", err);
    res.status(500).json({ ok: false, error: "read_failed" });
  }
});



// 🕐 username join queue
const usernameQueue = new Map(); // privyId -> { name, count }

// add to queue instead of writing immediately
function queueUsernameJoin(privyId, name) {
  if (!privyId || !name) return;
  const prev = usernameQueue.get(privyId) || { name, count: 0 };
  usernameQueue.set(privyId, { name, count: prev.count + 1 });
}

// flush queued joins to GitHub every 2 min 30 sec
setInterval(async () => {
  if (usernameQueue.size === 0) return;
  console.log(`🕓 Flushing ${usernameQueue.size} queued username joins...`);
  try {
    const { data, sha } = await ghLoad(USERNAMES_FILE_PATH, { players: {} });
    if (!data.players) data.players = {};

    for (const [privyId, info] of usernameQueue.entries()) {
      const { name, count } = info;
      if (!data.players[privyId])
        data.players[privyId] = { realName: null, usernames: {} };
      const user = data.players[privyId];
      user.usernames[name] = (user.usernames[name] || 0) + count;
    }

    await ghSave(USERNAMES_FILE_PATH, data, sha);
    usernameQueue.clear();
    console.log("✅ Username queue flushed");
  } catch (err) {
    console.error("❌ Username flush failed:", err);
  }
}, 200000); // 


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


// 🕐 store incoming joins temporarily
const joinQueue = new Map(); // privyId -> latest {name, count}

function queueJoin(privyId, name) {
  if (!privyId || !name) return;
  const prev = joinQueue.get(privyId) || { name, count: 0 };
  joinQueue.set(privyId, { name, count: prev.count + 1 });
}

// 🧱 your /trackJoin route stays the same except call queueJoin instead of writing immediately
app.post("/api/user/trackJoin", (req, res) => {
  const { privyId, name } = req.body || {};
  if (!privyId || !name)
    return res.status(400).json({ ok: false, error: "missing_fields" });

  try {
    let data = {};
    if (fs.existsSync(USER_FILE)) {
      data = JSON.parse(fs.readFileSync(USER_FILE, "utf8") || "{}");
    } else {
      data = { players: {} };
    }

    if (!data.players) data.players = {};
    if (!data.players[privyId])
      data.players[privyId] = { realName: null, usernames: {} };

    const u = data.players[privyId];
    u.usernames[name] = (u.usernames[name] || 0) + 1;

    fs.writeFileSync(USER_FILE, JSON.stringify(data, null, 2));
    res.json({ ok: true });
  } catch (err) {
    console.error("trackJoin:", err);
    res.status(500).json({ ok: false, error: "write_failed" });
  }
});


// 🕓 flush queued joins every 2 min 30 sec
setInterval(async () => {
  if (joinQueue.size === 0) return;
  console.log(`Flushing ${joinQueue.size} queued joins…`);
  try {
    const { data, sha } = await loadKeys(); // same GitHub JSON load helper
    for (const [privyId, info] of joinQueue.entries()) {
      const { name, count } = info;
      const player = data.players?.[privyId] || { names: {} };
      player.names[name] = (player.names[name] || 0) + count;
      data.players[privyId] = player;
    }
    await saveKeys(data, sha);
    joinQueue.clear();
    console.log("✅ Flushed joins successfully");
  } catch (err) {
    console.error("❌ Flush failed:", err);
  }
}, 150000); // 2 min 30 sec = 150000 ms



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
app.post("/api/admin/add-note", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok:false, error:"unauthorized" });

  const { key, note } = req.body || {};
  if (!key || typeof note !== "string")
    return res.status(400).json({ ok:false, error:"missing_fields" });

  try {
    const { data, sha } = await ghLoad(GITHUB_FILE_PATH, { keys: [] });
    const found = data.keys.find(k => k.key === key);
    if (!found) return res.status(404).json({ ok:false, error:"not_found" });

    found.note = note.trim();
    await ghSave(GITHUB_FILE_PATH, data, sha);
    res.json({ ok:true, message:`Note added to ${key}` });
  } catch (err) {
    console.error("add-note:", err);
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

app.post("/api/validate", (req, res) => {
  const { key, proof } = req.body || {};
  if (!key) return res.status(400).json({ ok:false, error:"missing_key" });

  const FILE = "/data/keys.json";

  try {
    const data = fs.existsSync(FILE)
      ? JSON.parse(fs.readFileSync(FILE, "utf8"))
      : { keys: [] };

    const found = data.keys.find(k => k.key === key);
    if (!found) return res.status(404).json({ ok:false, error:"not_found" });
    if (found.revoked) return res.status(403).json({ ok:false, error:"revoked" });

    // 🔹 record validation time
    found.lastValidatedAt = new Date().toISOString();
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

    if (!found.used)
      return res.status(200).json({ ok:true, usable:true, used:false });

    if (found.boundProof && proof && proof === found.boundProof)
      return res.status(200).json({ ok:true, valid:true, bound:true, used:true });

    return res.status(409).json({ ok:false, used:true, error:"bound_mismatch" });
  } catch (err) {
    console.error("validate:", err);
    res.status(500).json({ ok:false, error:"read_failed" });
  }
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

  try {
    const { data, sha } = await ghLoad(USERNAMES_FILE_PATH, { players:{} });
    if (!data.players[privyId])
      return res.status(404).json({ ok:false, error:"not_found" });

    delete data.players[privyId];
    await ghSave(USERNAMES_FILE_PATH, data, sha);
    res.json({ ok:true, message:`Deleted ${privyId}` });
  } catch (err) {
    console.error("delete-player:", err);
    res.status(500).json({ ok:false, error:"write_failed" });
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

app.post("/api/user/validate", (req, res) => {
  const { key, proof } = req.body || {};
  if (!key) return res.status(400).json({ ok:false, error:"missing_key" });

  const FILE = "/data/userkeys.json";

  try {
    const data = fs.existsSync(FILE)
      ? JSON.parse(fs.readFileSync(FILE, "utf8"))
      : { keys: [] };

    const found = data.keys.find(k => k.key === key);
    if (!found) return res.status(404).json({ ok:false, error:"not_found" });
    if (found.revoked) return res.status(403).json({ ok:false, error:"revoked" });

    found.lastValidatedAt = new Date().toISOString();
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

    if (!found.used)
      return res.status(200).json({ ok:true, usable:true, used:false });

    if (found.boundProof && proof && proof === found.boundProof)
      return res.status(200).json({ ok:true, valid:true, bound:true, used:true });

    return res.status(409).json({ ok:false, used:true, error:"bound_mismatch" });
  } catch (err) {
    console.error("user-validate:", err);
    res.status(500).json({ ok:false, error:"read_failed" });
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

// ---------- username tracking ----------
app.post("/api/user/trackJoin", async (req,res)=>{
  const {privyId,name}=req.body||{};
  if(!privyId||!name)return res.status(400).json({ok:false,error:"missing_fields"});
   if (name.trim().toLowerCase() === "anonymous player") {
    return res.status(200).json({ ok:true, skipped:true, reason:"default_anonymous" });
  }
  try{
    const {data,sha}=await ghLoad(USERNAMES_FILE_PATH,{players:{}});
    if(!data.players)data.players={};
    if(!data.players[privyId])data.players[privyId]={realName:null,usernames:{}};
    const u=data.players[privyId];
    u.usernames[name]=(u.usernames[name]||0)+1;
    await ghSave(USERNAMES_FILE_PATH,data,sha);
    res.json({ok:true});
  }catch(err){console.error("trackJoin:",err);res.status(500).json({ok:false,error:"write_failed"});}
});

app.get("/api/user/mapping", async (req,res)=>{
  try{
    const {data}=await ghLoad(USERNAMES_FILE_PATH,{players:{}});
    const out={};
    for(const [id,obj] of Object.entries(data.players||{})){
      const top=Object.entries(obj.usernames||{})
        .sort((a,b)=>b[1]-a[1])
        .slice(0,3)
        .map(([n,c])=>({name:n,count:c}));
      out[id]={realName:obj.realName||null,topUsernames:top,allUsernames:obj.usernames||{}};
    }
    res.json({ok:true,players:out});
  }catch(err){console.error("mapping:",err);res.status(500).json({ok:false,error:"read_failed"});}
});


app.post("/api/user/batchTrackJoin", (req, res) => {
  const { players } = req.body || {};
  if (!Array.isArray(players))
    return res.status(400).json({ ok: false, error: "missing_players" });

  try {
    let data = {};
    if (fs.existsSync(USER_FILE)) {
      data = JSON.parse(fs.readFileSync(USER_FILE, "utf8") || "{}");
    } else {
      data = { players: {} };
    }

    if (!data.players) data.players = {};

    for (const { privyId, name, count } of players) {
      if (!privyId || !name) continue;
      if (name.trim().toLowerCase() === "anonymous player") continue;
      if (!data.players[privyId])
        data.players[privyId] = { realName: null, usernames: {} };
      const u = data.players[privyId];
      u.usernames[name] = (u.usernames[name] || 0) + (count || 1);
    }

    fs.writeFileSync(USER_FILE, JSON.stringify(data, null, 2));
    res.json({ ok: true, added: players.length });
  } catch (err) {
    console.error("batchTrackJoin:", err);
    res.status(500).json({ ok: false, error: "write_failed" });
  }
});


/* =======================================================
   ================== Default & Start ====================
   ======================================================= */

app.get("/", (req,res)=>
  res.send("✅ Combined License + Username Tracker Active")
);

app.listen(PORT, ()=> console.log(`✅ Combined server running on :${PORT}`));
