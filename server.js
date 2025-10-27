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

// App config
const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_FILE_PATH = process.env.GITHUB_FILE_PATH || "keys.json";

// Middleware
app.use(morgan("tiny"));
app.use(express.json({ limit: "256kb" }));
app.use(cors());

// Rate limiter (optional safety)
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
});
app.use(limiter);

// ---------- GitHub Helpers ----------
async function loadKeys() {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!res.ok) throw new Error(`GitHub read failed: ${res.status}`);
  const json = await res.json();
  const data = JSON.parse(Buffer.from(json.content, "base64").toString());
  return { data, sha: json.sha };
}

async function saveKeys(newData, sha) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
  const content = Buffer.from(JSON.stringify(newData, null, 2)).toString("base64");
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      message: "Update keys.json via Render License Server",
      content,
      sha,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub push failed (${res.status}): ${errText}`);
  }
}

// ---------- License Logic ----------
function genKey() {
  return "KEY-" + Math.random().toString(36).substring(2, 10).toUpperCase();
}

// ---------- API ROUTES ----------

// 🧩 List all keys
app.get("/api/admin/list-keys", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const { data } = await loadKeys();
    res.json(data);
  } catch (err) {
    console.error("list-keys error:", err);
    res.status(500).json({ ok: false, error: "read_failed" });
  }
});

// ➕ Add new keys
app.post("/api/admin/add-keys", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });
  try {
    const { data, sha } = await loadKeys();
    const count = req.body.count || 1;
    for (let i = 0; i < count; i++) {
      data.keys.push({
        key: genKey(),
        used: false,
        revoked: false,
        createdAt: new Date().toISOString(),
      });
    }
    await saveKeys(data, sha);
    res.json({ ok: true, added: count });
  } catch (err) {
    console.error("add-keys error:", err);
    res.status(500).json({ ok: false, error: "write_failed" });
  }
});

// 🚫 Revoke a key
app.post("/api/admin/revoke", async (req, res) => {
  if (req.header("admin-token") !== ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "unauthorized" });
  const { key } = req.body;
  if (!key) return res.status(400).json({ ok: false, error: "missing_key" });
  try {
    const { data, sha } = await loadKeys();
    const found = data.keys.find(k => k.key === key);
    if (!found) return res.status(404).json({ ok: false, error: "not_found" });
    found.revoked = true;
    await saveKeys(data, sha);
    res.json({ ok: true });
  } catch (err) {
    console.error("revoke error:", err);
    res.status(500).json({ ok: false, error: "write_failed" });
  }
});

// 🧾 Register / redeem a key (only once)
app.post("/api/register", async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ ok: false, error: "missing_key" });
  try {
    const { data, sha } = await loadKeys();
    const found = data.keys.find(k => k.key === key);
    if (!found) return res.status(404).json({ ok: false, error: "not_found" });
    if (found.revoked) return res.status(403).json({ ok: false, error: "revoked" });
    if (found.used) return res.status(409).json({ ok: false, error: "already_used", used: true });

    found.used = true;
    found.usedAt = new Date().toISOString();
    await saveKeys(data, sha);
    res.status(200).json({ ok: true, used: true });
  } catch (err) {
    console.error("register error:", err);
    res.status(500).json({ ok: false, error: "write_failed" });
  }
});


// ✅ Validate key (for the client)
// ✅ Validate key (eligibility check for the client)
// 200 + { ok:true, usable:true, used:false }  → can be redeemed now
// 409 + { ok:false, error:"already_used", used:true } → reject
// 403 + { ok:false, error:"revoked" } → reject
// 404 + { ok:false, error:"not_found" } → reject
app.post("/api/validate", async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ ok: false, error: "missing_key" });

  try {
    const { data } = await loadKeys();
    const found = data.keys.find(k => k.key === key);
    if (!found) return res.status(404).json({ ok: false, error: "not_found" });
    if (found.revoked) return res.status(403).json({ ok: false, error: "revoked" });
    if (found.used) return res.status(409).json({ ok: false, error: "already_used", used: true });

    // Not revoked, not used → eligible
    return res.status(200).json({ ok: true, usable: true, used: false });
  } catch (err) {
    console.error("validate error:", err);
    res.status(500).json({ ok: false, error: "read_failed" });
  }
});


// ---------- Default ----------
app.get("/", (req, res) => res.send("License Server Active ✅"));

// ---------- Start ----------
app.listen(PORT, () => console.log(`✅ License server running on :${PORT}`));
