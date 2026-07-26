/* ============================================================
   Medjay Aeris — LIVE integration layer
   Implements: TRIOSAFE / AERIS Gateway REST API v1.0 (frozen spec)

   IMPORTANT ARCHITECTURE NOTE
   The spec defines ONE REST API per physical gateway (each Raspberry Pi
   runs its own server at its own base URL). There is no discovery
   endpoint and no multi-gateway aggregator in the spec, so:
     - The list of gateways is a LOCAL registry the operator configures
       here (name, location, base URL, API key) — nothing "discovers" them.
     - The API key is scoped to a GATEWAY, not a node (matches the spec's
       future `Authorization: Bearer <TOKEN>` model, which is per-server).
     - Everything else (live values, alarm flags, commands, history) comes
       straight from that gateway's own REST API, polled at the intervals
       the spec recommends.

   WHAT'S STILL LOCAL-ONLY (spec has no endpoint for it yet)
     - Per-node amber/red preview thresholds: purely a client-side
       early-warning overlay. The device's own `flags` bitmask is the only
       authoritative alarm source (bits 0/1/2). Thresholds here do NOT
       change severity/badges — only the informational bar color, until
       /api/settings (currently reserved) exists to actually push them
       to the device.
     - Event log: /api/logs is reserved, not implemented server-side yet,
       so command/config actions are still logged to localStorage.
     - Buzzer/alarm-output state: ENABLE_ALARM / DISABLE_ALARM are queued
       commands with no confirming field in any GET response, so the
       displayed state is "last commanded" and explicitly marked
       unconfirmed rather than pretended to be verified telemetry.
   ============================================================ */

const REGISTRY_KEY   = "medjayGatewayRegistry_v1";
const THRESHOLDS_KEY = "medjayLocalThresholds_v1";
const BUZZER_KEY      = "medjayLocalBuzzerCmd_v1";
const LOG_KEY         = "medjayLocalLog_v1";

const POLL_MS = { status: 5000, nodes: 5000, node: 5000, queue: 5000, history: 30000 };

const DEFAULT_LOCAL_THRESHOLDS = {
  temperature: { amber: 32 },
  humidity:    { amber: 70 },
  smoke:       { amber: 120 },
  battery:     { amber: 30 } // bad when LOW
};
const METRIC_DIRECTION = { temperature:"high", humidity:"high", smoke:"high", battery:"low" };

