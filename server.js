import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

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

// ---------- Middleware ----------
app.use(morgan("tiny"));
app.use(express.json({ limit: "256kb" }));
app.use(cors());
app.use(rateLimit({ windowMs: 60 * 1000, max: 30 }));

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
  if (!privyId || !name) return res.status(400).json({ ok: false, error: "missing_fields" });
  queueJoin(privyId, name);
  res.json({ ok: true, queued: true });
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
  if (!key) return res.status(400).json({ ok:false, error:"missing_key" });
  try {
    const { data } = await ghLoad(GITHUB_FILE_PATH, { keys: [] });
    const found = data.keys.find(k => k.key === key);
    if (!found) return res.status(404).json({ ok:false, error:"not_found" });
    if (found.revoked) return res.status(403).json({ ok:false, error:"revoked" });
    if (!found.used) return res.status(200).json({ ok:true, usable:true, used:false });
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

app.post("/api/user/validate", async (req,res)=>{
  const {key,proof}=req.body||{};
  if(!key)return res.status(400).json({ok:false,error:"missing_key"});
  try{
    const {data}=await ghLoad(USERKEYS_FILE_PATH,{keys:[]});
    const f=data.keys.find(k=>k.key===key);
    if(!f)return res.status(404).json({ok:false,error:"not_found"});
    if(f.revoked)return res.status(403).json({ok:false,error:"revoked"});
    if(!f.used)return res.json({ok:true,usable:true,used:false});
    if(f.boundProof&&proof&&proof===f.boundProof)
      return res.json({ok:true,valid:true,bound:true,used:true});
    return res.status(409).json({ok:false,used:true,error:"bound_mismatch"});
  }catch(err){console.error("user-validate:",err);res.status(500).json({ok:false,error:"read_failed"});}
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

app.post("/api/user/updateRealName", async (req,res)=>{
  if(req.header("admin-token")!==ADMIN_TOKEN)
    return res.status(401).json({ok:false,error:"unauthorized"});
  const {privyId,realName}=req.body||{};
  if(!privyId||!realName)return res.status(400).json({ok:false,error:"missing_fields"});
  try{
    const {data,sha}=await ghLoad(USERNAMES_FILE_PATH,{players:{}});
    if(!data.players)data.players={};
    if(!data.players[privyId])data.players[privyId]={realName:null,usernames:{}};
    data.players[privyId].realName=realName;
    await ghSave(USERNAMES_FILE_PATH,data,sha);
    res.json({ok:true});
  }catch(err){console.error("updateRealName:",err);res.status(500).json({ok:false,error:"write_failed"});}
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

/* =======================================================
   ================== Default & Start ====================
   ======================================================= */

app.get("/", (req,res)=>
  res.send("✅ Combined License + Username Tracker Active")
);

app.listen(PORT, ()=> console.log(`✅ Combined server running on :${PORT}`));
