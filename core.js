(() => {
  // stop a previous dev run
  if (window.__USERNAME_TRACKER__?.stop) { try { window.__USERNAME_TRACKER__.stop(); } catch {} }

  let LB_BOX = null, LB_BODY = null, LB_STATUS = null, LB_VER = null;
  let TICK = null;
  // add this just after LB_* and TICK are declared
// Version label comes from the bootstrapper's cache
const UI_VER = (() => {
  try {
    const v = localStorage.getItem('db_core_ver_v1');
    if (v && /^\d+\.\d+\.\d+$/.test(v)) return 'v' + v;
  } catch {}
  try { return 'v' + (GM_info?.script?.version?.replace(/^v?/, '') || '0.0.0'); }
  catch { return 'v0.0.0'; }
})();


    const USER_API_BASE = 'https://dbserver-8bhx.onrender.com/api/user';
const GAME_API_BASE = USER_API_BASE.replace(/\/api\/user$/, '');
    let __MAP__ = { players: {} };
  

function resolveServerKey() {
  var sid = new URLSearchParams(location.search).get('serverId') || '';
  var m = sid.match(/^(us|eu)-(1|5|20)/i);
  var region = m ? m[1].toLowerCase() : 'us';
  var amount = m ? m[2] : '1';
  return { region: region, amount: amount, serverKey: region + '-' + amount };
}
function normalizeFilterSort(arr) {
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var p = arr[i];

    var name = null;
    if (typeof p.name === 'string' && p.name) name = p.name;
    else if (typeof p.username === 'string' && p.username) name = p.username;
    else if (typeof p.playerName === 'string' && p.playerName) name = p.playerName;
    else name = '#' + (i + 1);

    var privyId = null;
    if (p.privyId != null) privyId = p.privyId;
    else if (p.id != null) privyId = p.id;
    else if (p.playerId != null) privyId = p.playerId;

    var sRaw = 0;
    if (p.size != null) sRaw = p.size;
    else if (p.snakeSize != null) sRaw = p.snakeSize;
    else if (p.length != null) sRaw = p.length;

    var mvRaw = 0;
    if (p.monetaryValue != null) mvRaw = p.monetaryValue;
    else if (p.value != null) mvRaw = p.value;
    else if (p.money != null) mvRaw = p.money;
    else if (p.cash != null) mvRaw = p.cash;

    var sizeNum = Number(sRaw);
    if (!isFinite(sizeNum)) sizeNum = 0;

    var mvNum = Number(mvRaw);
    if (!isFinite(mvNum)) mvNum = 0;

    if (mvNum > 0 && sizeNum > 2) {
      out.push({
        name: name,
        privyId: privyId,
        size: sizeNum,
        monetaryValue: mvNum
      });
    }
  }

  out.sort(function(a, b) {
    var d = (b.monetaryValue || 0) - (a.monetaryValue || 0);
    if (d !== 0) return d;
    d = (b.size || 0) - (a.size || 0);
    if (d !== 0) return d;
    var an = String(a.name || '');
    var bn = String(b.name || '');
    return an.localeCompare(bn);
  });

  return out;
}
(() => {
  // stop a previous dev run
  if (window.__USERNAME_TRACKER__?.stop) { try { window.__USERNAME_TRACKER__.stop(); } catch {} }

  let LB_BOX = null, LB_BODY = null, LB_STATUS = null, LB_VER = null;
  let TICK = null;
  // add this just after LB_* and TICK are declared
// Version label comes from the bootstrapper's cache
const UI_VER = (() => {
  try {
    const v = localStorage.getItem('db_core_ver_v1');
    if (v && /^\d+\.\d+\.\d+$/.test(v)) return 'v' + v;
  } catch {}
  try { return 'v' + (GM_info?.script?.version?.replace(/^v?/, '') || '0.0.0'); }
  catch { return 'v0.0.0'; }
})();


    const USER_API_BASE = 'https://dbserver-8bhx.onrender.com/api/user';
const GAME_API_BASE = USER_API_BASE.replace(/\/api\/user$/, '');
    let __MAP__ = { players: {} };
 // --- Alerts: poll server and toast ---
// ===== ALERTS: drop-in replacement =====

// Ensure toast CSS exists
// ========== ALERT UI ==========
(function ensureAlertStyles(){
  if (document.getElementById('db-alert-style')) return;
  const s = document.createElement('style');
  s.id = 'db-alert-style';
  s.textContent = `
.db-alerts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:2147483647}
.db-alert{background:#000;color:#fff;border:2px solid #ffd400;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);
  width:min(340px,92vw);padding:12px 14px;white-space:pre-wrap;word-break:break-word;opacity:0;transform:translateY(8px);
  transition:opacity .25s ease, transform .25s ease}
.db-alert.show{opacity:1;transform:translateY(0)}
.db-alert.hide{opacity:0;transform:translateY(6px)}
.db-alert-title{font-weight:700;letter-spacing:.3px;margin-bottom:6px;align-items:center}
.db-alert-body{font:13px ui-monospace, Menlo, Consolas, monospace;line-height:1.35;align-items:center}
.db-alert{
  display:flex;
  flex-direction:column;
  align-items:center;
  text-align:center;
}
.db-alert-title{
  color:#ffd400;
}

@media (max-width:480px){.db-alert{right:8px;bottom:8px}}
`;
  document.head.appendChild(s);
}());

function dbAlertContainer(){
  let c = document.querySelector('.db-alerts');
  if (!c){ c = document.createElement('div'); c.className = 'db-alerts'; document.body.appendChild(c); }
  return c;
}
  (() => {
  const s = document.createElement('style');
  s.textContent = `.db-alert-body{font-size:16px;line-height:1.45}`;
  document.head.appendChild(s);
})();


function dbShowAlertToast(msg){
  const card = document.createElement('div');
  card.className = 'db-alert';

  const title = document.createElement('div');
  title.className = 'db-alert-title';
  title.textContent = 'ALERT:';

  const body = document.createElement('div');
  body.className = 'db-alert-body';
  body.textContent = String(msg || '');

  card.append(title, body);
  dbAlertContainer().appendChild(card);

  // animate in
  requestAnimationFrame(() => card.classList.add('show'));

  // auto dismiss
  const ttl = 5500;
  const hide = () => { card.classList.add('hide'); setTimeout(() => card.remove(), 450); };
  const timer = setTimeout(hide, ttl);

  // click to dismiss early
  card.addEventListener('click', () => { clearTimeout(timer); hide(); }, { once:true });
}
// =================================


// Pull key from your stored blob
function dbGetClientKey(){
  try{
    const rawLS = localStorage.getItem('damnbruh_username_keys');
    const rawGM = (typeof GM_getValue==='function') ? GM_getValue('damnbruh_username_keys', null) : null;
    const raw = rawLS ?? rawGM;
    if (raw){
      const obj = typeof raw==='string' ? JSON.parse(raw) : raw;
      if (obj && typeof obj.username_script_key==='string' && obj.username_script_key) return obj.username_script_key;
    }
  }catch{}
  return null;
}

// Deduper: remember seen alert uids instead of relying only on timestamps
function dbSeenStore(get){
  const k='db_seen_alerts_v1';
  if (get){
    try{ return JSON.parse(localStorage.getItem(k) || '{}'); }catch{return{}}
  } else {
    return {
      add(uid){ try{
        const m=dbSeenStore(true); m[uid]=Date.now();
        // keep map small
        const entries=Object.entries(m).sort((a,b)=>a[1]-b[1]).slice(-200);
        localStorage.setItem('db_seen_alerts_v1', JSON.stringify(Object.fromEntries(entries)));
      }catch{} }
    };
  }
}

function dbAlertUid(a){
  // Build a stable unique id from whatever fields exist
  const cand = [
    a.id, a.uuid, a.uid, a.ts, a.timestamp, a.time, a.createdAt, a.expiresAt, a.message
  ].filter(Boolean)[0];
  return String(cand || Math.random()).slice(0, 128);
}

let DB_ALERTS_FIRST_SHOWN = false;

async function dbPollAlerts(){
  const key = dbGetClientKey();
  if (!key){ console.debug('[alerts] no key'); return; } // server requires key

  try{
    const res = await fetch(`${USER_API_BASE}/alerts?key=${encodeURIComponent(key)}`, { cache:'no-store' });
    if (!res.ok){ console.debug('[alerts] http', res.status); return; }
    const j = await res.json().catch(()=>null);
    const arr = j && Array.isArray(j.alerts) ? j.alerts : (Array.isArray(j) ? j : []);
    if (!arr.length){ return; }

    const seen = dbSeenStore(true);
    const incoming = [];

    for (const a of arr){
      const uid = dbAlertUid(a);
      if (!seen[uid]) incoming.push({a, uid});
    }

    // If all appear "seen" due to missing ids/timestamps, show the most recent once
    if (!incoming.length && !DB_ALERTS_FIRST_SHOWN){
      const last = arr[arr.length - 1];
      if (last) incoming.push({ a: last, uid: 'fallback:'+dbAlertUid(last) });
    }

    for (const {a, uid} of incoming){
      if (a && a.message) dbShowAlertToast(a.message);
      dbSeenStore().add(uid);
      DB_ALERTS_FIRST_SHOWN = true;
    }
  }catch(e){
    // swallow
  }
}

// Kick off (every 10s)
setTimeout(dbPollAlerts, 1200);
setInterval(dbPollAlerts, 10000);


// ————— Username Info Modal (drop-in, unchanged styling) —————
let INFO_BOX = null, INFO_HEADER = null, INFO_BODY = null;

function createUsernameInfoBox() {
  if (INFO_BOX && INFO_BOX.isConnected) return INFO_BOX;

  const box = document.createElement("div");
  box.id = "username-info-box";
  Object.assign(box.style, {
    position: "fixed",
    zIndex: 2147483647,
    left: "16px",
    top: "16px",
    padding: "12px 14px",
    paddingTop: "19px",                  // space for the handle
    minWidth: "160px",
    fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
    fontSize: "13px",
    color: "#fff",
    background: "rgba(0, 0, 0, .65)",
    backdropFilter: "blur(6px)",
    border: "1px solid rgba(255, 255, 255, .12)",
    borderRadius: "12px",
    boxShadow: "0 6px 18px rgba(0, 0, 0, .35)",
    opacity: "1"
  });

  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;user-select:none;">
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 10px rgba(34,197,94,.9)"></div>
        <div id="username-info-header" style="opacity:.9;letter-spacing:.06em;font-weight:700">Unknown</div>
      </div>
      <button id="username-info-close" style="background:none;border:none;color:#fff;opacity:.7;cursor:pointer;font-size:13px;">✖</button>
    </div>
    <div id="username-info-body" style="display:grid;grid-template-columns:1fr auto;row-gap:6px;column-gap:10px;"></div>
  `;

  // drag handle (same look)
  const drag = document.createElement("div");
  drag.className = "db-top-drag";
  box.appendChild(drag);

  document.body.appendChild(box);

  // drag logic
  let dragging=false,sx=0,sy=0,ox=0,oy=0;
  function down(e){ const p=e.touches?e.touches[0]:e; dragging=true; sx=p.clientX; sy=p.clientY; const r=box.getBoundingClientRect(); ox=r.left; oy=r.top; e.preventDefault();}
  function move(e){ if(!dragging) return; const p=e.touches?e.touches[0]:e; const nx=Math.max(0,Math.min(innerWidth-40, ox+(p.clientX-sx))); const ny=Math.max(0,Math.min(innerHeight-40, oy+(p.clientY-sy))); box.style.left=nx+"px"; box.style.top=ny+"px"; }
  function up(){ dragging=false; saveInfoBoxPos(); }
  drag.addEventListener("mousedown", down);
  drag.addEventListener("touchstart", down, { passive: false });
  addEventListener("mousemove", move, { passive: false });
  addEventListener("touchmove", move, { passive: false });
  addEventListener("mouseup", up, { passive: true });
  addEventListener("touchend", up, { passive: true });

  INFO_BOX   = box;
  INFO_HEADER= box.querySelector("#username-info-header");
  INFO_BODY  = box.querySelector("#username-info-body");
  box.querySelector("#username-info-close").addEventListener("click", hideUsernameInfo);

  restoreInfoBoxPos();
  return box;
}

function restoreInfoBoxPos(){
  try{
    const saved = JSON.parse(localStorage.getItem("username_info_box_pos") || "{}");
    if (saved.left && saved.top && INFO_BOX) Object.assign(INFO_BOX.style, { left:saved.left, top:saved.top });
  } catch {}
}
function saveInfoBoxPos(){
  if (!INFO_BOX) return;
  const snapshot = { left: INFO_BOX.style.left, top: INFO_BOX.style.top };
  localStorage.setItem("username_info_box_pos", JSON.stringify(snapshot));
}

function showUsernameInfo(mapInfo){
  const box = createUsernameInfoBox();
  const headerText = mapInfo?.realName || "Unknown";
  const usernames = mapInfo?.allUsernames || mapInfo?.usernames || {};
  const sorted = Object.entries(usernames).sort((a,b)=>b[1]-a[1]).slice(0,3); // top 3 like before

  INFO_HEADER.textContent = headerText;
  INFO_BODY.replaceChildren();

  if (sorted.length === 0) {
    const none = document.createElement("div");
    none.textContent = "No usernames recorded.";
    none.style.opacity = ".7";
    none.style.gridColumn = "1 / -1";
    INFO_BODY.appendChild(none);
  } else {
    for (const [name, count] of sorted) {
      const n = document.createElement("div"); n.textContent = name;
      const c = document.createElement("div"); c.style.color = "#4ade80"; c.style.fontWeight = "700"; c.textContent = count;
      INFO_BODY.appendChild(n); INFO_BODY.appendChild(c);
    }
  }
}

function hideUsernameInfo(){
  if (!INFO_BOX || !INFO_BOX.isConnected) return;
  INFO_BOX.parentNode.removeChild(INFO_BOX);
  INFO_BOX = INFO_HEADER = INFO_BODY = null;
}

// Ensure this tiny rule exists in your injectStyles() block:
/// .db-top-drag{ position:absolute; top:6px; left:50%; transform:translateX(-50%); width:44px; height:8px; border-radius:6px; background:rgba(255,255,255,.12); cursor:move; z-index:2; }



  function parseServerId() {
    const sid = new URLSearchParams(location.search).get('serverId') || '';
    const m = sid.match(/^(us|eu)-(1|5|20)\b/i);
    if (m) return { region: m[1].toLowerCase(), amount: m[2] };
    return { region: 'us', amount: '1' }; // fallback
  }

  function playersEndpoint() {
    const { region, amount } = parseServerId();
    return `https://damnbruh-game-server-instance-${amount}-${region}.onrender.com/players`;
  }

  // replace your current fetchLeaderboard()
// replace your current fetchLeaderboard()
async function fetchLeaderboard() {
  const { serverKey } = resolveServerKey();
  const url = `${GAME_API_BASE}/api/game/leaderboard?serverKey=${encodeURIComponent(serverKey)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('leaderboard ' + res.status);
  const j = await res.json();
  const entries = Array.isArray(j.entries) ? j.entries : [];

  // safety filter client-side too
  const filtered = entries.filter(p =>
    (p && p.name) &&
    (p.monetaryValue || 0) > 0 &&
    (p.size || 0) > 2
  );

  // highest to lowest monetaryValue
  filtered.sort((a, b) => (b.monetaryValue || 0) - (a.monetaryValue || 0));
  return filtered;
}

// add this helper
// add this helper
async function fetchMapping() {
  const res = await fetch(`${USER_API_BASE}/mapping`, { cache: 'no-store' });
  if (!res.ok) return { players: {} };
  const j = await res.json().catch(() => ({}));
  return j && j.players ? j : { players: {} };
}



async function fetchFilteredSortedList() {
  var sk = resolveServerKey();

  // 1) aggregator
  try {
    var aggUrl = GAME_API_BASE + '/api/game/leaderboard?serverKey=' + encodeURIComponent(sk.serverKey);
    var res = await fetch(aggUrl, { cache: 'no-store' });
    if (res.ok) {
      var j = await res.json();
      var arr = Array.isArray(j.entries) ? j.entries : [];
      var list = normalizeFilterSort(arr);
      if (list.length > 0) return list;
    }
  } catch (e1) {}

  // 2) fallback to live shard /players
  try {
    var rawUrl = 'https://damnbruh-game-server-instance-' + sk.amount + '-' + sk.region + '.onrender.com/players';
    var r2 = await fetch(rawUrl, { cache: 'no-store' });
    if (r2.ok) {
      var body = await r2.json();
      var base = Array.isArray(body) ? body : (Array.isArray(body.players) ? body.players : []);
      return normalizeFilterSort(base);
    }
  } catch (e2) {}

  return [];
}


// poll mapping on its own cadence
setInterval(async () => {
  try { __MAP__ = await fetchMapping(); } catch {}
}, 7000);

  function injectStyles() {
    if (document.getElementById('dbk-styles-usernames')) return;
    const s = document.createElement('style');
    s.id = 'dbk-styles-usernames';
    s.textContent = `
      #username-leaderboard {
        position: fixed; z-index: 2147483646; left: 16px; top: 16px;
        width: 220px; color: #fff; background: rgba(0,0,0,.75);
        border: 1px solid rgba(255,255,255,.12); border-radius: 12px;
        box-shadow: 0 6px 18px rgba(0,0,0,.35);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 13px; line-height: 1.35; padding: 10px 12px 8px; backdrop-filter: blur(6px);
      }
      #username-leaderboard-header {
        position:relative; padding-top:14px; text-align:left; font-weight:700;
        letter-spacing:.06em; margin-bottom:8px; padding-left:28px;
      }
      #username-leaderboard-header::before {
        content:''; position:absolute; width:10px; height:10px; left:5px; top:17.5px;
        background:#22c55e; border-radius:50%; box-shadow:0 0 6px #22c55e;
      }
      .ub-top-drag {
        width:44px; position:absolute; top:-1px; left:50%; transform:translateX(-50%);
        height:8px; border-radius:6px; background:rgba(255,255,255,.12); cursor:move;
        box-shadow:0 0 10px rgba(0,0,0,.8);
      }
      .ub-row { display:flex; align-items:center; justify-content:space-between; padding:4px 0;
        border-top:1px solid rgba(255,255,255,.08); }
      .ub-row:first-of-type{ border-top:none; }
      .ub-left { display:flex; align-items:center; gap:6px; min-width:0; }
      .ub-rank{ color:#fff; opacity:.9; font-weight:700; }
      .ub-medal{ font-size:12px; }
      .ub-name{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:140px; }
      .ub-hint{ color:#4ade80; font-weight:600; font-size:12px; margin-left:8px; }
      .ub-footer{
        margin-top:8px; padding-top:6px; border-top:1px solid rgba(255,255,255,.12);
        font-size:12px; display:flex; align-items:center; justify-content:space-between; opacity:.7;
      }
      /* username hover + modal trigger */
.ub-top3-wrap{ position:relative; margin-left:6px; }
.ub-top3-icon{
  cursor:pointer; font-size:11px;
  background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.16);
  border-radius:4px; padding:0 4px; line-height:1.2;
}
.ub-top3-popup{
  position:absolute; left:50%; transform:translateX(-50%); top:120%;
  min-width:160px; background:rgba(0,0,0,.92); color:#fff;
  border:1px solid rgba(255,255,255,.16); border-radius:8px;
  box-shadow:0 10px 30px rgba(0,0,0,.7); padding:8px; font-size:11px;
  display:none; z-index:99999; white-space:normal;
}
.ub-top3-title{ font-weight:700; margin-bottom:4px; opacity:.9; }
.ub-top3-line{ display:flex; justify-content:space-between; gap:6px; }
.ub-top3-name{ max-width:110px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ub-top3-count{ color:#4ade80; font-weight:600; }
.ub-top3-wrap:hover .ub-top3-popup{ display:block; }
.db-top-drag{
  position:absolute; top:6px; left:50%; transform:translateX(-50%);
  width:44px; height:8px; border-radius:6px;
  background:rgba(255,255,255,.12); cursor:move; z-index:2;
  box-shadow:0 0 10px rgba(0,0,0,.8);
}


      #ub-status{ opacity:.88; } #ub-ver{ opacity:.75; }

    `;
    document.head.appendChild(s);
  }

  function ensureBox() {
    if (LB_BOX && LB_BOX.isConnected) return;
    injectStyles();
    LB_BOX = document.createElement('div');
    LB_BOX.id = 'username-leaderboard';
    LB_BOX.innerHTML = `
      <div id="username-leaderboard-header">
        <div class="ub-top-drag"></div>
        TRUE LEADERBOARD
      </div>
      <div id="ub-body"></div>
      <div class="ub-footer"><span id="ub-status">Starting…</span><span id="ub-ver">dev</span></div>
    `;
    document.body.appendChild(LB_BOX);
    restoreLeaderboardPos();
    LB_BODY = LB_BOX.querySelector('#ub-body');
    LB_STATUS = LB_BOX.querySelector('#ub-status');
    LB_VER = LB_BOX.querySelector('#ub-ver');
    if (LB_VER) LB_VER.textContent = UI_VER;

    const pill = LB_BOX.querySelector('.ub-top-drag');
    let dragging=false,sx=0,sy=0,ox=16,oy=16;
    function down(e){ dragging=true; const p=e.touches?e.touches[0]:e; sx=p.clientX; sy=p.clientY; const r=LB_BOX.getBoundingClientRect(); ox=r.left; oy=r.top; e.preventDefault(); }
    function move(e){ if(!dragging) return; const p=e.touches?e.touches[0]:e; const nx=Math.max(0,Math.min(innerWidth-40,  ox+(p.clientX-sx))); const ny=Math.max(0,Math.min(innerHeight-40, oy+(p.clientY-sy))); LB_BOX.style.left=nx+'px'; LB_BOX.style.top=ny+'px'; }
    function up(){ dragging=false; saveLeaderboardPos(); }
    pill.addEventListener('mousedown',down,{passive:false});
    addEventListener('mousemove',move,{passive:false});
    addEventListener('mouseup',up,{passive:true});
    pill.addEventListener('touchstart',down,{passive:false});
    addEventListener('touchmove',move,{passive:false});
    addEventListener('touchend',up,{passive:true});
  }

 function row(textLeft, rankText='-') {
  const row = document.createElement('div'); row.className = 'ub-row';
  const left = document.createElement('div'); left.className = 'ub-left';
  const rnk = document.createElement('div'); rnk.className = 'ub-rank'; rnk.textContent = rankText;
  const nm  = document.createElement('div'); nm.className = 'ub-name'; nm.textContent = textLeft;
  left.appendChild(rnk); left.appendChild(nm); row.appendChild(left);
  const right = document.createElement('div'); right.className = 'ub-hint'; right.textContent = '';
  row.appendChild(right);
  return row;
}
function restoreLeaderboardPos(){
  try{
    const saved = JSON.parse(localStorage.getItem("leaderboard_box_pos") || "{}");
    if (saved.left && saved.top && LB_BOX)
      Object.assign(LB_BOX.style, { left:saved.left, top:saved.top });
  } catch {}
}
function saveLeaderboardPos(){
  if (!LB_BOX) return;
  const snapshot = { left: LB_BOX.style.left, top: LB_BOX.style.top };
  localStorage.setItem("leaderboard_box_pos", JSON.stringify(snapshot));
}


  // replace your current render signature + top few lines
function render(players, mapping = __MAP__) {
  if (!LB_BOX?.isConnected) return;
  const map = (mapping && mapping.players) ? mapping.players : {};
  LB_BODY.replaceChildren();

  const notInGame = !location.pathname.includes('/game');
  if (notInGame) {
    LB_BODY.appendChild(row('No lobby found', '-'));
    if (LB_STATUS) LB_STATUS.textContent = 'Not in Game';
    if (LB_VER) LB_VER.textContent = UI_VER;
    return;
  }

  // filter + sort defensively (monetaryValue > 0, size > 2)
  const list = (Array.isArray(players) ? players : [])
    .filter(p => (p && (p.monetaryValue||0) > 0 && (p.size||0) > 2))
    .sort((a,b) => (b.monetaryValue||0) - (a.monetaryValue||0));

  if (list.length === 0) {
    LB_BODY.appendChild(row('No players found', '-'));
    if (LB_STATUS) LB_STATUS.textContent = '0 players online';
    if (LB_VER) LB_VER.textContent = UI_VER;
    return;
  }

  list.forEach((p, i) => {
    const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':(i+1)+'.';
    const r = document.createElement('div'); r.className = 'ub-row';
    const left = document.createElement('div'); left.className = 'ub-left';
    const ms = document.createElement('div'); ms.className = i<3?'ub-medal':'ub-rank'; ms.textContent = medal;

    const info = (p.privyId && map[p.privyId]) ? map[p.privyId] : null;
    const displayName = info?.realName ? `${info.realName} (${p.name||''})` : (p.name || `#${i+1}`);
    const nm = document.createElement('div'); nm.className = 'ub-name'; nm.textContent = displayName;

    left.appendChild(ms); left.appendChild(nm);

    // optional: little “🛈” with top usernames if available
    // after you compute `info` for the player:
if (info && Array.isArray(info.topUsernames) && info.topUsernames.length){
  const wrap = document.createElement('div'); wrap.className='ub-top3-wrap';
  const icon = document.createElement('div'); icon.className='ub-top3-icon'; icon.textContent='🛈';
  const popup = document.createElement('div'); popup.className='ub-top3-popup';
  popup.innerHTML = `<div class="ub-top3-title">Top Usernames:</div>` +
    info.topUsernames.map(u =>
      `<div class="ub-top3-line"><div class="ub-top3-name">${u.name}</div><div class="ub-top3-count">(${u.count})</div></div>`
    ).join('');
  wrap.appendChild(icon); wrap.appendChild(popup);
  icon.addEventListener('click', (e)=>{ e.stopPropagation(); showUsernameInfo(info); });
  left.appendChild(wrap);
}


    r.appendChild(left);
    const right = document.createElement('div'); right.className = 'ub-hint'; right.textContent = '';
    r.appendChild(right);
    LB_BODY.appendChild(r);
  });

  if (LB_STATUS) LB_STATUS.textContent = `${list.length} player${list.length===1?'':'s'} online`;
  if (LB_VER) LB_VER.textContent = UI_VER;
}

async function tick() {
  try {
    ensureBox();
    if (!location.pathname.includes('/game')) { render([], __MAP__); return; }
const entries = await fetchLeaderboard();
render(entries, __MAP__);

  } catch (e) {
    console.warn('[LB] tick error:', e);
    render([]);
  }
}


  function start() {
    tick();
    TICK = setInterval(tick, 5000);
  }
  function stop() {
    if (TICK) clearInterval(TICK), TICK = null;
    if (LB_BOX?.parentNode) LB_BOX.remove();
    LB_BOX = LB_BODY = LB_STATUS = LB_VER = null;
  }

  window.__USERNAME_TRACKER__ = { stop, endpoint: playersEndpoint };

  start();
})();

