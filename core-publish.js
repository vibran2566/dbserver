// core-publish.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JavaScriptObfuscator = require('javascript-obfuscator');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// CONFIG - adjust as necessary
const DATA_DIR = process.env.DATA_DIR || '/data';
const CORE_SRC = path.join(DATA_DIR, 'core.js');                     // human-readable source
const OBF_LATEST = path.join(DATA_DIR, 'core.obf.latest.js');       // served by download endpoint
const OBF_VERSIONED = v => path.join(DATA_DIR, `core.obf.${v}.js`);
const META_PATH = path.join(DATA_DIR, 'version.json');              // persisted meta
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';         // must be set in env for production

// in-memory meta (kept in sync with disk)
let ACTIVE_META = { ok:false, activeVersion: null, sha256: null };

// utility: compute sha256 hex of Buffer/string
function sha256Hex(bufOrStr) {
  const h = crypto.createHash('sha256');
  h.update(bufOrStr);
  return h.digest('hex');
}

// atomic write helper: write to tmp then rename
function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

// load meta from disk at startup (if present)
function loadMetaFromDisk() {
  try {
    if (!fs.existsSync(META_PATH)) return;
    const raw = fs.readFileSync(META_PATH, 'utf8');
    const j = JSON.parse(raw);
    if (j && j.activeVersion) {
      ACTIVE_META = { ok:true, activeVersion: String(j.activeVersion), sha256: String(j.sha256 || '') };
    }
  } catch (err) {
    console.warn('Failed to load meta from disk:', err);
  }
}

// write meta atomically to disk and update in-memory
function persistMeta(version, sha) {
  const payload = { ok:true, activeVersion: String(version), sha256: String(sha) };
  atomicWrite(META_PATH, JSON.stringify(payload, null, 2));
  ACTIVE_META = payload;
}

// Obfuscation options (tune as desired)
const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.85,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  disableConsoleOutput: true,
  stringArray: true,
  stringArrayThreshold: 0.75
};

// Endpoint: meta
app.get('/api/user/core/meta', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(ACTIVE_META);
});

// Endpoint: download
app.get('/api/user/core/download', (req, res) => {
  // serve the latest obf file
  if (!fs.existsSync(OBF_LATEST)) return res.status(404).json({ ok:false, error:'not_found' });
  const data = fs.readFileSync(OBF_LATEST);
  const sha = sha256Hex(data);
  res.set('ETag', sha);
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.type('application/javascript').send(data);
});

// Admin endpoint: bump -- body: { version: "x.y.z" }
// Requires header x-admin-token: ADMIN_TOKEN
app.post('/api/core/bump', async (req, res) => {
  try {
    const token = req.header('x-admin-token');
    if (!token || token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });

    const version = req.body && req.body.version;
    if (!version || !/^\d+\.\d+\.\d+$/.test(String(version))) {
      return res.status(400).json({ ok:false, error:'invalid_version', message:'expected semantic version x.y.z' });
    }

    if (!fs.existsSync(CORE_SRC)) {
      return res.status(500).json({ ok:false, error:'core_missing', message:`${CORE_SRC} not found` });
    }

    // read source
    const src = fs.readFileSync(CORE_SRC, 'utf8');

    // optional: minify before obfuscation — skipping for simplicity, obfuscator can compact
    const obfResult = JavaScriptObfuscator.obfuscate(src, OBFUSCATOR_OPTIONS);
    const obfCode = obfResult.getObfuscatedCode();

    // compute sha
    const sha = sha256Hex(obfCode);

    // write versioned file and update latest atomically
    const verPath = OBF_VERSIONED(version);
    atomicWrite(verPath, obfCode);
    atomicWrite(OBF_LATEST, obfCode);

    // persist meta and update in-memory (atomic)
    persistMeta(version, sha);

    // respond with meta
    return res.json({ ok:true, activeVersion: version, sha256: sha });
  } catch (err) {
    console.error('bump error:', err);
    return res.status(500).json({ ok:false, error:'bump_failed', message: String(err) });
  }
});

// optional health
app.get('/_health', (req, res) => res.send('ok'));

// startup
loadMetaFromDisk();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`core-publish server listening on ${PORT}`);
  console.log('ACTIVE_META:', ACTIVE_META);
});
