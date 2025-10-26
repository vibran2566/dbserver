// server.js  — Vibran License Server (single-file, ESM, async, map storage)

import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import fs from 'fs/promises';
import path from 'path';
import morgan from 'morgan';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app         = express();
const PORT        = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';                 // set this in Render
const KEYS_FILE   = process.env.KEYS_FILE || path.join(__dirname, 'keys.json');

app.use(morgan('tiny'));
app.use(express.json({ limit: '128kb' }));
app.use(cors({ origin: true, credentials: false }));

// ------------------------- Utilities -------------------------

const nowIso = () => new Date().toISOString();
const normalizeKey = k => String(k || '').trim();

// Read keys as a MAP object. Auto-migrate legacy { keys: [ ... ] }.
async function readStore() {
  try {
    const txt = await fs.readFile(KEYS_FILE, 'utf8');
    const raw = txt.trim() ? JSON.parse(txt) : {};
    // Already a map?
    if (raw && typeof raw === 'object' && !Array.isArray(raw.keys)) return raw;

    // Legacy array → map
    const map = {};
    for (const e of (raw.keys || [])) {
      if (!e || !e.key) continue;
      map[String(e.key)] = {
        used: !!e.used,
        revoked: !!e.revoked,
        createdAt: e.createdAt || nowIso(),
        ...(e.usedAt ? { usedAt: e.usedAt } : {}),
        ...(e.revokedAt ? { revokedAt: e.revokedAt } : {}),
      };
    }
    return map;
  } catch (e) {
    if (e.code === 'ENOENT') return {};  // no file yet
    throw e;                              // bubble up JSON errors etc.
  }
}

async function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}

// Atomic write (tmp + rename)
async function writeStore(map) {
  await ensureDirExists(KEYS_FILE);
  const tmp = KEYS_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(map, null, 2));
  await fs.rename(tmp, KEYS_FILE);
}

function requireAdmin(req, res, next) {
  const token = req.headers['admin-token']; // <-- required header
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(403).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// Manual attempts limiter (e.g., redeem UI). NOT used for /check.
const redeemLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.ip || 'unknown',
  message: { ok: false, error: 'too_many_attempts', message: 'Too many attempts! Please wait.' },
});

// ------------------------- Health -------------------------
app.get('/health', (_req, res) => res.json({ ok: true, now: Date.now(), version: '1.0.0' }));

// ------------------------- Admin Routes -------------------------

// Add keys (admin-token header)
app.post('/api/admin/add-keys', requireAdmin, async (req, res) => {
  try {
    const list = Array.isArray(req.body?.keys) ? req.body.keys : null;
    if (!list || !list.length) {
      return res.status(400).json({ ok: false, error: 'invalid_request', hint: 'body must be {"keys":["K1","K2"]}' });
    }

    const store = await readStore();
    const added = [];
    const createdAt = nowIso();

    for (const raw of list) {
      const k = normalizeKey(raw);
      if (!k) continue;
      if (!store[k]) {
        store[k] = { used: false, revoked: false, createdAt };
        added.push(k);
      }
    }

    await writeStore(store);
    res.json({ ok: true, added, total: Object.keys(store).length });
  } catch (err) {
    console.error('ADD-KEYS error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// List keys (admin-token header)
app.get('/api/admin/list-keys', requireAdmin, async (_req, res) => {
  try {
    const store = await readStore();
    res.json({ ok: true, keys: store });
  } catch (err) {
    console.error('LIST-KEYS error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Revoke key
app.post('/api/admin/revoke', requireAdmin, async (req, res) => {
  try {
    const key = normalizeKey(req.body?.key);
    if (!key) return res.status(400).json({ ok: false, error: 'missing_key' });

    const store = await readStore();
    if (!store[key]) return res.status(404).json({ ok: false, error: 'not_found' });

    store[key].revoked = true;        // note: lowercase true
    store[key].revokedAt = nowIso();
    await writeStore(store);
    res.json({ ok: true });
  } catch (err) {
    console.error('REVOKE error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Unrevoke key
app.post('/api/admin/unrevoke', requireAdmin, async (req, res) => {
  try {
    const key = normalizeKey(req.body?.key);
    if (!key) return res.status(400).json({ ok: false, error: 'missing_key' });

    const store = await readStore();
    if (!store[key]) return res.status(404).json({ ok: false, error: 'not_found' });

    store[key].revoked = false;
    delete store[key].revokedAt;
    await writeStore(store);
    res.json({ ok: true });
  } catch (err) {
    console.error('UNREVOKE error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Delete key (optional, but handy)
app.post('/api/admin/delete', requireAdmin, async (req, res) => {
  try {
    const key = normalizeKey(req.body?.key);
    if (!key) return res.status(400).json({ ok: false, error: 'missing_key' });

    const store = await readStore();
    if (!store[key]) return res.status(404).json({ ok: false, error: 'not_found' });

    delete store[key];
    await writeStore(store);
    res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error('DELETE error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// ------------------------- License Routes -------------------------

// Redeem (manual submit, rate-limited)
app.post('/api/license/redeem', redeemLimiter, async (req, res) => {
  try {
    const key = normalizeKey(req.body?.key);
    if (!key) return res.status(400).json({ ok: false, error: 'missing_key' });

    const store = await readStore();
    const entry = store[key];

    if (!entry)        return res.status(404).json({ ok: false, error: 'invalid_key' });
    if (entry.revoked) return res.status(403).json({ ok: false, error: 'revoked' });
    if (entry.used)    return res.status(409).json({ ok: false, error: 'already_used' });

    entry.used = true;
    entry.usedAt = nowIso();
    await writeStore(store);
    res.json({ ok: true, used: true, usedAt: entry.usedAt });
  } catch (err) {
    console.error('REDEEM error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Check (auto once per page load; no manual rate limit here)
app.post('/api/license/check', async (req, res) => {
  try {
    const key = normalizeKey(req.body?.key);
    if (!key) return res.status(400).json({ ok: false, error: 'missing_key' });

    const store = await readStore();
    const entry = store[key];

    if (!entry)        return res.status(404).json({ ok: false, error: 'invalid_or_unredeemed' });
    if (entry.revoked) return res.status(403).json({ ok: false, error: 'revoked' });
    if (!entry.used)   return res.status(403).json({ ok: false, error: 'unredeemed' });

    res.json({ ok: true });
  } catch (err) {
    console.error('CHECK error:', err);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Aliases (compat with earlier commands you tried)
app.post('/api/register', (req, res, next) => { req.url = '/api/license/redeem'; next(); }, app._router);
app.post('/api/check',    (req, res, next) => { req.url = '/api/license/check';  next(); }, app._router);

// ------------------------- Start -------------------------
app.listen(PORT, () => {
  console.log(`✅ License server listening on :${PORT}`);
  console.log(`• Using KEYS_FILE: ${KEYS_FILE}`);
  console.log(`• Admin header   : admin-token`);
});