// ————— Username Info Modal (drop-in, unchanged styling) —————
let INFO_BOX = null, INFO_HEADER = null, INFO_BODY = null;

function createUsernameInfoBox() {
  if (INFO_BOX && INFO_BOX.isConnected) return INFO_BOX;

  const box = document.createElement("div");
  box.id = "username-info-box";
  Object.assign(box.style, {
    position: "fixed",
    zIndex: 2147483647,
    left: "16px",
    top: "16px",
    padding: "12px 14px",
    paddingTop: "19px",                  // space for the handle
    minWidth: "160px",
    fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
    fontSize: "13px",
    color: "#fff",
    background: "rgba(0, 0, 0, .65)",
    backdropFilter: "blur(6px)",
    border: "1px solid rgba(255, 255, 255, .12)",
    borderRadius: "12px",
    boxShadow: "0 6px 18px rgba(0, 0, 0, .35)",
    opacity: "1"
  });

  box.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;user-select:none;">
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 10px rgba(34,197,94,.9)"></div>
        <div id="username-info-header" style="opacity:.9;letter-spacing:.06em;font-weight:700">Unknown</div>
      </div>
      <button id="username-info-close" style="background:none;border:none;color:#fff;opacity:.7;cursor:pointer;font-size:13px;">✖</button>
    </div>
    <div id="username-info-body" style="display:grid;grid-template-columns:1fr auto;row-gap:6px;column-gap:10px;"></div>
  `;

  // drag handle (same look)
  const drag = document.createElement("div");
  drag.className = "db-top-drag";
  box.appendChild(drag);

  document.body.appendChild(box);

  // drag logic
  let dragging=false,sx=0,sy=0,ox=0,oy=0;
  function down(e){ const p=e.touches?e.touches[0]:e; dragging=true; sx=p.clientX; sy=p.clientY; const r=box.getBoundingClientRect(); ox=r.left; oy=r.top; e.preventDefault();}
  function move(e){ if(!dragging) return; const p=e.touches?e.touches[0]:e; const nx=Math.max(0,Math.min(innerWidth-40, ox+(p.clientX-sx))); const ny=Math.max(0,Math.min(innerHeight-40, oy+(p.clientY-sy))); box.style.left=nx+"px"; box.style.top=ny+"px"; }
  function up(){ dragging=false; saveInfoBoxPos(); }
  drag.addEventListener("mousedown", down);
  drag.addEventListener("touchstart", down, { passive: false });
  addEventListener("mousemove", move, { passive: false });
  addEventListener("touchmove", move, { passive: false });
  addEventListener("mouseup", up, { passive: true });
  addEventListener("touchend", up, { passive: true });

  INFO_BOX   = box;
  INFO_HEADER= box.querySelector("#username-info-header");
  INFO_BODY  = box.querySelector("#username-info-body");
  box.querySelector("#username-info-close").addEventListener("click", hideUsernameInfo);

  restoreInfoBoxPos();
  return box;
}

function restoreInfoBoxPos(){
  try{
    const saved = JSON.parse(localStorage.getItem("username_info_box_pos") || "{}");
    if (saved.left && saved.top && INFO_BOX) Object.assign(INFO_BOX.style, { left:saved.left, top:saved.top });
  } catch {}
}
function saveInfoBoxPos(){
  if (!INFO_BOX) return;
  const snapshot = { left: INFO_BOX.style.left, top: INFO_BOX.style.top };
  localStorage.setItem("username_info_box_pos", JSON.stringify(snapshot));
}

function showUsernameInfo(mapInfo){
  const box = createUsernameInfoBox();
  const headerText = mapInfo?.realName || "Unknown";
  const usernames = mapInfo?.allUsernames || mapInfo?.usernames || {};
  const sorted = Object.entries(usernames).sort((a,b)=>b[1]-a[1]).slice(0,3); // top 3 like before

  INFO_HEADER.textContent = headerText;
  INFO_BODY.replaceChildren();

  if (sorted.length === 0) {
    const none = document.createElement("div");
    none.textContent = "No usernames recorded.";
    none.style.opacity = ".7";
    none.style.gridColumn = "1 / -1";
    INFO_BODY.appendChild(none);
  } else {
    for (const [name, count] of sorted) {
      const n = document.createElement("div"); n.textContent = name;
      const c = document.createElement("div"); c.style.color = "#4ade80"; c.style.fontWeight = "700"; c.textContent = count;
      INFO_BODY.appendChild(n); INFO_BODY.appendChild(c);
    }
  }
}

function hideUsernameInfo(){
  if (!INFO_BOX || !INFO_BOX.isConnected) return;
  INFO_BOX.parentNode.removeChild(INFO_BOX);
  INFO_BOX = INFO_HEADER = INFO_BODY = null;
}

// Ensure this tiny rule exists in your injectStyles() block:
/// .db-top-drag{ position:absolute; top:6px; left:50%; transform:translateX(-50%); width:44px; height:8px; border-radius:6px; background:rgba(255,255,255,.12); cursor:move; z-index:2; }



  function parseServerId() {
    const sid = new URLSearchParams(location.search).get('serverId') || '';
    const m = sid.match(/^(us|eu)-(1|5|20)\b/i);
    if (m) return { region: m[1].toLowerCase(), amount: m[2] };
    return { region: 'us', amount: '1' }; // fallback
  }

  function playersEndpoint() {
    const { region, amount } = parseServerId();
    return `https://damnbruh-game-server-instance-${amount}-${region}.onrender.com/players`;
  }

  // replace your current fetchLeaderboard()
