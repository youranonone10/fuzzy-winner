const cron  = require("node-cron");
const axios = require("axios");
const http  = require("http");
const url   = require("url");

const DOMAIN      = process.env.FRESHDESK_DOMAIN;
const API_KEY     = process.env.FRESHDESK_API_KEY;
const AGENT_IDS   = process.env.AGENT_IDS.split(",").map(Number);
const AGENT_NAMES = process.env.AGENT_NAMES.split(",").map(s => s.trim());
const PORT        = process.env.PORT || 3000;
const auth        = { username: API_KEY, password: "X" };

// ── FRESHDESK HELPERS ─────────────────────────────────────────────────────────

async function fd(endpoint) {
  const res = await axios.get("https://" + DOMAIN + "/api/v2/" + endpoint, { auth });
  return res.data;
}

async function fdAll(filter) {
  let page = 1, all = [];
  while (true) {
    const res = await axios.get(
      "https://" + DOMAIN + "/api/v2/tickets?filter=" + filter + "&per_page=100&page=" + page,
      { auth }
    );
    all = all.concat(res.data);
    if (res.data.length < 100) break;
    page++;
  }
  return all;
}

async function getStats() {
  const [open, unresolved] = await Promise.all([
    fdAll("new_and_my_open"),
    fdAll("open")
  ]);
  const openTickets    = open.filter(t => t.status === 2);
  const unassigned     = openTickets.filter(t => !t.responder_id);
  const now            = new Date();
  const overdue        = unresolved.filter(t => t.due_by && new Date(t.due_by) < now);
  return {
    open:       openTickets.length,
    unassigned: unassigned.length,
    assigned:   openTickets.length - unassigned.length,
    unresolved: unresolved.length,
    overdue:    overdue.length
  };
}

async function getAgentWorkload() {
  // Fetch ALL open tickets and count per agent correctly
  const [open, unresolved] = await Promise.all([
    fdAll("new_and_my_open"),
    fdAll("open")
  ]);
  const openCnt = {}, unresCnt = {};
  AGENT_IDS.forEach(id => { openCnt[id] = 0; unresCnt[id] = 0; });

  open.filter(t => t.status === 2).forEach(t => {
    if (t.responder_id !== undefined && openCnt[t.responder_id] !== undefined)
      openCnt[t.responder_id]++;
  });
  unresolved.forEach(t => {
    if (t.responder_id !== undefined && unresCnt[t.responder_id] !== undefined)
      unresCnt[t.responder_id]++;
  });

  return AGENT_IDS.map((id, i) => ({
    id,
    name:       AGENT_NAMES[i] || "Agent " + (i + 1),
    open:       openCnt[id],
    unresolved: unresCnt[id]
  }));
}

async function getUnresolvedTickets() {
  const tickets = await fdAll("open");
  return tickets.map(t => ({
    id:       t.id,
    subject:  t.subject  || "No subject",
    status:   t.status,
    priority: t.priority,
    due_by:   t.due_by,
    created:  t.created_at,
    agent:    t.responder_id
      ? (AGENT_NAMES[AGENT_IDS.indexOf(t.responder_id)] || "Agent")
      : null
  }));
}

async function assignOne(ticketId, agentId) {
  try {
    await axios.put(
      "https://" + DOMAIN + "/api/v2/tickets/" + ticketId,
      { responder_id: agentId },
      { auth, headers: { "Content-Type": "application/json" } }
    );
    return true;
  } catch(e) {
    console.error("Failed #" + ticketId + ": " +
      (e.response && e.response.data ? JSON.stringify(e.response.data) : e.message));
    return false;
  }
}

