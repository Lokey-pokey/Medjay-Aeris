/* ============================================================
   Medjay Aeris — shared data layer, persistence & UI helpers
   Used by: index.html, gateway-detail.html, sensor-detail.html, logs.html
   ============================================================ */

/* ---------------- Deterministic PRNG (fixed seed for first generation) ---------------- */
function mulberry32(seed){
  return function(){
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const STORAGE_KEY = "medjayAerisState_v3";

const LOCATIONS = [
  "Warehouse A — Bay 3", "Warehouse A — Loading Dock", "Warehouse B — Cold Room",
  "Plant 2 — Boiler Room", "Plant 2 — Mezzanine", "Site 7 — North Yard",
  "Site 7 — Chemical Store", "HQ Basement — Server Room", "HQ Roof — Utility Deck",
  "Depot 4 — East Wing"
];
const GATEWAY_NAMES = [
  "GW-01 Warehouse A", "GW-02 Warehouse B", "GW-03 Plant 2 North",
  "GW-04 Plant 2 South", "GW-05 Site 7 Yard", "GW-06 Site 7 Chemical",
  "GW-07 HQ Basement", "GW-08 HQ Roof", "GW-09 Depot 4"
];
const NODE_COUNTS = [14, 11, 13, 9, 12, 10, 8, 12, 10]; // sums to ~99

const DEFAULT_THRESHOLDS = {
  temp:     { amber: 32, red: 40 },
  humidity: { amber: 70, red: 85 },
  smoke:    { amber: 35, red: 60 },
  aqi:      { amber: 100, red: 150 },
  battery:  { amber: 30, red: 15 }
};

// Most metrics are "bad when high" (temp, humidity, smoke, AQI). Battery is
// the opposite: bad when low. computeAlarmState needs to know this per key
// so a single low-battery reading can't be silently ignored or a full
// battery misread as an alarm.
const METRIC_DIRECTION = { temp:"high", humidity:"high", smoke:"high", aqi:"high", battery:"low" };

function pick(rand, arr){ return arr[Math.floor(rand()*arr.length)]; }
function ri(rand, min,max){ return Math.floor(rand()*(max-min+1))+min; }

/* Single source of truth for severity: compares each live metric against
   that node's own thresholds and returns the worst result. Anything that
   sets alarmState — generation, threshold edits, future live ingestion —
   must go through this so the badge, ack requirement, and metric bar
   colors can never disagree with each other. Direction-aware: most metrics
   are bad going up, battery is bad going down. */
function computeAlarmState(metrics, thresholds){
  let worst = "green";
  for(const key of Object.keys(thresholds)){
    const v = metrics[key];
    const t = thresholds[key];
    if(v === undefined || !t) continue;
    const dir = METRIC_DIRECTION[key] || "high";
    const isRed = dir === "low" ? v <= t.red : v >= t.red;
    const isAmber = dir === "low" ? v <= t.amber : v >= t.amber;
    if(isRed) return "red"; // red short-circuits, nothing can be worse
    if(isAmber) worst = "amber";
  }
  return worst;
}

function genNode(rand, idx, gwIdx){
  const online = rand() > 0.06; // ~6% offline (connectivity — independent of alarm state)
  const thresholds = JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS));

  // Bias the random draw ranges so red/amber/green nodes still occur at
  // roughly the original rates, but the drawn values now fully determine
  // the alarm state (via computeAlarmState) rather than the reverse.
  const severityRoll = rand();
  let tempMax, smokeMax, aqiMax, humidityMax, batteryMin;
  if(severityRoll < 0.05){        // aim for a red-triggering node
    tempMax = 46; smokeMax = 95; aqiMax = 220; humidityMax = 90; batteryMin = 5;
  } else if(severityRoll < 0.14){ // aim for an amber-range node
    tempMax = 36; smokeMax = 45; aqiMax = 130; humidityMax = 80; batteryMin = 20;
  } else {                        // normal node
    tempMax = 32; smokeMax = 30; aqiMax = 80; humidityMax = 78; batteryMin = 35;
  }

  const metrics = {
    temp: Number((18 + rand()*(tempMax-18)).toFixed(1)),
    humidity: ri(rand, 28, humidityMax),
    smoke: ri(rand, 2, smokeMax),
    aqi: ri(rand, 15, aqiMax),
    battery: ri(rand, batteryMin, 100)
  };

  // Alarm state is always derived from the actual readings vs thresholds —
  // connectivity never overwrites or masks it. A node can be offline AND
  // alarming at once; those are two independent facts about it.
  const alarmState = computeAlarmState(metrics, thresholds);

  return {
    id: `N-${gwIdx+1}${String(idx+1).padStart(2,'0')}`,
    name: `Sensor ${gwIdx+1}-${idx+1}`,
    gatewayId: `GW-${String(gwIdx+1).padStart(2,'0')}`,
    online,
    alarmState,
    ...metrics,
    buzzer: rand() > 0.15 ? "enabled" : "muted",
    ack: alarmState === "red" ? (rand() > 0.5) : true,
    lastUpdated: ri(rand,1,240),
    thresholds,
    apiKey: null // ChirpStack device API key — not yet provisioned; set later via sensor detail
  };
}

