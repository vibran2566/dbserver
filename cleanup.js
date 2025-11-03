#!/usr/bin/env node
/**
 * cleanup-fixed.v2.createRequire.js
 * Robust cleanup for usernames.json when project uses ESM but you prefer require.
 *
 * Usage:
 *    node cleanup-fixed.v2.createRequire.js /path/to/usernames.json
 *    USER_FILE=/path/to/usernames.json node cleanup-fixed.v2.createRequire.js
 */
import { createRequire } from 'node:module';
import process from 'node:process';
const require = createRequire(import.meta.url);

const fs = require('fs');

const USER_FILE = process.argv[2] || process.env.USER_FILE || '/data/usernames.json';
const ANON_RE = /^\s*anonymous\s+player\s*$/i;

function loadJson(p) {
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('❌ Failed to parse JSON:', e?.message || e);
    return null;
  }
}

function saveJson(p, obj) {
  try {
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    console.error('❌ Failed to write JSON:', e?.message || e);
    return false;
  }
}

function recomputeTopUsernames(usernamesObj) {
  const entries = Object.entries(usernamesObj || {})
    .filter(([k, v]) => typeof k === 'string' && typeof v === 'number' && v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  return entries.map(([name, count]) => ({ name, count }));
}

(function main() {
  console.log('🧹 Cleaning:', USER_FILE);
  const data = loadJson(USER_FILE);
  if (!data || typeof data !== 'object') {
    console.log('No usernames.json found or invalid JSON. Exiting.');
    process.exit(0);
  }

  const players = (data.players && typeof data.players === 'object') ? data.players : {};
  let removedPending = 0;
  let removedRegionFlags = 0;
  let removedAnonFromUsernames = 0;
  let prunedEmptyPlayers = 0;
  let filteredAnonFromTop = 0;

  // 1) Remove ALL pending:* entries (collect keys first, then delete)
  const pendingKeys = Object.keys(players).filter(k => typeof k === 'string' && k.startsWith('pending:'));
  for (const k of pendingKeys) {
    delete players[k];
    removedPending++;
  }

  // 2) Walk remaining players and clean
  const pruneKeys = [];
  for (const [did, player] of Object.entries(players)) {
    if (!player || typeof player !== 'object') { pruneKeys.push(did); continue; }

    // 2a) Delete legacy Region field (NOT topRegion)
    if (Object.prototype.hasOwnProperty.call(player, 'Region')) {
      delete player.Region;
      removedRegionFlags++;
    }

    // 2b) Strip 'Anonymous Player' from usernames
    const u = (player.usernames && typeof player.usernames === 'object') ? player.usernames : {};
    for (const uname of Object.keys(u)) {
      if (ANON_RE.test(uname)) {
        delete u[uname];
        removedAnonFromUsernames++;
      }
    }
    player.usernames = u;

    // 2c) Recompute topUsernames from usernames
    player.topUsernames = recomputeTopUsernames(u);

    // 2d) Extra safety: ensure no Anonymous Player in any existing topUsernames arrays
    if (Array.isArray(player.topUsernames)) {
      const before = player.topUsernames.length;
      player.topUsernames = player.topUsernames.filter(t => !ANON_RE.test(String(t?.name || '')));
      filteredAnonFromTop += (before - player.topUsernames.length);
    }

    // 2e) Optional prune: if player has no usernames and no realName, drop
    const hasNames = Object.keys(u).length > 0;
    const hasReal = !!(player.realName && String(player.realName).trim());
    if (!hasNames && !hasReal) pruneKeys.push(did);
  }
  for (const k of pruneKeys) {
    delete players[k];
    prunedEmptyPlayers++;
  }

  // 3) bump updatedAt & save
  data.players = players;
  data.updatedAt = Date.now();

  if (saveJson(USER_FILE, data)) {
    console.log('✅ Done.');
    console.log(`   Removed pending players: ${removedPending}`);
    console.log(`   Removed legacy Region flags: ${removedRegionFlags}`);
    console.log(`   Removed "Anonymous Player" from usernames: ${removedAnonFromUsernames}`);
    console.log(`   Filtered "Anonymous Player" from topUsernames: ${filteredAnonFromTop}`);
    console.log(`   Pruned empty player records: ${prunedEmptyPlayers}`);
  } else {
    process.exit(1);
  }
})();