function uid(prefix){ return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`; }
function lsGet(key, fallback){ try{ const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }catch(e){ return fallback; } }
function lsSet(key, val){ try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){} }

/* ---------------- API key obfuscation ----------------
   NOT real security — anyone with devtools access and five minutes can
   reverse this. It only stops a key from sitting in plain, greppable text
   in localStorage. Real protection requires this to never leave a backend
   at all (once the spec's Bearer-token auth exists server-side). */
function obfuscateKey(plain){
  if(!plain) return '';
  try{ return btoa(unescape(encodeURIComponent(plain))).split('').reverse().join(''); }
  catch(e){ return ''; }
}
function deobfuscateKey(stored){
  if(!stored) return '';
  try{ return decodeURIComponent(escape(atob(stored.split('').reverse().join('')))); }
  catch(e){ return ''; }
}

/* ---------------- Gateway registry (local config, not from any API) ---------------- */
const GatewayRegistry = (function(){
  function list(){ return lsGet(REGISTRY_KEY, []); }
  function save(arr){ lsSet(REGISTRY_KEY, arr); }
  return {
    list,
    get(id){ return list().find(g=>g.id===id) || null; },
    add({name, location, baseUrl, apiKey}){
      const arr = list();
      const gw = { id: uid("gw"), name: name||"Unnamed Gateway", location: location||"—",
        baseUrl: (baseUrl||"").replace(/\/$/,''), apiKey: obfuscateKey(apiKey||"") };
      arr.push(gw); save(arr);
      addLog({gateway:gw.id, event:"Gateway Registered", user:"admin"});
      ensurePolling(gw);
      return gw;
    },
    update(id, fields){
      const arr = list(); const gw = arr.find(g=>g.id===id); if(!gw) return;
      if(fields.apiKey !== undefined) fields = { ...fields, apiKey: obfuscateKey(fields.apiKey) };
      Object.assign(gw, fields);
      if(gw.baseUrl) gw.baseUrl = gw.baseUrl.replace(/\/$/,'');
      save(arr);
      addLog({gateway:id, event:"Gateway Config Updated", user:"admin"});
    },
    getApiKeyPlain(id){
      const gw = this.get(id);
      return gw ? deobfuscateKey(gw.apiKey) : '';
    },
    remove(id){
      save(list().filter(g=>g.id!==id));
      stopPolling(id);
      addLog({gateway:id, event:"Gateway Removed", user:"admin"});
    }
  };
})();

/* ---------------- Local per-node overlays (thresholds, buzzer-commanded-state) ---------------- */
function thresholdKey(gwId, nodeId){ return `${gwId}:${nodeId}`; }
const LocalThresholds = {
  get(gwId, nodeId){
    const all = lsGet(THRESHOLDS_KEY, {});
    return all[thresholdKey(gwId,nodeId)] || JSON.parse(JSON.stringify(DEFAULT_LOCAL_THRESHOLDS));
  },
  set(gwId, nodeId, thresholds){
    const all = lsGet(THRESHOLDS_KEY, {});
    all[thresholdKey(gwId,nodeId)] = thresholds;
    lsSet(THRESHOLDS_KEY, all);
  }
};
const LocalBuzzer = {
  get(gwId, nodeId){
    const all = lsGet(BUZZER_KEY, {});
    return all[thresholdKey(gwId,nodeId)] ?? null; // null = never commanded, unknown
  },
  set(gwId, nodeId, enabled){
    const all = lsGet(BUZZER_KEY, {});
    all[thresholdKey(gwId,nodeId)] = enabled;
    lsSet(BUZZER_KEY, all);
  }
};

/* ---------------- Local event log (client-side until /api/logs ships) ---------------- */
function addLog({gateway="", sensor="", event, user=""}){
  const logs = lsGet(LOG_KEY, []);
  logs.unshift({ id: (logs[0]?.id||0)+1, ts: Date.now(), gateway, sensor:String(sensor), event, user });
  lsSet(LOG_KEY, logs.slice(0, 2000));
}
function getLogs(){ return lsGet(LOG_KEY, []); }

/* ---------------- REST client ---------------- */
async function apiFetch(gw, path, opts={}){
  if(!gw || !gw.baseUrl) return { ok:false, status:0, error:"No base URL configured", data:null };
  const url = gw.baseUrl + path;
  const headers = { "Content-Type":"application/json", ...(opts.headers||{}) };
  if(gw.apiKey) headers["Authorization"] = `Bearer ${deobfuscateKey(gw.apiKey)}`;
  try{
    const res = await fetch(url, { ...opts, headers });
    let data = null;
    try{ data = await res.json(); }catch(e){ /* empty/non-JSON body */ }
    if(!res.ok) return { ok:false, status:res.status, error:(data && data.message) || `HTTP ${res.status}`, data };
    return { ok:true, status:res.status, data };
  }catch(e){
    return { ok:false, status:0, error: e.message || "Network error — gateway unreachable", data:null };
  }
}

/* ---------------- Alarm flag decoding (bitmask per spec) ---------------- */
function decodeFlags(flags){
  flags = flags || 0;
  return {
    smoke:      !!(flags & 0x01),
    temp:       !!(flags & 0x02),
    humidity:   !!(flags & 0x04),
    batteryLow: !!(flags & 0x08),
    loraError:  !!(flags & 0x10),
  };
}

function nodeSeverity(node){
  if(!node) return "offline";
  const f = decodeFlags(node.flags);
  if(f.smoke || f.temp || f.humidity) return "alarm"; // device-declared alarm always wins, even if node then drops offline
  if(!node.online) return "offline";
  if(f.batteryLow || f.loraError) return "warn";
  return "ok";
}
function gwSeverity(gwId){
  const entry = LiveStore.get(gwId);
  const reachable = entry.status && entry.status.gateway === "online";
  if(entry.nodes.some(n => nodeSeverity(n) === "alarm")) return "alarm";
  if(!reachable) return "offline";
  if(entry.nodes.some(n => nodeSeverity(n) === "warn")) return "warn";
  return "ok";
}
function severityRank(s){ return {alarm:0, warn:1, offline:2, ok:3}[s] ?? 4; }

/* ---------------- Live in-memory cache + polling ---------------- */
const LiveStore = (function(){
  const cache = {};   // gwId -> {status, nodes, lastError, lastPolled}
  const timers = {};  // gwId -> intervalId
  function get(gwId){ return cache[gwId] || (cache[gwId] = { status:null, nodes:[], lastError:null, lastPolled:0 }); }
  return { get, cache, timers };
})();

async function pollGatewayOnce(gw){
  const entry = LiveStore.get(gw.id);
  const [statusRes, nodesRes] = await Promise.all([
    apiFetch(gw, "/api/status"),
    apiFetch(gw, "/api/nodes")
  ]);
  if(statusRes.ok){ entry.status = statusRes.data; entry.lastError = null; }
  else { entry.status = null; entry.lastError = statusRes.error; }
  // Keep last-known node readings on a failed poll (same "last known reading"
  // principle as before) rather than blanking the UI on one dropped request.
  if(nodesRes.ok && Array.isArray(nodesRes.data)) entry.nodes = nodesRes.data;
  entry.lastPolled = Date.now();
}

function ensurePolling(gw){
  if(LiveStore.timers[gw.id]) return; // already running
  pollGatewayOnce(gw);
  LiveStore.timers[gw.id] = setInterval(()=>pollGatewayOnce(gw), POLL_MS.nodes);
}
function stopPolling(gwId){
  if(LiveStore.timers[gwId]){ clearInterval(LiveStore.timers[gwId]); delete LiveStore.timers[gwId]; }
  delete LiveStore.cache[gwId];
}
function ensureAllGatewaysPolling(){
  GatewayRegistry.list().forEach(ensurePolling);
}

/* One-off (non-interval) fetches used by detail pages/actions */
async function fetchNode(gw, nodeId){ return apiFetch(gw, `/api/node/${nodeId}`); }
async function fetchHistory(gw, nodeId){ return apiFetch(gw, `/api/history/${nodeId}`); }
async function fetchQueue(gw){ return apiFetch(gw, `/api/queue`); }
async function sendCommand(gw, nodeId, command){
  const res = await apiFetch(gw, "/api/command", { method:"POST", body: JSON.stringify({ node_id:Number(nodeId), command }) });
  addLog({ gateway:gw.id, sensor:nodeId, event:`Command Sent: ${command}`, user:"admin" });
  if(res.ok && command === "ENABLE_ALARM") LocalBuzzer.set(gw.id, nodeId, true);
  if(res.ok && command === "DISABLE_ALARM") LocalBuzzer.set(gw.id, nodeId, false);
  return res;
}

/* ---------------- Formatting helpers ---------------- */
function fmtAgo(unixSeconds){
  if(!unixSeconds) return "unknown";
  const secs = Math.max(0, Math.floor(Date.now()/1000 - unixSeconds));
  if(secs < 5) return "just now";
  if(secs < 60) return `${secs}s ago`;
  const m = Math.floor(secs/60);
  if(m < 60) return `${m}m ago`;
  const h = Math.floor(m/60);
  return `${h}h ${m%60}m ago`;
}
function fmtTs(ts){
  const d = new Date(ts);
  return d.toLocaleString(undefined, {month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit'});
}
function maskApiKey(key){
  if(!key) return null;
  if(key.length <= 8) return '•'.repeat(key.length);
  return key.slice(0,4) + '•'.repeat(Math.max(4, key.length-8)) + key.slice(-4);
}

/* ---------------- Icons ---------------- */
const ICONS = {
  wifi: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M2 8.5a16 16 0 0 1 20 0"/><path d="M5.5 12.5a11 11 0 0 1 13 0"/><path d="M9 16.5a6 6 0 0 1 6 0"/><circle cx="12" cy="20" r="1" fill="currentColor" stroke="none"/></svg>`,
  lora: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 12h4l2-7 4 14 2-7h4"/></svg>`,
  pin: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-7.2 7-12a7 7 0 1 0-14 0c0 4.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.3"/></svg>`,
  pencil: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`,
  speaker: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/></svg>`,
  alert: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 1 21h22z"/><line x1="12" y1="9" x2="12" y2="14"/><circle cx="12" cy="17.3" r="0.6" fill="currentColor"/></svg>`,
  check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  back: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
  battery: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="17" height="10" rx="2"/><line x1="22" y1="10" x2="22" y2="14"/></svg>`,
  search: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#819AB2" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  plus: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`
};