function generateInitialState(){
  const rand = mulberry32(20260724);
  const gateways = GATEWAY_NAMES.map((name, gwIdx) => {
    const nodeCount = NODE_COUNTS[gwIdx];
    const nodes = Array.from({length:nodeCount}, (_, i) => genNode(rand, i, gwIdx));
    // Connectivity is decided by the radios, not rolled independently of
    // them — a gateway can't be "online" while both links are down, and
    // it can't be "offline" while one is actually up.
    const wifi = rand() > 0.08;
    const lora = rand() > 0.05;
    const gwOnline = wifi || lora;
    return {
      id: `GW-${String(gwIdx+1).padStart(2,'0')}`,
      name,
      location: LOCATIONS[gwIdx % LOCATIONS.length],
      online: gwOnline,
      wifi: gwOnline ? wifi : false,
      lora: gwOnline ? lora : false,
      // If the gateway itself can't be reached, none of its nodes can be
      // "online" either — they report through it. That's purely a
      // connectivity fact, so it only touches `online`, never alarmState;
      // a node's last-known readings (and whatever alarm they implied)
      // stay exactly as they were.
      nodes: gwOnline ? nodes : nodes.map(n => ({...n, online:false})),
      lastSeenMinutes: gwOnline ? ri(rand,0,4) : ri(rand,12,180)
    };
  });

  // Build the seed log from the gateways/nodes actually generated above,
  // instead of hardcoded IDs that may not even exist in this run and whose
  // narrative (e.g. "Alarm Triggered" with no matching alarm) had no
  // relationship to the node's real state.
  const logs = [];
  let logId = 1;
  const now = Date.now();
  const allNodes = gateways.flatMap(gw => gw.nodes.map(n => ({...n, gw})));

  allNodes.filter(n => n.alarmState === "red").forEach(n => {
    logs.push({ event:"Alarm Triggered", gateway:n.gw.id, sensor:n.id, user:"" });
    if(n.ack) logs.push({ event:"Alarm Acknowledged", gateway:n.gw.id, sensor:n.id, user:"admin" });
  });
  allNodes.filter(n => !n.online).forEach(n => {
    logs.push({ event:"Node Offline", gateway:n.gw.id, sensor:n.id, user:"" });
  });
  gateways.filter(gw => !gw.online).forEach(gw => {
    logs.push({ event:"Gateway Offline", gateway:gw.id, sensor:"", user:"" });
  });
  allNodes.filter(n => n.buzzer === "muted").slice(0, 4).forEach(n => {
    logs.push({ event:"Buzzer Disabled", gateway:n.gw.id, sensor:n.id, user:"admin" });
  });

  logs.forEach(l => {
    l.id = logId++;
    l.ts = now - ri(rand, 5, 7000) * 60000;
  });
  logs.sort((a,b)=>b.ts-a.ts);

  return { gateways, logs, nextLogId: logId };
}

