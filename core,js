// DamnBruh Username Tracker CORE
// Runs after the base userscript validates and loads it.

(() => {
  // Allow hot-reload style restart
  if (window.__USERNAME_TRACKER__) {
    try { window.__USERNAME_TRACKER__.stop?.(); } catch {}
    delete window.__USERNAME_TRACKER__;
  }
  if (window.__USERNAME_TRACKER_FLUSH__) {
    clearInterval(window.__USERNAME_TRACKER_FLUSH__);
  }

  // ==============================
  // CONFIG  (same as your script)
  // ==============================
  const USER_API_BASE = 'https://dbserver-8bhx.onrender.com/api/user';
  const GAME_REGION = 'us';
  const GAME_AMOUNT = 1;
  const PLAYERS_URL = `https://damnbruh-game-server-instance-${GAME_AMOUNT}-${GAME_REGION}.onrender.com/players`;
  const POLL_MS = 3000;

  const LS_BOX_POS_KEY = 'username_hud_pos_v1';
  const HUB_STATE_KEY = 'slither_hub_state_v4';
  const TM_KEY_SLOT = 'username_script_key';

  // store joins locally between flushes
  const localJoinBuffer = new Map(); // privyId::name -> count

  // mapping small cache
  let lastGoodMapping = null;
  let lastMappingTime = 0;
  const CACHE_TTL_MS = 30000;

  // ==============================
  // HELPERS (kept as-is)
  // ==============================
  const hasTM = (typeof GM_getValue === 'function' && typeof GM_setValue === 'function');

  const KeyStore = {
    get() {
      try {
        if (hasTM) {
          const k = GM_getValue(TM_KEY_SLOT, null);
          if (typeof k === 'string' && k.trim()) return k.trim();
        }
      } catch {}

      try {
        const hub = localStorage.getItem(HUB_STATE_KEY);
        if (hub) {
          const o = JSON.parse(hub);
          const k = o?.appKeys?.usernameKey;
          if (typeof k === 'string' && k.trim()) return k.trim();
        }
      } catch {}

      try {
        const raw = localStorage.getItem('damnbruh_username_keys');
        if (raw) {
          const o = JSON.parse(raw);
          const k = o?.username_script_key;
          if (typeof k === 'string' && k.trim()) return k.trim();
        }
      } catch {}

      return null;
    },
    set(key) {
      try { if (hasTM) GM_setValue(TM_KEY_SLOT, key); } catch {}

      try {
        const hubRaw = localStorage.getItem(HUB_STATE_KEY);
        const hubObj = hubRaw ? (JSON.parse(hubRaw) || {}) : {};
        hubObj.appKeys = hubObj.appKeys || {};
        hubObj.appKeys.usernameKey = key;
        localStorage.setItem(HUB_STATE_KEY, JSON.stringify(hubObj));
      } catch {}

      try {
        const raw = localStorage.getItem('damnbruh_username_keys');
        const cur = raw ? (JSON.parse(raw) || {}) : {};
        cur.username_script_key = key;
        localStorage.setItem('damnbruh_username_keys', JSON.stringify(cur));
      } catch {}
    },
    clear() {
      try { if (hasTM) GM_deleteValue(TM_KEY_SLOT); } catch {}

      try {
        const hubRaw = localStorage.getItem(HUB_STATE_KEY);
        if (hubRaw) {
          const hubObj = JSON.parse(hubRaw) || {};
          if (hubObj.appKeys) delete hubObj.appKeys.usernameKey;
          localStorage.setItem(HUB_STATE_KEY, JSON.stringify(hubObj));
        }
      } catch {}

      try {
        const raw = localStorage.getItem('damnbruh_username_keys');
        if (raw) {
          const o = JSON.parse(raw) || {};
          delete o.username_script_key;
          localStorage.setItem('damnbruh_username_keys', JSON.stringify(o));
        }
      } catch {}
    }
  };

  function getGameServerInfo() {
    try {
      const params = new URLSearchParams(location.search);
      const serverId = params.get("serverId") || "";
      const parts = serverId.split("-");
      if (parts.length >= 2) return { region: parts[0], lobby: parts[1] };
    } catch (e) {
      console.warn("getGameServerInfo failed:", e);
    }
    return { region: null, lobby: null };
  }

  function postJSON(url, data, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const body = JSON.stringify(data || {});
      if (typeof GM_xmlhttpRequest === 'function') {
        const t = setTimeout(() => resolve({ ok:false, status:0, json:null, error:'timeout' }), timeoutMs);
        GM_xmlhttpRequest({
          method: 'POST',
          url, data: body,
          headers: { 'Content-Type': 'application/json' },
          onload: (res) => {
            clearTimeout(t);
            let j=null; try { j = JSON.parse(res.responseText||'null'); } catch {}
            resolve({ ok: res.status>=200 && res.status<300, status: res.status, json:j, error:null });
          },
          onerror: () => { clearTimeout(t); resolve({ ok:false, status:0, json:null, error:'network' }); },
          ontimeout: () => { clearTimeout(t); resolve({ ok:false, status:0, json:null, error:'timeout' }); }
        });
        return;
      }
      let to=null;
      const ctrl = typeof AbortController!=='undefined' ? new AbortController() : null;
      if (ctrl) to = setTimeout(()=>ctrl.abort(), timeoutMs);
      fetch(url, {
        method:'POST', headers:{'Content-Type':'application/json'}, body,
        signal: ctrl?ctrl.signal:undefined
      })
      .then(async r=>{ if (to) clearTimeout(to); let j=null; try { j = await r.json(); } catch{}; resolve({ ok:r.ok, status:r.status, json:j, error:null }); })
      .catch(e=>{ if (to) clearTimeout(to); resolve({ ok:false,status:0,json:null, error:String(e && e.name==='AbortError'?'timeout':'network') }); });
    });
  }

  // ==============================
  // UI/STYLES (copied)
  // ==============================
  function injectStyles() {
    if (document.getElementById('dbk-styles-usernames')) return;
    const s = document.createElement('style');
    s.id = 'dbk-styles-usernames';
    s.textContent = `
      /* key styles removed in core: only app HUD below */
      #username-leaderboard {
        position: fixed; z-index: 2147483646; left: 16px; top: 16px;
        width: 220px; max-width: 220px; min-width: 220px; overflow: hidden;
        color: #fff; background: rgba(0, 0, 0, .75); border: 1px solid rgba(255, 255, 255, .12);
        border-radius: 12px; box-shadow: 0 6px 18px rgba(0, 0, 0, .35);
        font-family: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
        font-size: 13px; line-height: 1.35; padding: 10px 12px 8px; backdrop-filter: blur(6px);
      }
      #username-leaderboard-header { position:relative; padding-top:14px; text-align:left; font-weight:700;
        letter-spacing:.06em; margin-bottom:8px; padding-left:28px; }
      #username-leaderboard-header::before { content:''; position:absolute; width:10px; height:10px; left:5px; top:17.5px;
        background:#22c55e; border-radius:50%; box-shadow:0 0 6px #22c55e; }
      #username-leaderboard .ub-top-drag{
        width:220px; max-width:220px; overflow:hidden; position:absolute; top:-1px; left:50%; transform:translateX(-50%);
        height:8px; border-radius:6px; background:rgba(255,255,255,.12); cursor:move; box-shadow:0 0 10px rgba(0,0,0,.8);
      }
      .ub-row{ display:flex; align-items:center; justify-content:space-between; padding:4px 0;
        border-top:1px solid rgba(255,255,255,.08); }
      .ub-row:first-of-type{ border-top:none; }
      .ub-left{ flex-shrink:1; min-width:0; display:flex; align-items:center; gap:6px; font-weight:500; color:#fff;
        text-shadow:0 1px 2px rgba(0,0,0,.7); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .ub-rank{ color:#fff; opacity:.9; font-weight:700; }
      .ub-medal{ font-size:12px; }
      .ub-name{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:140px; }
      .ub-hint{ color:#4ade80; font-weight:600; font-size:12px; margin-left:8px; flex-shrink:0; text-shadow:0 1px 2px rgba(0,0,0,.8); }
      .ub-footer{ margin-top:8px; padding-top:6px; border-top:1px solid rgba(255,255,255,.12); font-size:12px; text-align:center; opacity:.7; }

      .ub-top3-wrap{ position:relative; }
      .ub-top3-icon{ cursor:default; font-size:11px; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.16);
        border-radius:4px; padding:0px 4px; line-height:1.2; box-shadow:0 4px 10px rgba(0,0,0,.5); }
      .ub-top3-popup{ position:absolute; z-index:99999; left:50%; transform:translateX(-50%); top:120%; min-width:160px;
        background:rgba(0,0,0,0.92); color:#fff; border:1px solid rgba(255,255,255,0.16); border-radius:8px;
        box-shadow:0 10px 30px rgba(0,0,0,0.7); padding:8px; font-size:11px; line-height:1.3; display:none; white-space:normal;
        opacity:0; transition:opacity .15s ease; }
      .ub-top3-popup .ub-top3-title{ font-weight:700; margin-bottom:4px; opacity:.9; }
      .ub-top3-line{ display:flex; justify-content:space-between; gap:6px; }
      .ub-top3-name{ color:#fff; max-width:110px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .ub-top3-count{ color:#4ade80; font-weight:600; }
      .ub-top3-wrap:hover .ub-top3-popup{ display:block; opacity:1; }

      /* username info box */
      .db-top-drag{ position:absolute; top:6px; left:50%; transform:translateX(-50%); width:44px; height:8px; border-radius:6px;
        background:rgba(255,255,255,.12); cursor:move; z-index:2; }
    `;
    document.head.appendChild(s);
  }

  function onBodyReady(fn){
    if (document.body) return fn();
    const obs = new MutationObserver(() => {
      if (document.body) { obs.disconnect(); fn(); }
    });
    obs.observe(document.documentElement, { childList:true, subtree:true });
  }

  // ==============================
  // Username info modal (same as your script)
  // ==============================
  let INFO_BOX = null, INFO_HEADER = null, INFO_BODY = null;

  function createUsernameInfoBox() {
    if (INFO_BOX && INFO_BOX.isConnected) return INFO_BOX;
    const box = document.createElement("div");
    box.id = "username-info-box";
    Object.assign(box.style, {
      position:"fixed", zIndex:2147483647, left:"16px", top:"16px",
      padding:"12px 14px", paddingTop:"19px", minWidth:"160px",
      fontFamily:'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
      fontSize:"13px", color:"#fff", background:"rgba(0,0,0,.65)", backdropFilter:"blur(6px)",
      border:"1px solid rgba(255,255,255,.12)", borderRadius:"12px",
      boxShadow:"0 6px 18px rgba(0,0,0,.35)", opacity:"0", transition:"opacity .25s ease",
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
    document.body.appendChild(box);

    const drag = document.createElement("div");
    drag.className = "db-top-drag";
    box.appendChild(drag);

    let dragging=false,sx=0,sy=0,ox=0,oy=0;
    function down(e){ const p=e.touches?e.touches[0]:e; dragging=true; sx=p.clientX; sy=p.clientY; const r=box.getBoundingClientRect(); ox=r.left; oy=r.top; e.preventDefault();}
    function move(e){ if(!dragging) return; const p=e.touches?e.touches[0]:e; const nx=Math.max(0,Math.min(window.innerWidth-40, ox+(p.clientX-sx))); const ny=Math.max(0,Math.min(window.innerHeight-40, oy+(p.clientY-sy))); box.style.left=nx+"px"; box.style.top=ny+"px"; }
    function up(){ dragging=false; saveInfoBoxPos(); }
    drag.addEventListener("mousedown", down);
    drag.addEventListener("touchstart", down, { passive: false });
    window.addEventListener("mousemove", move, { passive: false });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("mouseup", up);
    window.addEventListener("touchend", up);

    INFO_BOX = box;
    INFO_HEADER = box.querySelector("#username-info-header");
    INFO_BODY = box.querySelector("#username-info-body");
    box.querySelector("#username-info-close").addEventListener("click", () => hideUsernameInfo());

    restoreInfoBoxPos();
    requestAnimationFrame(() => (box.style.opacity = "1"));
    return box;
  }
  function restoreInfoBoxPos(){ try{ const saved = JSON.parse(localStorage.getItem("username_info_box_pos") || "{}"); if (saved.left && saved.top) Object.assign(INFO_BOX.style, { left:saved.left, top:saved.top }); } catch {} }
  function saveInfoBoxPos(){ if (!INFO_BOX) return; const snapshot = { left: INFO_BOX.style.left, top: INFO_BOX.style.top }; localStorage.setItem("username_info_box_pos", JSON.stringify(snapshot)); }
  function showUsernameInfo(mapInfo) {
    const box = createUsernameInfoBox();
    const headerText = mapInfo?.realName || "Unknown";
    const usernames = mapInfo?.allUsernames || mapInfo?.usernames || {};
    const sorted = Object.entries(usernames).sort((a,b)=>b[1]-a[1]).slice(0,3);
    INFO_HEADER.style.opacity = "0"; INFO_BODY.style.opacity = "0";
    setTimeout(() => {
      INFO_HEADER.textContent = headerText;
      INFO_BODY.replaceChildren();
      if (sorted.length === 0) {
        const none = document.createElement("div");
        none.textContent = "No usernames recorded.";
        none.style.opacity = ".7"; none.style.gridColumn = "1 / -1";
        INFO_BODY.appendChild(none);
      } else {
        for (const [name, count] of sorted) {
          const n = document.createElement("div"); n.textContent = name;
          const c = document.createElement("div"); c.style.color = "#4ade80"; c.style.fontWeight = "700"; c.textContent = count;
          INFO_BODY.appendChild(n); INFO_BODY.appendChild(c);
        }
      }
      INFO_HEADER.style.opacity = "1"; INFO_BODY.style.opacity = "1";
    }, 120);
  }
  function hideUsernameInfo() {
    if (!INFO_BOX || !INFO_BOX.isConnected) return;
    INFO_BOX.style.opacity = "0"; setTimeout(() => { if (INFO_BOX?.parentNode) INFO_BOX.parentNode.removeChild(INFO_BOX); INFO_BOX = null; }, 250);
  }

  // ==============================
  // Leaderboard UI
  // ==============================
  let LB_BOX = null, LB_BODY_WRAP = null, LB_FOOTER = null;

  function rememberBoxPosition(box) {
    try {
      const saved = JSON.parse(localStorage.getItem(LS_BOX_POS_KEY) || '{}');
      if (saved.left && saved.top) Object.assign(box.style, { left: saved.left, top: saved.top });
    } catch {}
    function save() {
      try {
        const snapshot = { left: box.style.left, top: box.style.top };
        localStorage.setItem(LS_BOX_POS_KEY, JSON.stringify(snapshot));
        const hubRaw = localStorage.getItem(HUB_STATE_KEY);
        const hub = hubRaw ? JSON.parse(hubRaw) : {};
        hub.appKeys = hub.appKeys || {};
        hub.appKeys.usernameHudPos = snapshot;
        localStorage.setItem(HUB_STATE_KEY, JSON.stringify(hub));
      } catch {}
    }
    window.addEventListener('mouseup', save);
    window.addEventListener('touchend', save);
    box.__savePos = save;
  }

  function ensureLeaderboardBox() {
    if (LB_BOX && LB_BOX.isConnected) return LB_BOX;
    injectStyles();
    LB_BOX = document.createElement('div');
    LB_BOX.id = 'username-leaderboard';
    LB_BOX.innerHTML = `
      <div id="username-leaderboard-header">
        <div class="ub-top-drag"></div>
        TRUE LEADERBOARD
      </div>
      <div id="ub-body"></div>
      <div class="ub-footer" id="ub-footer"></div>
    `;
    onBodyReady(()=>document.body.appendChild(LB_BOX));
    LB_BODY_WRAP = LB_BOX.querySelector('#ub-body');
    LB_FOOTER = LB_BOX.querySelector('#ub-footer');

    const pill = LB_BOX.querySelector('.ub-top-drag');
    let dragging=false,sx=0,sy=0,ox=16,oy=16;
    function down(e){ dragging=true; const p=e.touches?e.touches[0]:e; sx=p.clientX; sy=p.clientY; const r=LB_BOX.getBoundingClientRect(); ox=r.left; oy=r.top; e.preventDefault(); }
    function move(e){ if(!dragging) return; const p=e.touches?e.touches[0]:e; const nx=Math.max(0,Math.min(window.innerWidth-40,  ox+(p.clientX-sx))); const ny=Math.max(0,Math.min(window.innerHeight-40, oy+(p.clientY-sy))); LB_BOX.style.left=nx+'px'; LB_BOX.style.top=ny+'px'; }
    function up(){ dragging=false; if (LB_BOX && LB_BOX.__savePos) LB_BOX.__savePos(); }
    pill.addEventListener('mousedown',down,{passive:false});
    window.addEventListener('mousemove',move,{passive:false});
    window.addEventListener('mouseup',up,{passive:true});
    pill.addEventListener('touchstart',down,{passive:false});
    window.addEventListener('touchmove',move,{passive:false});
    window.addEventListener('touchend',up,{passive:true});

    rememberBoxPosition(LB_BOX);
    return LB_BOX;
  }

  function renderLeaderboard(playersSorted, mapping) {
    if (!LB_BOX || !LB_BOX.isConnected) return;
    LB_BODY_WRAP.replaceChildren();
    const isOutOfGame = !location.href.includes("/game");

    if (isOutOfGame) {
      const row = document.createElement("div"); row.className = "ub-row";
      const left = document.createElement("div"); left.className = "ub-left";
      const rank = document.createElement("div"); rank.className = "ub-rank"; rank.textContent = "-";
      const name = document.createElement("div"); name.className = "ub-name"; name.textContent = "No lobby found";
      left.appendChild(rank); left.appendChild(name); row.appendChild(left); LB_BODY_WRAP.appendChild(row);
      if (LB_FOOTER) LB_FOOTER.textContent = "Not in Game";
      return;
    }

    if (!playersSorted || playersSorted.length === 0) {
      const row = document.createElement("div"); row.className = "ub-row";
      const left = document.createElement("div"); left.className = "ub-left";
      const rank = document.createElement("div"); rank.className = "ub-rank"; rank.textContent = "-";
      const name = document.createElement("div"); name.className = "ub-name"; name.textContent = "No players found";
      left.appendChild(rank); left.appendChild(name); row.appendChild(left); LB_BODY_WRAP.appendChild(row);
      if (LB_FOOTER) LB_FOOTER.textContent = "0 players online";
      return;
    }

    playersSorted.forEach((p, idx) => {
      const rank = idx + 1;
      const mapInfo = mapping.players?.[p.privyId] || null;
      const realName = mapInfo?.realName || null;
      const topUsernames = mapInfo?.topUsernames || [];
      if (!p.name || (p.monetaryValue || 0) <= 0) return;

      const dispName = realName ? `${realName} (${p.name})` : p.name;
      let medalHTML = ""; if (rank === 1) medalHTML = "🥇"; else if (rank === 2) medalHTML = "🥈"; else if (rank === 3) medalHTML = "🥉"; else medalHTML = rank + ".";

      let hoverWrap = null;
      if (topUsernames.length > 0) {
        hoverWrap = document.createElement("div"); hoverWrap.className = "ub-top3-wrap";
        const icon = document.createElement("div"); icon.className = "ub-top3-icon"; icon.textContent = "🛈";
        icon.addEventListener("click", (e) => { e.stopPropagation(); showUsernameInfo(mapInfo); });
        const popup = document.createElement("div"); popup.className = "ub-top3-popup";
        const title = document.createElement("div"); title.className = "ub-top3-title"; title.textContent = "Top Usernames:";
        popup.appendChild(title);
        topUsernames.forEach(({ name, count }) => {
          const line = document.createElement("div"); line.className = "ub-top3-line";
          const nm = document.createElement("div"); nm.className = "ub-top3-name"; nm.textContent = name;
          const ct = document.createElement("div"); ct.className = "ub-top3-count"; ct.textContent = `(${count})`;
          line.appendChild(nm); line.appendChild(ct); popup.appendChild(line);
        });
        hoverWrap.appendChild(icon); hoverWrap.appendChild(popup);
      }

      const row = document.createElement("div"); row.className = "ub-row";
      const left = document.createElement("div"); left.className = "ub-left";
      const medalSpan = document.createElement("div"); medalSpan.className = rank <= 3 ? "ub-medal" : "ub-rank"; medalSpan.textContent = medalHTML;
      const nameSpan = document.createElement("div"); nameSpan.className = "ub-name"; nameSpan.textContent = dispName;
      left.appendChild(medalSpan); left.appendChild(nameSpan); if (hoverWrap) left.appendChild(hoverWrap);
      const right = document.createElement("div"); right.className = "ub-hint"; right.textContent = "";
      row.appendChild(left); row.appendChild(right); LB_BODY_WRAP.appendChild(row);
    });

    LB_FOOTER.textContent = `${playersSorted.length} player${playersSorted.length === 1 ? "" : "s"} online`;
  }

  // ==============================
  // Polling + Merge Logic
  // ==============================
  window.__USERNAME_TRACKER_FLUSH__ = setInterval(() => {
    if (localJoinBuffer.size === 0) return;
    const payload = [];
    for (const [key, count] of localJoinBuffer.entries()) {
      const [privyId, name] = key.split("::");
      payload.push({ privyId, name, count });
    }
    postJSON(USER_API_BASE + '/batchTrackJoin', { players: payload }).catch(()=>{});
    localJoinBuffer.clear();
  }, 60000);

  async function fetchPlayers() {
    try {
      const { region, lobby } = getGameServerInfo();
      const activeUrl = (region && lobby)
        ? `https://damnbruh-game-server-instance-${lobby}-${region}.onrender.com/players`
        : PLAYERS_URL;
      const res = await fetch(activeUrl, { cache: "no-store" });
      if (!res.ok) throw new Error("players " + res.status);
      const data = await res.json();
      const players = Array.isArray(data.players) ? data.players.slice() : [];
      players.forEach((pl) => {
        if (!pl.privyId || !pl.name) return;
        const key = pl.privyId + "::" + pl.name;
        const prev = localJoinBuffer.get(key) || 0;
        localJoinBuffer.set(key, prev + 1);
      });
      return players;
    } catch (e) {
      console.warn("fetchPlayers failed:", e);
      return [];
    }
  }

  async function fetchMapping() {
    try {
      const res = await fetch(USER_API_BASE + '/mapping', { cache: 'no-store' });
      if (!res.ok) throw new Error('mapping ' + res.status);
      const data = await res.json();
      if (data && data.players && Object.keys(data.players).length > 0) {
        lastGoodMapping = data; lastMappingTime = Date.now(); return data;
      }
      if (lastGoodMapping && Date.now() - lastMappingTime < CACHE_TTL_MS) {
        console.warn("⚠️ using cached mapping (empty response)");
        return lastGoodMapping;
      }
      throw new Error("empty mapping, no cache");
    } catch (e) {
      if (lastGoodMapping && Date.now() - lastMappingTime < CACHE_TTL_MS) {
        console.warn("⚠️ using cached mapping (fetch failed)", e);
        return lastGoodMapping;
      }
      console.warn('fetchMapping failed:', e);
      return { ok:false, players:{} };
    }
  }

  async function pollAndRender() {
    const [playersRaw, mapping] = await Promise.all([ fetchPlayers(), fetchMapping() ]);
    const filtered = playersRaw.filter(p => (p.monetaryValue || 0) > 0);
    const sorted = filtered.slice().sort((a,b) => (b.monetaryValue||0) - (a.monetaryValue||0));
    ensureLeaderboardBox();
    renderLeaderboard(sorted, mapping);
  }

  let pollTimer = null;
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollAndRender, POLL_MS);
    pollAndRender();
  }
  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null; checkAlerts(); // kept exactly as in your script
    }
  }

  // ==============================
  // 🔔 Alert poller (one-time display per ID)
  // ==============================
  const ALERT_API = "https://dbserver-8bhx.onrender.com/api/user/alerts";
  let seenAlerts = new Set(JSON.parse(localStorage.getItem("db_seen_alerts") || "[]"));

  function markAlertSeen(id) {
    if (!id) return;
    seenAlerts.add(id);
    try { localStorage.setItem("db_seen_alerts", JSON.stringify([...seenAlerts])); } catch{}
  }

  function showAlertBox(message) {
    const old = document.getElementById("db-alert-box"); if (old) old.remove();
    const box = document.createElement("div");
    box.id = "db-alert-box";
    Object.assign(box.style, {
      position: "fixed", bottom: "30px", right: "30px", width: "320px", minHeight: "100px",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.9)", border: "3px solid #FFD700", color: "#FFD700",
      fontFamily: "ui-monospace, monospace", fontSize: "16px", textAlign: "center",
      padding: "18px 22px", borderRadius: "12px", boxShadow: "0 0 30px rgba(255,215,0,0.6)",
      zIndex: 2147483647, opacity: "0", transform: "translateY(20px)",
      transition: "opacity 0.4s ease, transform 0.4s ease"
    });
    box.innerHTML = `
      <div style="font-weight:700;font-size:18px;margin-bottom:6px;">ALERT:</div>
      <div style="font-weight:600;font-size:15px;line-height:1.4;">${message}</div>
    `;
    document.body.appendChild(box);
    requestAnimationFrame(() => { box.style.opacity = "1"; box.style.transform = "translateY(0)"; });
    setTimeout(() => { box.style.opacity = "0"; box.style.transform = "translateY(20px)"; setTimeout(() => box.remove(), 400); }, 7000);
  }

  async function checkAlerts() {
    const USER_KEY = KeyStore.get();
    if (!USER_KEY) return;
    try {
      const res = await fetch(`${ALERT_API}?key=${encodeURIComponent(USER_KEY)}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const alerts = Array.isArray(data.alerts) ? data.alerts : [];
      for (const a of alerts) {
        const id = a.id || a.message;
        if (seenAlerts.has(id)) continue;
        showAlertBox(a.message || "(no message)");
        markAlertSeen(id);
      }
    } catch (err) {
      console.warn("Alert check failed:", err);
    }
  }
  setInterval(checkAlerts, 15000);

  // ==============================
  // Start immediately (no key UI in core)
  // ==============================
  function startAll() {
    ensureLeaderboardBox();
    startPolling();
    window.__USERNAME_TRACKER__ = {
      stop() {
        stopPolling();
        if (LB_BOX && LB_BOX.parentNode) LB_BOX.parentNode.removeChild(LB_BOX);
        LB_BOX = null;
      }
    };
  }

  startAll();

})();