/* ---------------- Edit lock (client-side only — NOT real security) ----------------
   Gates gateway registration/config and destructive commands (REBOOT,
   FACTORY_RESET) until the spec's real Bearer-token auth exists. */
const EDIT_PASSWORD = "aeris2026";
function isEditUnlocked(){ return sessionStorage.getItem('medjayEditUnlocked') === '1'; }
function requestEditUnlock(){
  if(isEditUnlocked()) return true;
  const pw = window.prompt('Enter password to make this change:');
  if(pw === null) return false;
  if(pw === EDIT_PASSWORD){ sessionStorage.setItem('medjayEditUnlocked', '1'); return true; }
  window.alert('Incorrect password.');
  return false;
}

/* ---------------- Shared chrome: topbar + summary strip ---------------- */
function renderTopbar(activePage){
  const navItems = [
    {key:"overview", label:"Gateway Overview", href:"index.html"},
    {key:"logs", label:"Logs", href:"logs.html"}
  ];
  const navHTML = navItems.map(item =>
    `<a class="nav-item ${item.key===activePage?'active':''}" href="${item.href}">${item.label}</a>`
  ).join('');
  return `
  <div class="topbar">
    <div class="topbar-left"><nav class="nav">${navHTML}</nav></div>
    <div class="brand">
      <img src="medjay-logo.jpg" alt="Medjay" class="brand-logo">
      <div class="brand-text"><span class="name">MEDJAY</span><span class="sub">AERIS</span></div>
    </div>
    <div class="topbar-right">
      <div class="search-box">
        ${ICONS.search}
        <input id="searchInput" type="text" placeholder="Search gateways, nodes, logs…" autocomplete="off">
      </div>
      <div class="clock" id="clock"></div>
    </div>
  </div>
  <div class="search-results" id="globalSearchResults"></div>`;
}