// replace your current fetchLeaderboard()
async function fetchLeaderboard() {
  const { serverKey } = resolveServerKey();
  const url = `${GAME_API_BASE}/api/game/leaderboard?serverKey=${encodeURIComponent(serverKey)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('leaderboard ' + res.status);
  const j = await res.json();
  const entries = Array.isArray(j.entries) ? j.entries : [];

  // safety filter client-side too
  const filtered = entries.filter(p =>
    (p && p.name) &&
    (p.monetaryValue || 0) > 0 &&
    (p.size || 0) > 2
  );

  // highest to lowest monetaryValue
  filtered.sort((a, b) => (b.monetaryValue || 0) - (a.monetaryValue || 0));
  return filtered;
}

// add this helper
// add this helper
async function fetchMapping() {
  const res = await fetch(`${USER_API_BASE}/mapping`, { cache: 'no-store' });
  if (!res.ok) return { players: {} };
  const j = await res.json().catch(() => ({}));
  return j && j.players ? j : { players: {} };
}



async function fetchFilteredSortedList() {
  var sk = resolveServerKey();

  // 1) aggregator
  try {
    var aggUrl = GAME_API_BASE + '/api/game/leaderboard?serverKey=' + encodeURIComponent(sk.serverKey);
    var res = await fetch(aggUrl, { cache: 'no-store' });
    if (res.ok) {
      var j = await res.json();
      var arr = Array.isArray(j.entries) ? j.entries : [];
      var list = normalizeFilterSort(arr);
      if (list.length > 0) return list;
    }
  } catch (e1) {}

  // 2) fallback to live shard /players
  try {
    var rawUrl = 'https://damnbruh-game-server-instance-' + sk.amount + '-' + sk.region + '.onrender.com/players';
    var r2 = await fetch(rawUrl, { cache: 'no-store' });
    if (r2.ok) {
      var body = await r2.json();
      var base = Array.isArray(body) ? body : (Array.isArray(body.players) ? body.players : []);
      return normalizeFilterSort(base);
    }
  } catch (e2) {}

  return [];
}


// poll mapping on its own cadence
setInterval(async () => {
  try { __MAP__ = await fetchMapping(); } catch {}
}, 7000);

  function injectStyles() {
    if (document.getElementById('dbk-styles-usernames')) return;
    const s = document.createElement('style');
    s.id = 'dbk-styles-usernames';
    s.textContent = `
      #username-leaderboard {
        position: fixed; z-index: 2147483646; left: 16px; top: 16px;
        width: 220px; color: #fff; background: rgba(0,0,0,.75);
        border: 1px solid rgba(255,255,255,.12); border-radius: 12px;
        box-shadow: 0 6px 18px rgba(0,0,0,.35);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 13px; line-height: 1.35; padding: 10px 12px 8px; backdrop-filter: blur(6px);
      }
      #username-leaderboard-header {
        position:relative; padding-top:14px; text-align:left; font-weight:700;
        letter-spacing:.06em; margin-bottom:8px; padding-left:28px;
      }
      #username-leaderboard-header::before {
        content:''; position:absolute; width:10px; height:10px; left:5px; top:17.5px;
        background:#22c55e; border-radius:50%; box-shadow:0 0 6px #22c55e;
      }
      .ub-top-drag {
        width:44px; position:absolute; top:-1px; left:50%; transform:translateX(-50%);
        height:8px; border-radius:6px; background:rgba(255,255,255,.12); cursor:move;
        box-shadow:0 0 10px rgba(0,0,0,.8);
      }
      .ub-row { display:flex; align-items:center; justify-content:space-between; padding:4px 0;
        border-top:1px solid rgba(255,255,255,.08); }
      .ub-row:first-of-type{ border-top:none; }
      .ub-left { display:flex; align-items:center; gap:6px; min-width:0; }
      .ub-rank{ color:#fff; opacity:.9; font-weight:700; }
      .ub-medal{ font-size:12px; }
      .ub-name{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:140px; }
      .ub-hint{ color:#4ade80; font-weight:600; font-size:12px; margin-left:8px; }
      .ub-footer{
        margin-top:8px; padding-top:6px; border-top:1px solid rgba(255,255,255,.12);
        font-size:12px; display:flex; align-items:center; justify-content:space-between; opacity:.7;
      }
      /* username hover + modal trigger */
.ub-top3-wrap{ position:relative; margin-left:6px; }
.ub-top3-icon{
  cursor:pointer; font-size:11px;
  background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.16);
  border-radius:4px; padding:0 4px; line-height:1.2;
}
.ub-top3-popup{
  position:absolute; left:50%; transform:translateX(-50%); top:120%;
  min-width:160px; background:rgba(0,0,0,.92); color:#fff;
  border:1px solid rgba(255,255,255,.16); border-radius:8px;
  box-shadow:0 10px 30px rgba(0,0,0,.7); padding:8px; font-size:11px;
  display:none; z-index:99999; white-space:normal;
}
.ub-top3-title{ font-weight:700; margin-bottom:4px; opacity:.9; }
.ub-top3-line{ display:flex; justify-content:space-between; gap:6px; }
.ub-top3-name{ max-width:110px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ub-top3-count{ color:#4ade80; font-weight:600; }
.ub-top3-wrap:hover .ub-top3-popup{ display:block; }
.db-top-drag{
  position:absolute; top:6px; left:50%; transform:translateX(-50%);
  width:44px; height:8px; border-radius:6px;
  background:rgba(255,255,255,.12); cursor:move; z-index:2;
  box-shadow:0 0 10px rgba(0,0,0,.8);
}


      #ub-status{ opacity:.88; } #ub-ver{ opacity:.75; }
      .db-alert-toast{position:fixed;left:50%;top:18px;transform:translateX(-50%);padding:10px 14px;background:rgba(0,0,0,.85);color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:10px;backdrop-filter:blur(6px);z-index:2147483647;font:13px ui-monospace;}
.db-alert-toast.hide{opacity:0;transition:opacity .45s ease;}


    `;
    document.head.appendChild(s);
  }

  function ensureBox() {
    if (LB_BOX && LB_BOX.isConnected) return;
    injectStyles();
    LB_BOX = document.createElement('div');
    LB_BOX.id = 'username-leaderboard';
    LB_BOX.innerHTML = `
      <div id="username-leaderboard-header">
        <div class="ub-top-drag"></div>
        TRUE LEADERBOARD
      </div>
      <div id="ub-body"></div>
      <div class="ub-footer"><span id="ub-status">Starting…</span><span id="ub-ver">dev</span></div>
    `;
    document.body.appendChild(LB_BOX);
    restoreLeaderboardPos();
    LB_BODY = LB_BOX.querySelector('#ub-body');
    LB_STATUS = LB_BOX.querySelector('#ub-status');
    LB_VER = LB_BOX.querySelector('#ub-ver');
    if (LB_VER) LB_VER.textContent = UI_VER;

    const pill = LB_BOX.querySelector('.ub-top-drag');
    let dragging=false,sx=0,sy=0,ox=16,oy=16;
    function down(e){ dragging=true; const p=e.touches?e.touches[0]:e; sx=p.clientX; sy=p.clientY; const r=LB_BOX.getBoundingClientRect(); ox=r.left; oy=r.top; e.preventDefault(); }
    function move(e){ if(!dragging) return; const p=e.touches?e.touches[0]:e; const nx=Math.max(0,Math.min(innerWidth-40,  ox+(p.clientX-sx))); const ny=Math.max(0,Math.min(innerHeight-40, oy+(p.clientY-sy))); LB_BOX.style.left=nx+'px'; LB_BOX.style.top=ny+'px'; }
    function up(){ dragging=false; saveLeaderboardPos(); }
    pill.addEventListener('mousedown',down,{passive:false});
    addEventListener('mousemove',move,{passive:false});
    addEventListener('mouseup',up,{passive:true});
    pill.addEventListener('touchstart',down,{passive:false});
    addEventListener('touchmove',move,{passive:false});
    addEventListener('touchend',up,{passive:true});
  }

 function row(textLeft, rankText='-') {
  const row = document.createElement('div'); row.className = 'ub-row';
  const left = document.createElement('div'); left.className = 'ub-left';
  const rnk = document.createElement('div'); rnk.className = 'ub-rank'; rnk.textContent = rankText;
  const nm  = document.createElement('div'); nm.className = 'ub-name'; nm.textContent = textLeft;
  left.appendChild(rnk); left.appendChild(nm); row.appendChild(left);
  const right = document.createElement('div'); right.className = 'ub-hint'; right.textContent = '';
  row.appendChild(right);
  return row;
}
function restoreLeaderboardPos(){
  try{
    const saved = JSON.parse(localStorage.getItem("leaderboard_box_pos") || "{}");
    if (saved.left && saved.top && LB_BOX)
      Object.assign(LB_BOX.style, { left:saved.left, top:saved.top });
  } catch {}
}
function saveLeaderboardPos(){
  if (!LB_BOX) return;
  const snapshot = { left: LB_BOX.style.left, top: LB_BOX.style.top };
  localStorage.setItem("leaderboard_box_pos", JSON.stringify(snapshot));
}


  // replace your current render signature + top few lines
function render(players, mapping = __MAP__) {
  if (!LB_BOX?.isConnected) return;
  const map = (mapping && mapping.players) ? mapping.players : {};
  LB_BODY.replaceChildren();

  const notInGame = !location.pathname.includes('/game');
  if (notInGame) {
    LB_BODY.appendChild(row('No lobby found', '-'));
    if (LB_STATUS) LB_STATUS.textContent = 'Not in Game';
    if (LB_VER) LB_VER.textContent = UI_VER;
    return;
  }

  // filter + sort defensively (monetaryValue > 0, size > 2)
  const list = (Array.isArray(players) ? players : [])
    .filter(p => (p && (p.monetaryValue||0) > 0 && (p.size||0) > 2))
    .sort((a,b) => (b.monetaryValue||0) - (a.monetaryValue||0));

  if (list.length === 0) {
    LB_BODY.appendChild(row('No players found', '-'));
    if (LB_STATUS) LB_STATUS.textContent = '0 players online';
    if (LB_VER) LB_VER.textContent = UI_VER;
    return;
  }

  list.forEach((p, i) => {
    const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':(i+1)+'.';
    const r = document.createElement('div'); r.className = 'ub-row';
    const left = document.createElement('div'); left.className = 'ub-left';
    const ms = document.createElement('div'); ms.className = i<3?'ub-medal':'ub-rank'; ms.textContent = medal;

    const info = (p.privyId && map[p.privyId]) ? map[p.privyId] : null;
    const displayName = info?.realName ? `${info.realName} (${p.name||''})` : (p.name || `#${i+1}`);
    const nm = document.createElement('div'); nm.className = 'ub-name'; nm.textContent = displayName;

    left.appendChild(ms); left.appendChild(nm);

    // optional: little “🛈” with top usernames if available
    // after you compute `info` for the player:
if (info && Array.isArray(info.topUsernames) && info.topUsernames.length){
  const wrap = document.createElement('div'); wrap.className='ub-top3-wrap';
  const icon = document.createElement('div'); icon.className='ub-top3-icon'; icon.textContent='🛈';
  const popup = document.createElement('div'); popup.className='ub-top3-popup';
  popup.innerHTML = `<div class="ub-top3-title">Top Usernames:</div>` +
    info.topUsernames.map(u =>
      `<div class="ub-top3-line"><div class="ub-top3-name">${u.name}</div><div class="ub-top3-count">(${u.count})</div></div>`
    ).join('');
  wrap.appendChild(icon); wrap.appendChild(popup);
  icon.addEventListener('click', (e)=>{ e.stopPropagation(); showUsernameInfo(info); });
  left.appendChild(wrap);
}


    r.appendChild(left);
    const right = document.createElement('div'); right.className = 'ub-hint'; right.textContent = '';
    r.appendChild(right);
    LB_BODY.appendChild(r);
  });

  if (LB_STATUS) LB_STATUS.textContent = `${list.length} player${list.length===1?'':'s'} online`;
  if (LB_VER) LB_VER.textContent = UI_VER;
}

async function tick() {
  try {
    ensureBox();
    if (!location.pathname.includes('/game')) { render([], __MAP__); return; }
const entries = await fetchLeaderboard();
render(entries, __MAP__);

  } catch (e) {
    console.warn('[LB] tick error:', e);
    render([]);
  }
}


  function start() {
    tick();
    TICK = setInterval(tick, 5000);
  }
  function stop() {
    if (TICK) clearInterval(TICK), TICK = null;
    if (LB_BOX?.parentNode) LB_BOX.remove();
    LB_BOX = LB_BODY = LB_STATUS = LB_VER = null;
  }

  window.__USERNAME_TRACKER__ = { stop, endpoint: playersEndpoint };

  start();
})();
