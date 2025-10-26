
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import fs from 'fs/promises';
import path from 'path';
import morgan from 'morgan';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const KEYS_FILE = process.env.KEYS_FILE || path.join(__dirname, 'keys.json');

app.use(morgan('tiny'));
app.use(express.json({ limit: '128kb' }));
app.use(cors({ origin: true, credentials: false }));

// ---------- Simple key store using a JSON file ----------
async function readKeys() {
  try {
    const txt = await fs.readFile(KEYS_FILE, 'utf-8');
    const data = JSON.parse(txt);
    if (!Array.isArray(data.keys)) data.keys = [];
    return data;
  } catch (e) {
    if (e.code === 'ENOENT') return { keys: [] };
    throw e;
  }
}

async function writeKeys(data) {
  const tmp = KEYS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, KEYS_FILE);
}

function normalizeKey(k) {
  return String(k || '').trim();
}

// ---------- Rate limits ----------
const redeemLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,             // 10 attempts per minute (manual redemption attempts)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown',
  message: { ok: false, error: 'too_many_attempts', message: 'Too many attempts! Please wait.' }
});

// ---------- Health ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, now: Date.now(), version: '1.0.0' });
});

// ---------- License: redeem (manual) ----------
app.post('/api/license/redeem', redeemLimiter, async (req, res) => {
  try {
    const key = normalizeKey(req.body?.key);
    if (!key) return res.status(400).json({ ok: false, error: 'missing_key' });

    const store = await readKeys();
    const entry = store.keys.find(k => k.key === key);
    if (!entry) return res.status(404).json({ ok: false, error: 'invalid_key' });
    if (entry.revoked) return res.status(403).json({ ok: false, error: 'revoked' });
    if (entry.used) return res.status(409).json({ ok: false, error: 'already_used' });

    entry.used = true;
    entry.usedAt = new Date().toISOString();
    await writeKeys(store);
    return res.json({ ok: true, used: true, usedAt: entry.usedAt });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- License: check (auto / once per page load) ----------
// Returns ok:true only if key exists AND is marked used AND not revoked.
app.post('/api/license/check', async (req, res) => {
  try {
    const key = normalizeKey(req.body?.key);
    if (!key) return res.status(400).json({ ok: false, error: 'missing_key' });

    const store = await readKeys();
    const entry = store.keys.find(k => k.key === key);
    if (!entry) return res.status(404).json({ ok: false, error: 'invalid_or_unredeemed' });
    if (entry.revoked) return res.status(403).json({ ok: false, error: 'revoked' });
    if (!entry.used) return res.status(403).json({ ok: false, error: 'unredeemed' });

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- Admin endpoints (token required) ----------
function requireAdmin(req, res, next) {
  const t = req.headers['x-admin-token'] || '';
  if (!ADMIN_TOKEN || t !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

app.post('/api/admin/add-keys', requireAdmin, async (req, res) => {
  try {
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(normalizeKey).filter(Boolean) : [];
    if (!keys.length) return res.status(400).json({ ok: false, error: 'no_keys' });
    const store = await readKeys();
    let added = 0;
    for (const k of keys) {
      if (!store.keys.find(x => x.key === k)) {
        store.keys.push({ key: k, used: false, revoked: false, createdAt: new Date().toISOString() });
        added++;
      }
    }
    await writeKeys(store);
    res.json({ ok: true, added, total: store.keys.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/admin/revoke', requireAdmin, async (req, res) => {
  try {
    const key = normalizeKey(req.body?.key);
    if (!key) return res.status(400).json({ ok: false, error: 'missing_key' });
    const store = await readKeys();
    const entry = store.keys.find(k => k.key === key);
    if (!entry) return res.status(404).json({ ok: false, error: 'not_found' });
    entry.revoked = True;
    entry.revokedAt = new Date().toISOString();
    await writeKeys(store);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/api/admin/unrevoke', requireAdmin, async (req, res) => {
  try {
    const key = normalizeKey(req.body?.key);
    if (!key) return res.status(400).json({ ok: false, error: 'missing_key' });
    const store = await readKeys();
    const entry = store.keys.find(k => k.key === key);
    if (!entry) return res.status(404).json({ ok: false, error: 'not_found' });
    entry.revoked = false;
    delete entry.revokedAt;
    await writeKeys(store);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`License server listening on :${PORT}`);
});