function renderSummaryStripHTML(){
  const gateways = GatewayRegistry.list();
  const totalGw = gateways.length;
  let onlineGw=0, totalNodes=0, onlineNodes=0, redAlarms=0, batteryWarn=0, offlineNodes=0;
  const alarmGwIds = new Set(), warnGwIds = new Set();
  gateways.forEach(gw=>{
    const entry = LiveStore.get(gw.id);
    const reachable = entry.status && entry.status.gateway === "online";
    if(reachable) onlineGw++;
    entry.nodes.forEach(n=>{
      totalNodes++;
      if(n.online) onlineNodes++; else offlineNodes++;
      const sev = nodeSeverity(n);
      if(sev==="alarm"){ redAlarms++; alarmGwIds.add(gw.id); }
      if(sev==="warn"){ batteryWarn++; warnGwIds.add(gw.id); }
    });
  });
  return `
    <div class="stat">
      <div class="label">Gateways</div>
      <div class="value-row"><span class="value">${onlineGw}/${totalGw}</span><span class="sub">online</span></div>
    </div>
    <div class="stat">
      <div class="label">Sensor Nodes</div>
      <div class="value-row"><span class="value">${onlineNodes}/${totalNodes}</span><span class="sub">online</span></div>
    </div>
    <div class="stat ${redAlarms>0?'is-alarm':''}">
      <div class="label">Active Alarms</div>
      <div class="value-row"><span class="value ${redAlarms>0?'alarm-val':''}">${redAlarms}</span><span class="sub">across ${alarmGwIds.size} gateway(s)</span></div>
    </div>
    <div class="stat ${batteryWarn>0?'is-warn':''}">
      <div class="label">Active Warnings</div>
      <div class="value-row"><span class="value ${batteryWarn>0?'warn-val':''}">${batteryWarn}</span><span class="sub">across ${warnGwIds.size} gateway(s)</span></div>
    </div>
    <div class="stat">
      <div class="label">Offline Devices</div>
      <div class="value-row"><span class="value offline-val">${(totalGw-onlineGw)+offlineNodes}</span><span class="sub">${totalGw-onlineGw} gw · ${offlineNodes} nodes</span></div>
    </div>
  `;
}

