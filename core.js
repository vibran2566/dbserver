// --- core.js (drop-in replacement or merge) ---------------------------------
// Purpose: Client detects the shard from the page URL and ONLY reads from
// the backend endpoints. It NEVER calls the game's /players directly now.
//
// Cadence:
//  - Leaderboard every 5s:   GET /api/game/leaderboard?serverKey=...
//  - Usernames  every 7s:   GET /api/game/usernames?serverKey=...
//
// What to DELETE from old core.js:
//  1) Any code that builds a game PLAYERS_URL like
//     "https://damnbruh-game-server-instance-.../players"
//  2) Any fetch/GM_xmlhttpRequest/WebSocket that hits the game's /players
//  3) Any timers/loops invoking fetchPlayers() (or similarly named) that
//     call the game directly.
//  4) Any client → server forwarding of /players payloads.
//
// Keep your existing render functions; this file will call them if present.
//
// ---------------------------------------------------------------------------

// Point this at your backend host
const DATA_API_BASE = (window.__DB_API_BASE__) || 'https://dbserver-8bhx.onrender.com';

function getParam(name) {
  const m = new URLSearchParams(window.location.search);
  return m.get(name);
}

// serverId looks like "us-1-dollar" or "eu-5-dollar"
function getServerKeyFromURL() {
  const serverId = (getParam('serverId') || '').toLowerCase();
  // fallback-safe parse
  // Formats seen: "us-1-dollar" => ["us","1","dollar"]
  const parts = serverId.split('-');
  if (parts.length >= 2) {
    const region = parts[0];
    const num = parts[1];
    if ((region === 'us' || region === 'eu') && /^\d+$/.test(num)) {
      return `${region}-${num}`;
    }
  }
  // If we cannot determine, default to us-1 to avoid crashes (you may choose to no-op instead)
  return 'us-1';
}

// Safe wrappers to avoid breaking if your UI functions have different names
function safeRenderLeaderboard(entries, meta) {
  if (typeof window.renderLeaderboard === 'function') {
    window.renderLeaderboard(entries, meta);
    return;
  }
  // Minimal fallback: write to console
  console.debug('[LB]', entries.slice(0, 5));
}

function safeRenderUsernames(usernamesObj) {
  if (typeof window.renderUsernames === 'function') {
    window.renderUsernames(usernamesObj);
    return;
  }
  console.debug('[Usernames keys]', Object.keys(usernamesObj).length);
}

function httpGetJson(url) {
  return fetch(url, { method: 'GET', credentials: 'include' }).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

(function main() {
  const serverKey = getServerKeyFromURL();
  console.log('[core] serverKey =', serverKey, '→ backend-only mode');

  // --- DELETE any previous intervals that called the game /players
  // e.g., clearInterval(window.__playersTimer); remove fetchPlayers(), etc.

  // Leaderboard loop (5s)
  function pullLeaderboard() {
    const url = `${DATA_API_BASE}/api/game/leaderboard?serverKey=${encodeURIComponent(serverKey)}`;
    httpGetJson(url)
      .then(({ ok, entries, updatedAt, stale }) => {
        if (!ok) return;
        safeRenderLeaderboard(entries || [], { updatedAt, stale, serverKey });
      })
      .catch(err => {
        console.warn('[LB error]', err && err.message || err);
      });
  }

  // Usernames loop (7s)
  function pullUsernames() {
    const url = `${DATA_API_BASE}/api/game/usernames?serverKey=${encodeURIComponent(serverKey)}`;
    httpGetJson(url)
      .then(({ ok, usernames }) => {
        if (!ok) return;
        // usernames is the whole usernamesStore object with structure:
        // { [privyId]: { realName?, Region, usernames: { [name]: count } } }
        safeRenderUsernames(usernames || {});
      })
      .catch(err => {
        console.warn('[UN error]', err && err.message || err);
      });
  }

  // Initial immediate fetches
  pullLeaderboard();
  pullUsernames();

  // Schedule
  const lbTimer = setInterval(pullLeaderboard, 5000);
  const unTimer = setInterval(pullUsernames, 7000);

  // Expose cancel in case you navigate SPA-style in the future
  window.__DB_CORE_TIMERS__ = { lbTimer, unTimer };
})();