// Step 1: assign only unassigned open tickets equally to given agents
async function assignUnassigned(agentIdList) {
  const all     = await fdAll("new_and_my_open");
  const tickets = all.filter(t => t.status === 2 && !t.responder_id);
  if (tickets.length === 0) return { assigned: 0, failed: 0, tickets: [] };

  const perAgent = {};
  agentIdList.forEach((id, i) => {
    const idx = AGENT_IDS.indexOf(id);
    perAgent[id] = { name: AGENT_NAMES[idx] || "Agent " + (i + 1), count: 0 };
  });

  let assigned = 0, failed = 0;
  const results = [];
  for (let i = 0; i < tickets.length; i++) {
    const t       = tickets[i];
    const agentId = agentIdList[i % agentIdList.length];
    const ok      = await assignOne(t.id, agentId);
    if (ok) { perAgent[agentId].count++; assigned++; }
    else failed++;
    results.push({ id: t.id, subject: t.subject || "No subject", agent: perAgent[agentId].name, ok });
  }
  return { assigned, failed, tickets: results };
}

// Step 2: shuffle ALL open tickets (assigned + unassigned) equally to given agents
async function shuffleAll(agentIdList) {
  const all     = await fdAll("new_and_my_open");
  const tickets = all.filter(t => t.status === 2);
  if (tickets.length === 0) return { assigned: 0, failed: 0, tickets: [] };

  const perAgent = {};
  agentIdList.forEach((id, i) => {
    const idx = AGENT_IDS.indexOf(id);
    perAgent[id] = { name: AGENT_NAMES[idx] || "Agent " + (i + 1), count: 0 };
  });

  let assigned = 0, failed = 0;
  const results = [];
  for (let i = 0; i < tickets.length; i++) {
    const t       = tickets[i];
    const agentId = agentIdList[i % agentIdList.length];
    const ok      = await assignOne(t.id, agentId);
    if (ok) { perAgent[agentId].count++; assigned++; }
    else failed++;
    results.push({ id: t.id, subject: t.subject || "No subject", agent: perAgent[agentId].name, ok });
  }
  return { assigned, failed, tickets: results };
}

// Shuffle one agent's tickets to all other agents
async function reshuffleOneAgent(agentId) {
  const all     = await fdAll("new_and_my_open");
  const tickets = all.filter(t => t.status === 2 && t.responder_id === agentId);
  const others  = AGENT_IDS.filter(id => id !== agentId);
  let reassigned = 0;
  for (let i = 0; i < tickets.length; i++) {
    if (await assignOne(tickets[i].id, others[i % others.length])) reassigned++;
  }
  return { reassigned, total: tickets.length };
}

// ── HTML DASHBOARD ────────────────────────────────────────────────────────────