const MedjayData = (function(){
  let state = null;

  function load(){
    if(state) return state;
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(raw){ state = JSON.parse(raw); return state; }
    }catch(e){ /* fall through to regenerate */ }
    state = generateInitialState();
    save();
    return state;
  }

  function save(){
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(e){}
  }

  function addLog({gateway="", sensor="", event, user=""}){
    load();
    state.logs.unshift({ id: state.nextLogId++, ts: Date.now(), gateway, sensor, event, user });
    save();
  }

  return {
    getGateways(){ return load().gateways; },
    getGateway(id){ return load().gateways.find(g=>g.id===id); },
    getNode(nodeId){
      for(const gw of load().gateways){
        const n = gw.nodes.find(n=>n.id===nodeId);
        if(n) return { node:n, gateway:gw };
      }
      return null;
    },
    getLogs(){ return load().logs; },
    addLog,

    renameGateway(id, newName){
      const gw = this.getGateway(id); if(!gw) return;
      gw.name = newName; save();
      addLog({gateway:id, event:"Gateway Renamed", user:"admin"});
    },
    setLocation(id, newLoc){
      const gw = this.getGateway(id); if(!gw) return;
      gw.location = newLoc; save();
      addLog({gateway:id, event:"Gateway Location Changed", user:"admin"});
    },
    renameNode(nodeId, newName){
      const res = this.getNode(nodeId); if(!res) return;
      res.node.name = newName; save();
      addLog({gateway:res.gateway.id, sensor:nodeId, event:"Sensor Renamed", user:"admin"});
    },
    setThresholds(nodeId, thresholds){
      const res = this.getNode(nodeId); if(!res) return;
      const node = res.node;
      node.thresholds = thresholds;
      const wasAlarming = node.alarmState === "red";
      node.alarmState = computeAlarmState(
        {temp:node.temp, humidity:node.humidity, smoke:node.smoke, aqi:node.aqi, battery:node.battery},
        thresholds
      );
      // A node that newly enters red needs a fresh, unacknowledged alarm.
      // One that drops out of red (or was never in it) has nothing to ack.
      if(node.alarmState === "red" && !wasAlarming) node.ack = false;
      if(node.alarmState !== "red") node.ack = true;
      save();
      addLog({gateway:res.gateway.id, sensor:nodeId, event:"Threshold Changed", user:"admin"});
    },
    toggleBuzzer(nodeId){
      const res = this.getNode(nodeId); if(!res) return;
      res.node.buzzer = res.node.buzzer === "enabled" ? "muted" : "enabled"; save();
      addLog({gateway:res.gateway.id, sensor:nodeId, event:`Buzzer ${res.node.buzzer === "enabled" ? "Enabled" : "Disabled"}`, user:"admin"});
    },
    ackAlarm(nodeId){
      const res = this.getNode(nodeId); if(!res) return;
      res.node.ack = true; save();
      addLog({gateway:res.gateway.id, sensor:nodeId, event:"Alarm Acknowledged", user:"admin"});
    },
    setApiKey(nodeId, key){
      const res = this.getNode(nodeId); if(!res) return;
      const hadKey = !!res.node.apiKey;
      res.node.apiKey = key || null;
      save();
      addLog({gateway:res.gateway.id, sensor:nodeId, event: hadKey ? "API Key Updated" : "API Key Provisioned", user:"admin"});
    },
    clearApiKey(nodeId){
      const res = this.getNode(nodeId); if(!res || !res.node.apiKey) return;
      res.node.apiKey = null; save();
      addLog({gateway:res.gateway.id, sensor:nodeId, event:"API Key Removed", user:"admin"});
    },
    pingNode(nodeId){
      const res = this.getNode(nodeId); if(!res) return null;
      addLog({gateway:res.gateway.id, sensor:nodeId, event:"Sensor Pinged", user:"admin"});
      return res.node.online;
    },
    resetDemoData(){
      state = generateInitialState(); save();
    }
  };
})();

