import fs from "fs";

const USER_FILE = "/data/usernames.json";
if (!fs.existsSync(USER_FILE)) {
  console.log("No usernames.json found");
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(USER_FILE, "utf8"));
let removed = 0;

for (const [did, player] of Object.entries(data.players || {})) {
  if (!player.usernames) continue;
  if (player.usernames["Anonymous Player"]) {
    delete player.usernames["Anonymous Player"];
    removed++;
  }
}

fs.writeFileSync(USER_FILE, JSON.stringify(data, null, 2));
console.log(`✅ Cleaned ${removed} Anonymous Player entries.`);