function buildHTML() {
  const agentsJson = JSON.stringify(
    AGENT_IDS.map((id, i) => ({ id, name: AGENT_NAMES[i] || "Agent " + (i + 1) }))
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TrustVA Ticket Desk</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#08080e;--s1:#101018;--s2:#181825;--bd:#252535;
  --acc:#6c63ff;--red:#ff6584;--grn:#00e5a0;--yel:#ffd166;--ora:#ff9a3c;
  --txt:#e4e4f0;--mut:#5a5a72;
  --fh:'Syne',sans-serif;--fb:'DM Sans',sans-serif;--fm:'DM Mono',monospace;
}
body{background:var(--bg);color:var(--txt);font-family:var(--fb);min-height:100vh}
body::before{content:'';position:fixed;top:-300px;right:-200px;width:700px;height:700px;
  background:radial-gradient(circle,rgba(108,99,255,.07) 0%,transparent 65%);pointer-events:none;z-index:0}

/* HEADER */
header{position:sticky;top:0;z-index:100;padding:0 28px;height:52px;display:flex;
  align-items:center;justify-content:space-between;
  background:rgba(8,8,14,.92);backdrop-filter:blur(16px);border-bottom:1px solid var(--bd)}
.logo{font-family:var(--fh);font-size:17px;font-weight:800}.logo span{color:var(--acc)}
.hr{display:flex;align-items:center;gap:10px}
.live{width:7px;height:7px;border-radius:50%;background:var(--grn);
  box-shadow:0 0 8px var(--grn);animation:blink 2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.dom{font-family:var(--fm);font-size:11px;color:var(--mut);
  background:var(--s2);padding:3px 10px;border-radius:20px;border:1px solid var(--bd)}
.synct{font-size:11px;color:var(--mut)}

/* LAYOUT */
main{position:relative;z-index:1;max-width:1300px;margin:0 auto;padding:24px 20px}

/* STATS */
.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:24px}
@media(max-width:900px){.stats{grid-template-columns:repeat(3,1fr)}}
@media(max-width:500px){.stats{grid-template-columns:repeat(2,1fr)}}
.sc{background:var(--s1);border:1px solid var(--bd);border-radius:14px;
  padding:16px 18px;position:relative;overflow:hidden;transition:border-color .2s}
.sc:hover{border-color:rgba(108,99,255,.4)}
.sc::after{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.sc.c1::after{background:var(--acc)}.sc.c2::after{background:var(--red)}
.sc.c3::after{background:var(--grn)}.sc.c4::after{background:var(--yel)}
.sc.c5::after{background:var(--ora)}.sc.c6::after{background:#38bdf8}
.sc-n{font-family:var(--fh);font-size:30px;font-weight:800;line-height:1;margin-bottom:4px}
.sc-l{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.08em;font-weight:500}

/* SECTION */
.sec{background:var(--s1);border:1px solid var(--bd);border-radius:18px;margin-bottom:20px;overflow:hidden}
.sec-h{padding:16px 22px;border-bottom:1px solid var(--bd);
  display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.sec-t{font-family:var(--fh);font-size:14px;font-weight:700}
.sec-b{padding:20px 22px}
.hint{font-size:12px;color:var(--mut);margin-bottom:14px;line-height:1.6}

/* BUTTONS */
.btn{display:inline-flex;align-items:center;gap:5px;padding:8px 16px;border-radius:9px;
  font-size:12px;font-weight:600;font-family:var(--fb);cursor:pointer;border:none;
  transition:all .15s;white-space:nowrap}
.btn-g{background:var(--grn);color:#000}.btn-g:hover{opacity:.85;transform:translateY(-1px)}
.btn-p{background:var(--acc);color:#fff}.btn-p:hover{background:#7c74ff;transform:translateY(-1px)}
.btn-o{background:transparent;border:1px solid var(--ora);color:var(--ora)}.btn-o:hover{background:rgba(255,154,60,.1)}
.btn-gh{background:transparent;border:1px solid var(--bd);color:var(--txt)}.btn-gh:hover{border-color:var(--acc);color:var(--acc)}
.btn:disabled{opacity:.35;cursor:not-allowed;transform:none!important}
.brow{display:flex;gap:8px;flex-wrap:wrap;align-items:center}

/* AGENT TOGGLES */
.ag-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:7px;margin-bottom:10px}
.ag-tog{display:flex;align-items:center;gap:7px;padding:9px 12px;border-radius:9px;
  border:1px solid var(--bd);background:var(--s2);cursor:pointer;transition:all .15s;user-select:none}
.ag-tog.on{border-color:var(--acc);background:rgba(108,99,255,.1)}
.ag-tog input{display:none}
.chk{width:15px;height:15px;border-radius:4px;border:1px solid var(--bd);
  display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:9px;transition:all .15s}
.ag-tog.on .chk{background:var(--acc);border-color:var(--acc);color:#fff}
.tname{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.selc{font-size:11px;color:var(--mut);margin-top:4px}

/* AGENT WORKLOAD */
.wl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
.wl-card{background:var(--s2);border:1px solid var(--bd);border-radius:12px;
  padding:14px 16px;display:flex;align-items:center;gap:12px;transition:all .2s}
.wl-card:hover{border-color:var(--acc);transform:translateY(-1px)}
.av{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;
  justify-content:center;font-family:var(--fh);font-size:12px;font-weight:700;flex-shrink:0}
.wl-i{flex:1;min-width:0}
.wl-n{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px}
.wl-c{display:flex;gap:10px;font-size:11px;font-family:var(--fm);margin-bottom:5px}
.oc{color:var(--acc)}.uc{color:var(--yel)}
.wl-bar{height:3px;background:var(--bd);border-radius:2px;overflow:hidden}
.wl-bf{height:100%;border-radius:2px;transition:width .6s}
.sf-btn{padding:5px 9px;font-size:11px;border-radius:7px;border:1px solid var(--bd);
  background:transparent;color:var(--mut);cursor:pointer;transition:all .15s;font-family:var(--fb)}
.sf-btn:hover{border-color:var(--red);color:var(--red)}

/* TICKET LIST */
.tkt-list{max-height:340px;overflow-y:auto}
.tkt-list::-webkit-scrollbar{width:3px}
.tkt-list::-webkit-scrollbar-thumb{background:var(--bd);border-radius:2px}
.tkt-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--bd);font-size:12px}
.tkt-row:last-child{border-bottom:none}
.tid{font-family:var(--fm);font-size:11px;color:var(--acc);min-width:55px;flex-shrink:0}
.tsub{flex:1;color:var(--txt);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tag-ok{font-size:11px;font-family:var(--fm);color:var(--grn);flex-shrink:0}
.tag-ua{font-size:11px;font-family:var(--fm);color:var(--red);flex-shrink:0}
.tag-fail{font-size:11px;font-family:var(--fm);color:var(--red);flex-shrink:0}
.st{font-size:10px;padding:2px 7px;border-radius:20px;flex-shrink:0}
.st-o{background:rgba(108,99,255,.15);color:var(--acc)}
.st-p{background:rgba(255,209,102,.15);color:var(--yel)}
.st-ov{background:rgba(255,101,132,.15);color:var(--red)}
.st-h{background:rgba(255,154,60,.15);color:var(--ora)}
.dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.d1{background:#555}.d2{background:var(--acc)}.d3{background:var(--yel)}.d4{background:var(--red)}

/* RESULT */
.res-box{background:var(--s2);border:1px solid var(--bd);border-radius:12px;padding:16px}
.res-sum{display:flex;gap:16px;margin-bottom:12px;flex-wrap:wrap}
.rok{color:var(--grn);font-weight:600;font-size:13px}
.rfail{color:var(--red);font-size:13px}

/* TABS */
.tabs{display:flex;gap:4px}
.tab{padding:5px 12px;border-radius:8px;font-size:12px;font-weight:500;cursor:pointer;
  border:1px solid transparent;color:var(--mut);transition:all .15s}
.tab.active{background:var(--s2);border-color:var(--bd);color:var(--txt)}

/* TOAST */
.toast{position:fixed;bottom:20px;right:20px;background:var(--s2);border:1px solid var(--bd);
  border-radius:12px;padding:12px 18px;font-size:12px;z-index:9999;
  transform:translateY(80px);opacity:0;transition:all .25s;max-width:300px}
.toast.show{transform:translateY(0);opacity:1}
.toast.ok{border-color:var(--grn);color:var(--grn)}
.toast.err{border-color:var(--red);color:var(--red)}

.spin{display:inline-block;width:12px;height:12px;border:2px solid rgba(255,255,255,.3);
  border-top-color:#fff;border-radius:50%;animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.empty{text-align:center;padding:32px;color:var(--mut);font-size:13px}
</style>
</head>
<body>

<header>
  <div class="logo">Trust<span>VA</span> &middot; Ticket Desk</div>
  <div class="hr">
    <div class="live"></div>
    <div class="dom">${DOMAIN}</div>
    <span class="synct" id="synct">not synced</span>
    <button class="btn btn-gh" onclick="loadAll()" id="rfbtn">&#8635; Refresh</button>
  </div>
</header>

<main>

  <!-- STATS -->
  <div class="stats">
    <div class="sc c1"><div class="sc-n" id="s-open">-</div><div class="sc-l">Open</div></div>
    <div class="sc c2"><div class="sc-n" id="s-unassigned">-</div><div class="sc-l">Unassigned</div></div>
    <div class="sc c3"><div class="sc-n" id="s-assigned">-</div><div class="sc-l">Assigned</div></div>
    <div class="sc c4"><div class="sc-n" id="s-unresolved">-</div><div class="sc-l">Unresolved</div></div>
    <div class="sc c5"><div class="sc-n" id="s-overdue">-</div><div class="sc-l">Overdue</div></div>
    <div class="sc c6"><div class="sc-n">${AGENT_IDS.length}</div><div class="sc-l">Agents</div></div>
  </div>

  <!-- STEP 1 -->
  <div class="sec">
    <div class="sec-h">
      <div class="sec-t">&#9889; Step 1 &mdash; Assign Unassigned Tickets</div>
      <div class="brow">
        <button class="btn btn-gh" onclick="sa(1)">Select All</button>
        <button class="btn btn-gh" onclick="sn(1)">Clear</button>
        <button class="btn btn-g" id="b1" onclick="doAssign()">Assign Unassigned Equally</button>
      </div>
    </div>
    <div class="sec-b">
      <p class="hint">Picks only unassigned open tickets and distributes them equally across selected agents. Does not touch already-assigned tickets.</p>
      <div class="ag-grid" id="g1"></div>
      <div class="selc" id="c1"></div>
      <div id="r1" style="margin-top:16px"></div>
    </div>
  </div>

  <!-- STEP 2 -->
  <div class="sec">
    <div class="sec-h">
      <div class="sec-t">&#128256; Step 2 &mdash; Shuffle ALL Open Tickets to Agents</div>
      <div class="brow">
        <button class="btn btn-gh" onclick="sa(2)">Select All</button>
        <button class="btn btn-gh" onclick="sn(2)">Clear</button>
        <button class="btn btn-o" id="b2" onclick="doShuffle()">Shuffle All to Selected</button>
      </div>
    </div>
    <div class="sec-b">
      <p class="hint">Redistributes ALL open tickets (already assigned + unassigned) equally to selected agents. Use this after Step 1 when agents are ready to work on unresolved tickets too.</p>
      <div class="ag-grid" id="g2"></div>
      <div class="selc" id="c2"></div>
      <div id="r2" style="margin-top:16px"></div>
    </div>
  </div>

  <!-- UNRESOLVED -->
  <div class="sec">
    <div class="sec-h">
      <div class="sec-t">&#128308; Unresolved Tickets</div>
      <div class="brow">
        <div class="tabs" id="utabs">
          <div class="tab active" onclick="flt('all',this)">All</div>
          <div class="tab" onclick="flt('unassigned',this)">Unassigned</div>
          <div class="tab" onclick="flt('overdue',this)">Overdue</div>
        </div>
        <button class="btn btn-gh" onclick="loadUnres()">&#8635;</button>
      </div>
    </div>
    <div class="sec-b">
      <div id="unres-list"><div class="empty">Loading...</div></div>
    </div>
  </div>

  <!-- AGENT WORKLOAD -->
  <div class="sec">
    <div class="sec-h">
      <div class="sec-t">&#128101; Agent Workload</div>
      <button class="btn btn-gh" onclick="loadAgents()">&#8635; Refresh</button>
    </div>
    <div class="sec-b">
      <div class="wl-grid" id="wl-grid"><div class="empty">Loading...</div></div>
    </div>
  </div>

</main>
<div class="toast" id="toast"></div>

<script>
const AGENTS = ${agentsJson};
const COLS = ["#6c63ff","#ff6584","#00e5a0","#ffd166","#38bdf8","#fb923c","#a78bfa","#34d399","#f472b6","#60a5fa","#facc15","#4ade80","#f87171","#818cf8"];
var sel1 = new Set(AGENTS.map(function(a){return a.id;}));
var sel2 = new Set(AGENTS.map(function(a){return a.id;}));
var allUnres = [], curFlt = 'all';

function mkGrid(n, gid, cid) {
  var sel = n===1 ? sel1 : sel2;
  document.getElementById(gid).innerHTML = AGENTS.map(function(a) {
    return '<label class="ag-tog on" id="t'+n+'-'+a.id+'" onclick="tgl('+n+','+a.id+',this)"><input type="checkbox" checked><div class="chk">&#10003;</div><span class="tname">'+a.name+'</span></label>';
  }).join('');
  updC(n);
}

function tgl(n, id, el) {
  var sel = n===1 ? sel1 : sel2;
  if (el.classList.contains('on')) {
    sel.delete(id); el.classList.remove('on'); el.querySelector('.chk').innerHTML='';
  } else {
    sel.add(id); el.classList.add('on'); el.querySelector('.chk').innerHTML='&#10003;';
  }
  updC(n);
}

function sa(n) {
  AGENTS.forEach(function(a) {
    var sel = n===1?sel1:sel2; sel.add(a.id);
    var el = document.getElementById('t'+n+'-'+a.id);
    if(el){el.classList.add('on');el.querySelector('.chk').innerHTML='&#10003;';}
  });
  updC(n);
}

function sn(n) {
  AGENTS.forEach(function(a) {
    var sel = n===1?sel1:sel2; sel.delete(a.id);
    var el = document.getElementById('t'+n+'-'+a.id);
    if(el){el.classList.remove('on');el.querySelector('.chk').innerHTML='';}
  });
  updC(n);
}

function updC(n) {
  var sel = n===1?sel1:sel2;
  document.getElementById('c'+n).textContent = sel.size+' agent'+(sel.size===1?'':'s')+' selected';
}

async function loadAll() {
  var btn = document.getElementById('rfbtn');
  btn.disabled=true; btn.innerHTML='<span class="spin"></span>';
  try { await Promise.all([loadStats(), loadAgents(), loadUnres()]); }
  catch(e) {}
  document.getElementById('synct').textContent = 'Synced '+new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'});
  btn.disabled=false; btn.innerHTML='&#8635; Refresh';
}

async function loadStats() {
  try {
    var d = await (await fetch('/api/stats')).json();
    document.getElementById('s-open').textContent      = d.open;
    document.getElementById('s-unassigned').textContent= d.unassigned;
    document.getElementById('s-assigned').textContent  = d.assigned;
    document.getElementById('s-unresolved').textContent= d.unresolved;
    document.getElementById('s-overdue').textContent   = d.overdue;
  } catch(e) { toast('Stats load failed','err'); }
}

async function loadAgents() {
  var g = document.getElementById('wl-grid');
  try {
    var agents = await (await fetch('/api/agents')).json();
    var mo = Math.max.apply(null, agents.map(function(a){return a.open;}));
    if(mo<1) mo=1;
    g.innerHTML = agents.map(function(a,i) {
      var ini = a.name.split(' ').map(function(w){return w[0];}).join('').toUpperCase().slice(0,2);
      var c = COLS[i%COLS.length];
      var pct = Math.round(a.open/mo*100);
      return '<div class="wl-card">'+
        '<div class="av" style="background:'+c+'22;color:'+c+'">'+ini+'</div>'+
        '<div class="wl-i">'+
          '<div class="wl-n">'+a.name+'</div>'+
          '<div class="wl-c"><span class="oc">'+a.open+' open</span><span class="uc">'+a.unresolved+' unresolved</span></div>'+
          '<div class="wl-bar"><div class="wl-bf" style="width:'+pct+'%;background:'+c+'"></div></div>'+
        '</div>'+
        '<button class="sf-btn" onclick="doReshuffle('+a.id+',\''+a.name+'\')">Shuffle</button>'+
      '</div>';
    }).join('');
  } catch(e) { g.innerHTML='<div class="empty">Failed to load agents</div>'; }
}

async function loadUnres() {
  try {
    allUnres = await (await fetch('/api/unresolved')).json();
    renderUnres();
  } catch(e) {
    document.getElementById('unres-list').innerHTML='<div class="empty">Failed to load</div>';
  }
}

function flt(f, el) {
  curFlt = f;
  document.querySelectorAll('#utabs .tab').forEach(function(t){t.classList.remove('active');});
  el.classList.add('active');
  renderUnres();
}

function renderUnres() {
  var now = new Date();
  var list = allUnres.slice();
  if (curFlt==='unassigned') list = list.filter(function(t){return !t.agent;});
  if (curFlt==='overdue')    list = list.filter(function(t){return t.due_by && new Date(t.due_by)<now;});
  if (list.length===0) {
    document.getElementById('unres-list').innerHTML='<div class="empty">No tickets in this filter &#10003;</div>';
    return;
  }
  var slbl = {2:'open',3:'pending',6:'on hold'};
  var scls = {2:'st-o',3:'st-p',6:'st-h'};
  var pcls = {1:'d1',2:'d2',3:'d3',4:'d4'};
  var rows = list.slice(0,100).map(function(t) {
    var ov = t.due_by && new Date(t.due_by)<now;
    var stCls = ov ? 'st-ov' : (scls[t.status]||'st-o');
    var stLbl = ov ? 'overdue' : (slbl[t.status]||'open');
    var agentHtml = t.agent
      ? '<span class="tag-ok">'+t.agent+'</span>'
      : '<span class="tag-ua">unassigned</span>';
    return '<div class="tkt-row">'+
      '<div class="dot '+(pcls[t.priority]||'d1')+'"></div>'+
      '<span class="tid">#'+t.id+'</span>'+
      '<span class="tsub">'+t.subject+'</span>'+
      '<span class="st '+stCls+'">'+stLbl+'</span>'+
      agentHtml+
    '</div>';
  }).join('');
  var more = list.length>100 ? '<div style="padding:8px 0;color:var(--mut);font-size:11px">...and '+(list.length-100)+' more</div>' : '';
  document.getElementById('unres-list').innerHTML =
    '<div style="font-size:11px;color:var(--mut);margin-bottom:10px">Showing '+Math.min(list.length,100)+' of '+list.length+' tickets</div>'+
    '<div class="tkt-list">'+rows+'</div>'+more;
}

async function doAssign() {
  if(sel1.size===0){toast('Select at least 1 agent!','err');return;}
  var btn=document.getElementById('b1');
  btn.disabled=true;btn.innerHTML='<span class="spin"></span> Assigning...';
  try {
    var d=await(await fetch('/api/assign-unassigned',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agentIds:[...sel1]})})).json();
    showRes('r1',d);
    await loadAll();
  } catch(e){toast('Assignment failed','err');}
  btn.disabled=false;btn.innerHTML='Assign Unassigned Equally';
}

async function doShuffle() {
  if(sel2.size===0){toast('Select at least 1 agent!','err');return;}
  var total = document.getElementById('s-open').textContent;
  if(!confirm('Reassign ALL '+total+' open tickets to '+sel2.size+' selected agents?')) return;
  var btn=document.getElementById('b2');
  btn.disabled=true;btn.innerHTML='<span class="spin"></span> Shuffling...';
  try {
    var d=await(await fetch('/api/shuffle-all',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agentIds:[...sel2]})})).json();
    showRes('r2',d);
    await loadAll();
  } catch(e){toast('Shuffle failed','err');}
  btn.disabled=false;btn.innerHTML='Shuffle All to Selected';
}

async function doReshuffle(agentId, agentName) {
  if(!confirm("Move all of "+agentName+"'s tickets to other agents?")) return;
  toast('Reshuffling '+agentName+'...');
  try {
    var d=await(await fetch('/api/reshuffle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agentId:agentId})})).json();
    toast('Moved '+d.reassigned+' tickets from '+agentName,'ok');
    await loadAll();
  } catch(e){toast('Reshuffle failed','err');}
}

function showRes(elId, data) {
  if(data.assigned===0) {
    document.getElementById(elId).innerHTML='<div class="empty">&#10003; No unassigned tickets found &mdash; all clear!</div>';
    toast('Nothing to assign','ok');
    return;
  }
  var rows=(data.tickets||[]).slice(0,60).map(function(t){
    return '<div class="tkt-row"><span class="tid">#'+t.id+'</span><span class="tsub">'+t.subject+'</span>'+(t.ok?'<span class="tag-ok">&rarr; '+t.agent+'</span>':'<span class="tag-fail">failed</span>')+'</div>';
  }).join('');
  var more = data.tickets.length>60 ? '<div style="padding:8px 0;color:var(--mut);font-size:11px">...and '+(data.tickets.length-60)+' more</div>' : '';
  document.getElementById(elId).innerHTML=
    '<div class="res-box"><div class="res-sum"><span class="rok">&#10003; '+data.assigned+' assigned</span>'+(data.failed>0?'<span class="rfail">&#10007; '+data.failed+' failed</span>':'')+'</div><div class="tkt-list">'+rows+'</div>'+more+'</div>';
  toast(data.assigned+' tickets assigned!','ok');
}

function toast(msg,type) {
  var t=document.getElementById('toast');
  t.textContent=msg;
  t.className='toast show'+(type?' '+type:'');
  clearTimeout(window._tt);
  window._tt=setTimeout(function(){t.className='toast';},3000);
}

mkGrid(1,'g1','c1');
mkGrid(2,'g2','c2');
loadAll();
setInterval(loadAll,90000);
</script>
</body>
</html>`;
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────

const server = http.createServer(async function(req, res) {
  const p = url.parse(req.url).pathname;

  function json(code, data) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  if (p === "/" || p === "/dashboard") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(buildHTML());
    return;
  }

  if (p === "/api/stats") {
    try { json(200, await getStats()); }
    catch(e) { json(500, { error: e.message }); }
    return;
  }

  if (p === "/api/agents") {
    try { json(200, await getAgentWorkload()); }
    catch(e) { json(500, { error: e.message }); }
    return;
  }

  if (p === "/api/unresolved") {
    try { json(200, await getUnresolvedTickets()); }
    catch(e) { json(500, { error: e.message }); }
    return;
  }

  if (req.method === "POST") {
    var body = await new Promise(function(resolve) {
      var b = "";
      req.on("data", function(c) { b += c; });
      req.on("end", function() { resolve(JSON.parse(b)); });
    });

    if (p === "/api/assign-unassigned") {
      try { json(200, await assignUnassigned(body.agentIds)); }
      catch(e) { json(500, { error: e.message }); }
      return;
    }

    if (p === "/api/shuffle-all") {
      try { json(200, await shuffleAll(body.agentIds)); }
      catch(e) { json(500, { error: e.message }); }
      return;
    }

    if (p === "/api/reshuffle") {
      try { json(200, await reshuffleOneAgent(body.agentId)); }
      catch(e) { json(500, { error: e.message }); }
      return;
    }
  }

  json(404, { error: "not found" });
});

server.listen(PORT, function() {
  console.log("🌐 TrustVA Ticket Desk running on port " + PORT);
});

// ── CRON JOBS (IST) ───────────────────────────────────────────────────────────
// 9:30 AM IST Mon-Sat
cron.schedule("0 4 * * 1-6", function() {
  assignUnassigned(AGENT_IDS).then(function(r) {
    console.log("9:30am cron: assigned " + r.assigned + " tickets");
  });
}, { timezone: "Asia/Kolkata" });

// Surge check every 30 min during work hours
cron.schedule("*/30 3-14 * * 1-6", async function() {
  try {
    var all = await fdAll("new_and_my_open");
    var unassigned = all.filter(function(t) { return t.status === 2 && !t.responder_id; });
    if (unassigned.length >= 20) {
      console.log("Surge detected: " + unassigned.length + " unassigned — auto assigning");
      await assignUnassigned(AGENT_IDS);
    } else {
      console.log("Surge check: " + unassigned.length + " unassigned (ok)");
    }
  } catch(e) { console.error("Surge check failed:", e.message); }
}, { timezone: "Asia/Kolkata" });

console.log("🚀 TrustVA Ticket Desk started!");
console.log("❌ Never closes or resolves any ticket — only assigns");
console.log("👥 " + AGENT_IDS.length + " agents: " + AGENT_NAMES.join(", "));