/* ---------------- Derived helpers ---------------- */
// Severity now combines two independent facts — connectivity (online) and
// alarm state (from live values vs thresholds) — with alarm taking
// precedence. A device can be offline AND alarming at once (e.g. it went
// dark right after reporting a red reading that's still unacknowledged);
// that must never be masked as merely "offline."
function gwSeverity(gw){
  if(gw.nodes.some(n => n.alarmState === "red")) return "alarm";
  if(!gw.online) return "offline";
  if(gw.nodes.some(n => n.alarmState === "amber")) return "warn";
  return "ok";
}
function nodeSeverity(n){
  if(n.alarmState === "red") return "alarm";
  if(!n.online) return "offline";
  if(n.alarmState === "amber") return "warn";
  return "ok";
}
function severityRank(s){ return {alarm:0, warn:1, offline:2, ok:3}[s]; }

function fmtMinutes(m){
  if(m < 1) return "just now";
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
  search: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#819AB2" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`
};

/* ---------------- Edit lock (client-side only — NOT real security) ----------------
   There is no backend yet, so this password lives in this file and is visible to
   anyone who views source. It's a soft gate to stop accidental edits, not a real
   auth system. Swap for a server-side check once the API exists. */
const EDIT_PASSWORD = "aeris2026";

function isEditUnlocked(){ return sessionStorage.getItem('medjayEditUnlocked') === '1'; }

/* Prompts for a password (once per browser session) before allowing an edit.
   Returns true if unlocked, false if the user cancelled or got it wrong. */
