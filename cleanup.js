#!/usr/bin/env node
/**
 * cleanup-fixed.js
 * - Removes any player whose privyId key starts with "pending:"
 * - Removes all "Anonymous Player" usernames (case-insensitive) from each player
 * - Recomputes topUsernames from the remaining usernames
 * - Touches updatedAt and prints a summary
 *
 * Usage: node cleanup-fixed.js [/custom/path/to/usernames.json]
 */

const fs = require("fs");
const path = require("path");

const USER_FILE = process.argv[2] || process.env.USER_FILE || "/data/usernames.json";

function loadJson(p) {
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error("❌ Failed to parse JSON:", e && e.message ? e.message : e);
    return null;
  }
}

function saveJson(p, obj) {
  try {
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    console.error("❌ Failed to write JSON:", e && e.message ? e.message : e);
    return false;
  }
}

function recomputeTopUsernames(usernamesObj) {
  const entries = Object.entries(usernamesObj || {})
    .filter(([k, v]) => typeof k === "string" && typeof v === "number" && v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  return entries.map(([name, count]) => ({ name, count }));
}

(function main() {
  console.log("🧹 Cleaning:", USER_FILE);
  const data = loadJson(USER_FILE);
  if (!data || typeof data !== "object") {
    console.log("No usernames.json found or invalid JSON. Exiting.");
    process.exit(0);
  }

  const players = (data.players && typeof data.players === "object") ? data.players : {};
  const anonRE = /^anonymous\s+player$/i;

  let removedPending = 0;
  let removedAnonNames = 0;
  let prunedEmptyPlayers = 0;

  // 1) Remove any "pending:*" players entirely
  for (const did of Object.keys(players)) {
    if (typeof did === "string" && did.startsWith("pending:")) {
      delete players[did];
      removedPending++;
    }
  }

  // 2) Remove Anonymous Player usernames, recompute topUsernames
  for (const [did, player] of Object.entries(players)) {
    if (!player || typeof player !== "object") continue;
    const u = player.usernames && typeof player.usernames === "object" ? player.usernames : {};

    // delete all keys that equal "Anonymous Player" (case-insensitive)
    for (const name of Object.keys(u)) {
      if (anonRE.test(name)) {
        removedAnonNames++;
        delete u[name];
      }
    }

    // recompute top3 after deletions
    player.usernames = u;
    player.topUsernames = recomputeTopUsernames(u);

    // optional prune: if a record has no usernames and no realName, drop it
    const hasNames = Object.keys(u).length > 0;
    const hasReal = !!(player.realName && String(player.realName).trim());
    if (!hasNames && !hasReal) {
      delete players[did];
      prunedEmptyPlayers++;
    }
  }

  // 3) bump updatedAt
  data.players = players;
  data.updatedAt = Date.now();

  // 4) Save atomically
  if (saveJson(USER_FILE, data)) {
    console.log(`✅ Done.`);
    console.log(`   Removed pending players: ${removedPending}`);
    console.log(`   Removed "Anonymous Player" usernames: ${removedAnonNames}`);
    console.log(`   Pruned empty player records: ${prunedEmptyPlayers}`);
  } else {
    process.exit(1);
  }
})();