/* ---------------- Global search (over registry + currently-cached live nodes + local logs) ---------------- */
function searchAll(query){
  const q = query.trim().toLowerCase();
  if(!q) return { gateways:[], nodes:[], logs:[] };
  const gateways = GatewayRegistry.list();
  const gwMatches = gateways.filter(g => g.name.toLowerCase().includes(q) || g.location.toLowerCase().includes(q)).slice(0,5);
  const nodeMatches = [];
  gateways.forEach(g=>{
    LiveStore.get(g.id).nodes.forEach(n=>{
      const sev = nodeSeverity(n);
      if(String(n.id).includes(q) || sev.includes(q) || g.name.toLowerCase().includes(q)) nodeMatches.push({node:n, gateway:g, sev});
    });
  });
  const logMatches = getLogs().filter(l =>
    (l.event||'').toLowerCase().includes(q) || (l.user||'').toLowerCase().includes(q) ||
    (l.sensor||'').toLowerCase().includes(q) || (l.gateway||'').toLowerCase().includes(q)
  ).slice(0,6);
  return { gateways: gwMatches, nodes: nodeMatches.slice(0,6), logs: logMatches };
}

function renderGlobalSearchResults(query){
  const panel = document.getElementById('globalSearchResults');
  if(!panel) return;
  if(!query.trim()){ panel.classList.remove('show'); panel.innerHTML=''; return; }
  const { gateways, nodes, logs } = searchAll(query);
  let html = '';
  if(gateways.length){
    html += `<div class="search-group-label">Gateways</div>`;
    html += gateways.map(g=>{
      const entry = LiveStore.get(g.id);
      const online = entry.status && entry.status.gateway==="online";
      return `<div class="search-result-item" data-href="gateway-detail.html?gw=${encodeURIComponent(g.id)}">
        <span class="status-dot ${online?'online':'offline'}"></span><span>${g.name}</span>
        <span class="search-result-sub">${g.location}</span></div>`;
    }).join('');
  }
  if(nodes.length){
    html += `<div class="search-group-label">Sensor Nodes</div>`;
    html += nodes.map(({node,gateway,sev})=>`
      <div class="search-result-item" data-href="sensor-detail.html?gw=${encodeURIComponent(gateway.id)}&node=${encodeURIComponent(node.id)}">
        <span class="status-dot ${node.online?'online':'offline'}"></span><span>Node ${node.id}</span>
        <span class="search-result-sub">${gateway.name} · ${sev}</span></div>`).join('');
  }
  if(logs.length){
    html += `<div class="search-group-label">Logs</div>`;
    html += logs.map(l=>{
      const gw = GatewayRegistry.get(l.gateway);
      return `<div class="search-result-item" data-href="logs.html?q=${encodeURIComponent(query)}">
        <span>${l.event}</span><span class="search-result-sub">${gw?gw.name:(l.gateway||'')} · ${fmtTs(l.ts)}</span></div>`;
    }).join('');
  }
  if(!html) html = `<div class="search-empty">No matches for "${query.trim()}"</div>`;
  panel.innerHTML = html;
  panel.classList.add('show');
  panel.querySelectorAll('[data-href]').forEach(el=>{
    el.addEventListener('click', ()=>{ window.location.href = el.dataset.href; });
  });
}
function wireGlobalSearch(){
  const input = document.getElementById('searchInput');
  const panel = document.getElementById('globalSearchResults');
  if(!input) return;
  input.addEventListener('input', ()=>renderGlobalSearchResults(input.value));
  input.addEventListener('focus', ()=>{ if(input.value.trim()) renderGlobalSearchResults(input.value); });
  document.addEventListener('click', (e)=>{ if(panel && !input.contains(e.target) && !panel.contains(e.target)) panel.classList.remove('show'); });
  document.addEventListener('keydown', (e)=>{ if(e.key==='Escape'){ panel.classList.remove('show'); input.blur(); } });
}

function tickClock(){
  const el = document.getElementById('clock');
  if(!el) return;
  el.textContent = new Date().toLocaleString(undefined, { weekday:'short', hour:'2-digit', minute:'2-digit', second:'2-digit' });
}
let toastTimer;
function showToast(msg){
  const t = document.getElementById('toast');
  if(!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove('show'), 2600);
}