function requestEditUnlock(){
  if(isEditUnlocked()) return true;
  const pw = window.prompt('Enter password to edit this value:');
  if(pw === null) return false;
  if(pw === EDIT_PASSWORD){
    sessionStorage.setItem('medjayEditUnlocked', '1');
    return true;
  }
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
  const gateways = MedjayData.getGateways();
  const totalGw = gateways.length;
  const onlineGw = gateways.filter(g=>g.online).length;
  const allNodes = gateways.flatMap(g=>g.nodes);
  const totalNodes = allNodes.length;
  const onlineNodes = allNodes.filter(n=>n.online).length;
  const redAlarms = allNodes.filter(n=>n.alarmState==="red").length;
  const unacked = allNodes.filter(n=>n.alarmState==="red" && !n.ack).length;
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
      <div class="value-row"><span class="value ${redAlarms>0?'alarm-val':''}">${redAlarms}</span><span class="sub">across ${gateways.filter(g=>g.nodes.some(n=>n.alarmState==='red')).length} gateway(s)</span></div>
    </div>
    <div class="stat ${unacked>0?'is-alarm':''}">
      <div class="label">Unacknowledged</div>
      <div class="value-row"><span class="value ${unacked>0?'alarm-val':''}">${unacked}</span><span class="sub">need ack</span></div>
    </div>
    <div class="stat">
      <div class="label">Offline Devices</div>
      <div class="value-row"><span class="value offline-val">${(totalGw-onlineGw)+(totalNodes-onlineNodes)}</span><span class="sub">${totalGw-onlineGw} gw · ${totalNodes-onlineNodes} nodes</span></div>
    </div>
  `;
}

/* ---------------- Global search ----------------
   One search, callable from any page, that looks across gateways, nodes,
   and logs at once — not just whatever list happens to be rendered on the
   current page. Results navigate to the right detail page (or logs.html
   pre-filtered) rather than filtering in place. */
function searchAll(query){
  const q = query.trim().toLowerCase();
  if(!q) return { gateways:[], nodes:[], logs:[] };

  const gateways = MedjayData.getGateways();

  const gwMatches = gateways.filter(g =>
    g.name.toLowerCase().includes(q) || g.location.toLowerCase().includes(q)
  ).slice(0, 5);

  const nodeMatches = [];
  gateways.forEach(g => g.nodes.forEach(n => {
    const sev = nodeSeverity(n); // alarm/warn/ok/offline — searchable by status too
    if(
      n.id.toLowerCase().includes(q) ||
      n.name.toLowerCase().includes(q) ||
      sev.includes(q) ||
      n.buzzer.includes(q) ||
      g.name.toLowerCase().includes(q)
    ){
      nodeMatches.push({ node:n, gateway:g, sev });
    }
  }));

  const logMatches = MedjayData.getLogs().filter(l =>
    (l.event||'').toLowerCase().includes(q) ||
    (l.user||'').toLowerCase().includes(q) ||
    (l.sensor||'').toLowerCase().includes(q) ||
    (l.gateway||'').toLowerCase().includes(q)
  ).slice(0, 6);

  return { gateways: gwMatches, nodes: nodeMatches.slice(0, 6), logs: logMatches };
}

function renderGlobalSearchResults(query){
  const panel = document.getElementById('globalSearchResults');
  if(!panel) return;
  if(!query.trim()){ panel.classList.remove('show'); panel.innerHTML = ''; return; }

  const { gateways, nodes, logs } = searchAll(query);
  const gateways_ = MedjayData.getGateways();
  let html = '';

  if(gateways.length){
    html += `<div class="search-group-label">Gateways</div>`;
    html += gateways.map(g => `
      <div class="search-result-item" data-href="gateway-detail.html?gw=${encodeURIComponent(g.id)}">
        <span class="status-dot ${g.online?'online':'offline'}"></span>
        <span>${g.name}</span>
        <span class="search-result-sub">${g.location}</span>
      </div>`).join('');
  }
  if(nodes.length){
    html += `<div class="search-group-label">Sensor Nodes</div>`;
    html += nodes.map(({node,gateway,sev}) => `
      <div class="search-result-item" data-href="sensor-detail.html?node=${encodeURIComponent(node.id)}">
        <span class="status-dot ${node.online?'online':'offline'}"></span>
        <span>${node.name}</span>
        <span class="search-result-sub">${node.id} · ${gateway.name} · ${sev}</span>
      </div>`).join('');
  }
  if(logs.length){
    html += `<div class="search-group-label">Logs</div>`;
    html += logs.map(l => {
      const gw = gateways_.find(g=>g.id===l.gateway);
      return `
      <div class="search-result-item" data-href="logs.html?q=${encodeURIComponent(query)}">
        <span>${l.event}</span>
        <span class="search-result-sub">${gw ? gw.name : (l.gateway||'')} · ${fmtTs(l.ts)}</span>
      </div>`;
    }).join('');
  }
  if(!html) html = `<div class="search-empty">No matches for "${query.trim()}"</div>`;

  panel.innerHTML = html;
  panel.classList.add('show');
  panel.querySelectorAll('[data-href]').forEach(el => {
    el.addEventListener('click', () => { window.location.href = el.dataset.href; });
  });
}

function wireGlobalSearch(){
  const input = document.getElementById('searchInput');
  const panel = document.getElementById('globalSearchResults');
  if(!input) return;
  input.addEventListener('input', () => renderGlobalSearchResults(input.value));
  input.addEventListener('focus', () => { if(input.value.trim()) renderGlobalSearchResults(input.value); });
  document.addEventListener('click', (e) => {
    if(panel && !input.contains(e.target) && !panel.contains(e.target)) panel.classList.remove('show');
  });
  document.addEventListener('keydown', (e) => {
    if(e.key === 'Escape'){ panel.classList.remove('show'); input.blur(); }
  });
}

function tickClock(){
  const el = document.getElementById('clock');
  if(!el) return;
  const now = new Date();
  el.textContent = now.toLocaleString(undefined, { weekday:'short', hour:'2-digit', minute:'2-digit', second:'2-digit' });
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

