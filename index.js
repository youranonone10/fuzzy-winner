const cron  = require("node-cron");
const axios = require("axios");
const http  = require("http");
const url   = require("url");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DOMAIN      = process.env.FRESHDESK_DOMAIN;
const API_KEY     = process.env.FRESHDESK_API_KEY;
const AGENT_IDS   = (process.env.AGENT_IDS || "").split(",").map(s => parseInt(s.trim())).filter(Boolean);
const AGENT_NAMES = (process.env.AGENT_NAMES || "").split(",").map(s => s.trim()).filter(Boolean);
const PORT        = process.env.PORT || 3000;
const auth        = { username: API_KEY, password: "X" };

// Startup validation
if (!DOMAIN || !API_KEY || !AGENT_IDS.length) {
  console.error("❌ Missing env vars! Need: FRESHDESK_DOMAIN, FRESHDESK_API_KEY, AGENT_IDS, AGENT_NAMES");
}
console.log("✅ Config loaded:", { DOMAIN, AGENT_IDS, AGENT_NAMES });

// ─── FRESHDESK HELPERS ────────────────────────────────────────────────────────
async function fetchAllPages(filter) {
  let page = 1, all = [];
  while (true) {
    const endpoint = filter
      ? `https://${DOMAIN}/api/v2/tickets?filter=${filter}&per_page=100&page=${page}`
      : `https://${DOMAIN}/api/v2/tickets?per_page=100&page=${page}`;
    let res;
    try {
      res = await axios.get(endpoint, { auth });
    } catch (err) {
      console.error("Freshdesk API fetch failed:", {
        endpoint,
        page,
        status: err.response?.status,
        data: err.response?.data || err.message
      });
      throw new Error(err.response?.data?.description || err.response?.data?.message || err.message);
    }
    if (!Array.isArray(res.data)) {
      console.error("Unexpected Freshdesk response format:", { endpoint, page, data: res.data });
      throw new Error("Unexpected Freshdesk API response format");
    }
    all = all.concat(res.data);
    if (res.data.length < 100) break;
    page++;
    if (page > 10) break;
  }
  return all;
}

async function getStats() {
  const all = await fetchAllPages();

  const open       = all.filter(t => t.status === 2);
  const pending    = all.filter(t => t.status === 3);
  const unassigned = open.filter(t => !t.responder_id);
  const assigned   = open.filter(t => !!t.responder_id);
  const overdue    = all.filter(t => t.due_by && new Date(t.due_by) < new Date() && t.status < 4);
  const unresolved = all.filter(t => t.status < 4);

  return {
    open: open.length,
    unassigned: unassigned.length,
    assigned: assigned.length,
    pending: pending.length,
    overdue: overdue.length,
    unresolved: unresolved.length,
    unresolvedTickets: unresolved.map(t => ({
      id: t.id,
      subject: t.subject || "No subject",
      status: t.status,
      priority: t.priority,
      responder_id: t.responder_id,
      due_by: t.due_by,
      created_at: t.created_at
    })),
    unassignedTickets: unassigned.slice(0, 200).map(t => ({
      id: t.id, subject: t.subject || "No subject", priority: t.priority, created_at: t.created_at
    }))
  };
}

async function getAgentCounts() {
  const all = await fetchAllPages();
  const open = all.filter(t => t.status === 2);
  const unresolved = all.filter(t => t.status < 4);
  return AGENT_IDS.map((id, i) => ({
    id,
    name: AGENT_NAMES[i] || "Agent " + (i + 1),
    count: open.filter(t => t.responder_id === id).length,
    unresolved: unresolved.filter(t => t.responder_id === id).length
  }));
}

async function assignTicket(ticketId, agentId) {
  try {
    await axios.put(
      `https://${DOMAIN}/api/v2/tickets/${ticketId}`,
      { responder_id: agentId },
      { auth, headers: { "Content-Type": "application/json" } }
    );
    return true;
  } catch (err) {
    console.error(`Failed #${ticketId}:`, err.response?.data || err.message);
    return false;
  }
}

async function runUnassignedOnly(agentIdList) {
  agentIdList = (agentIdList || AGENT_IDS).map(id => parseInt(id)).filter(id => AGENT_IDS.includes(id));
  if (!agentIdList.length) return { assigned: 0, failed: 0, tickets: [], perAgent: {}, error: "No valid agents selected" };
  const all = await fetchAllPages();
  const unassigned = all.filter(t => t.status === 2 && !t.responder_id);
  if (!unassigned.length) return { assigned: 0, failed: 0, tickets: [], perAgent: {} };

  let assigned = 0, failed = 0;
  const perAgent = {};
  agentIdList.forEach((id, i) => {
    const idx = AGENT_IDS.indexOf(id);
    perAgent[id] = { name: AGENT_NAMES[idx] || "Agent " + (i + 1), count: 0 };
  });
  const results = [];

  for (let i = 0; i < unassigned.length; i++) {
    const ticket  = unassigned[i];
    const agentId = agentIdList[i % agentIdList.length];
    const ok = await assignTicket(ticket.id, agentId);
    if (ok) { perAgent[agentId].count++; assigned++; }
    else failed++;
    results.push({ id: ticket.id, subject: ticket.subject || "No subject", agent: perAgent[agentId]?.name, type: "unassigned", ok });
  }
  return { assigned, failed, perAgent, tickets: results };
}

async function runFullAssignment(agentIdList) {
  agentIdList = (agentIdList || AGENT_IDS).map(id => parseInt(id)).filter(id => AGENT_IDS.includes(id));
  if (!agentIdList.length) return { assigned: 0, failed: 0, tickets: [], perAgent: {}, error: "No valid agents selected" };
  const all = await fetchAllPages();

  const unassigned = all.filter(t => t.status === 2 && !t.responder_id);
  const unresolved = all.filter(t => t.status < 4 && !!t.responder_id);
  const toAssign = [...unassigned, ...unresolved];

  if (!toAssign.length) return { assigned: 0, failed: 0, tickets: [], perAgent: {} };

  let assigned = 0, failed = 0;
  const perAgent = {};
  agentIdList.forEach((id, i) => {
    const idx = AGENT_IDS.indexOf(id);
    perAgent[id] = { name: AGENT_NAMES[idx] || "Agent " + (i + 1), count: 0 };
  });
  const results = [];

  for (let i = 0; i < unassigned.length; i++) {
    const ticket  = unassigned[i];
    const agentId = agentIdList[i % agentIdList.length];
    const ok = await assignTicket(ticket.id, agentId);
    if (ok) { perAgent[agentId].count++; assigned++; }
    else failed++;
    results.push({ id: ticket.id, subject: ticket.subject || "No subject", agent: perAgent[agentId]?.name, type: "unassigned", ok });
  }

  for (let i = 0; i < unresolved.length; i++) {
    const ticket  = unresolved[i];
    const agentId = agentIdList[i % agentIdList.length];
    const ok = await assignTicket(ticket.id, agentId);
    if (ok) { perAgent[agentId].count++; assigned++; }
    else failed++;
    results.push({ id: ticket.id, subject: ticket.subject || "No subject", agent: perAgent[agentId]?.name, type: "unresolved", ok });
  }
  return { assigned, failed, perAgent, tickets: results };
}

async function reshuffleAgent(agentId) {
  agentId = parseInt(agentId);
  if (!AGENT_IDS.includes(agentId)) return { reassigned: 0, total: 0, error: "Invalid agentId" };
  const all = await fetchAllPages();
  const tickets = all.filter(t => t.responder_id === agentId && t.status < 4);
  const otherAgents = AGENT_IDS.filter(id => id !== agentId);
  if (!otherAgents.length) return { reassigned: 0, total: tickets.length };
  let reassigned = 0;
  for (let i = 0; i < tickets.length; i++) {
    const ok = await assignTicket(tickets[i].id, otherAgents[i % otherAgents.length]);
    if (ok) reassigned++;
  }
  return { reassigned, total: tickets.length };
}

// ─── HTML DASHBOARD ───────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TrustVA · Ticket Desk</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@700;800&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#080810;--surface:#10101a;--surface2:#181825;--border:#252535;
  --accent:#6c63ff;--accent2:#ff6584;--green:#00e5a0;--yellow:#ffd166;--orange:#ff9f43;
  --text:#e8e8f4;--muted:#5a5a72;
  --fh:'Syne',sans-serif;--fb:'DM Sans',sans-serif;--fm:'DM Mono',monospace;
}
body{background:var(--bg);color:var(--text);font-family:var(--fb);min-height:100vh}
body::before{content:'';position:fixed;top:-300px;right:-200px;width:700px;height:700px;background:radial-gradient(circle,rgba(108,99,255,0.07) 0%,transparent 65%);pointer-events:none}
body::after{content:'';position:fixed;bottom:-200px;left:-100px;width:500px;height:500px;background:radial-gradient(circle,rgba(255,101,132,0.05) 0%,transparent 65%);pointer-events:none}

header{position:sticky;top:0;z-index:100;padding:16px 32px;border-bottom:1px solid var(--border);background:rgba(8,8,16,0.9);backdrop-filter:blur(16px);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.logo{font-family:var(--fh);font-size:18px;font-weight:800;letter-spacing:-0.5px}
.logo span{color:var(--accent)}
.hright{display:flex;align-items:center;gap:10px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);animation:blink 2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.dbadge{font-family:var(--fm);font-size:11px;color:var(--muted);background:var(--surface2);padding:3px 10px;border-radius:20px;border:1px solid var(--border)}
.last-sync{font-size:11px;color:var(--muted)}

main{max-width:1280px;margin:0 auto;padding:28px 24px}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:28px}
.sc{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px 20px;position:relative;overflow:hidden;transition:border-color .2s,transform .2s;cursor:default}
.sc:hover{transform:translateY(-2px)}
.sc::after{content:'';position:absolute;top:0;left:0;right:0;height:2px;border-radius:2px 2px 0 0}
.sc.purple::after{background:var(--accent)}
.sc.red::after{background:var(--accent2)}
.sc.green::after{background:var(--green)}
.sc.yellow::after{background:var(--yellow)}
.sc.orange::after{background:var(--orange)}
.sc.gray::after{background:var(--muted)}
.sn{font-family:var(--fh);font-size:32px;font-weight:800;line-height:1;margin-bottom:5px}
.sl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:500}

.sec{background:var(--surface);border:1px solid var(--border);border-radius:18px;margin-bottom:20px;overflow:hidden}
.sh{padding:18px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.st{font-family:var(--fh);font-size:15px;font-weight:700}
.sb{padding:20px 22px}

.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:9px;font-size:13px;font-weight:500;font-family:var(--fb);cursor:pointer;border:none;transition:all .15s;white-space:nowrap}
.bp{background:var(--accent);color:#fff}.bp:hover{background:#7c74ff;transform:translateY(-1px)}
.bg{background:var(--green);color:#000;font-weight:600}.bg:hover{opacity:.85;transform:translateY(-1px)}
.bo{background:transparent;border:1px solid var(--border);color:var(--text)}.bo:hover{border-color:var(--accent);color:var(--accent)}
.btn:disabled{opacity:.4;cursor:not-allowed;transform:none!important}
.bgrp{display:flex;gap:8px;flex-wrap:wrap}

.asg{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;margin-bottom:14px}
.atog{display:flex;align-items:center;gap:8px;padding:9px 13px;border-radius:9px;border:1px solid var(--border);background:var(--surface2);cursor:pointer;transition:all .15s;user-select:none}
.atog.on{border-color:var(--accent);background:rgba(108,99,255,.12)}
.atog input{display:none}
.ck{width:15px;height:15px;border-radius:4px;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:9px;transition:all .15s}
.atog.on .ck{background:var(--accent);border-color:var(--accent);color:#fff}
.tn{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.ag{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.ac{background:var(--surface2);border:1px solid var(--border);border-radius:13px;padding:14px;display:flex;align-items:center;gap:11px;transition:all .2s}
.ac:hover{border-color:var(--accent);transform:translateY(-2px)}
.av{width:38px;height:38px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-family:var(--fh);font-size:13px;font-weight:700;flex-shrink:0}
.ai{flex:1;min-width:0}
.an{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.astat{font-size:11px;color:var(--muted);font-family:var(--fm)}
.abar{height:3px;border-radius:2px;background:var(--border);margin-top:7px;overflow:hidden}
.abf{height:100%;border-radius:2px;transition:width .6s ease}
.sbtn{padding:5px 9px;font-size:11px;border-radius:7px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;transition:all .15s;font-family:var(--fb);white-space:nowrap}
.sbtn:hover{border-color:var(--accent2);color:var(--accent2)}

.tlist{max-height:380px;overflow-y:auto}
.tlist::-webkit-scrollbar{width:3px}
.tlist::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.tr{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);font-size:13px}
.tr:last-child{border-bottom:none}
.tid{font-family:var(--fm);font-size:11px;color:var(--accent);min-width:58px;flex-shrink:0}
.tsub{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{display:inline-block;padding:1px 7px;border-radius:20px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;flex-shrink:0}
.tag-open{background:rgba(108,99,255,.15);color:var(--accent)}
.tag-pending{background:rgba(255,209,102,.15);color:var(--yellow)}
.tag-overdue{background:rgba(255,101,132,.2);color:var(--accent2)}
.tag-unassigned{background:rgba(255,159,67,.15);color:var(--orange)}
.tag-priority{background:rgba(56,189,248,.15);color:#38bdf8}
.tag-ok{background:rgba(0,229,160,.15);color:var(--green)}
.tag-fail{background:rgba(255,101,132,.15);color:var(--accent2)}
.tagent{font-size:11px;color:var(--green);font-family:var(--fm);white-space:nowrap;flex-shrink:0}
.pdot{width:6px;height:6px;border-radius:50%;flex-shrink:0}

.toast{position:fixed;bottom:24px;right:24px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:12px 18px;font-size:13px;z-index:9999;transform:translateY(100px);opacity:0;transition:all .3s;max-width:300px;box-shadow:0 8px 32px rgba(0,0,0,.4)}
.toast.show{transform:translateY(0);opacity:1}
.toast.success{border-color:var(--green);color:var(--green)}
.toast.error{border-color:var(--accent2);color:var(--accent2)}
.toast.info{border-color:var(--accent);color:var(--accent)}

.spin{display:inline-block;width:13px;height:13px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.empty{text-align:center;padding:36px;color:var(--muted);font-size:13px}
.scnt{font-size:12px;color:var(--muted);margin-top:6px}
.divider{height:1px;background:var(--border);margin:14px 0}
.rsum{display:flex;gap:16px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
.err-box{background:rgba(255,101,132,.08);border:1px solid rgba(255,101,132,.3);border-radius:10px;padding:14px 18px;color:var(--accent2);font-size:13px;font-family:var(--fm)}

@media(max-width:600px){
  header{padding:12px 16px}
  main{padding:16px}
  .stats{grid-template-columns:1fr 1fr}
  .sn{font-size:26px}
}
</style>
</head>
<body>
<header>
  <div class="logo">Trust<span>VA</span> · Ticket Desk</div>
  <div class="hright">
    <div class="dot"></div>
    <div class="dbadge" id="dlbl">${DOMAIN || "not set"}</div>
    <span class="last-sync" id="lsync"></span>
    <button class="btn bo" id="rbtn" onclick="loadAll()">↻ Refresh</button>
  </div>
</header>

<main>
  <!-- STATS -->
  <div class="stats">
    <div class="sc purple"><div class="sn" id="s-open">—</div><div class="sl">Open</div></div>
    <div class="sc red"><div class="sn" id="s-unassigned">—</div><div class="sl">Unassigned</div></div>
    <div class="sc green"><div class="sn" id="s-assigned">—</div><div class="sl">Assigned</div></div>
    <div class="sc orange"><div class="sn" id="s-unresolved">—</div><div class="sl">Unresolved</div></div>
    <div class="sc yellow"><div class="sn" id="s-pending">—</div><div class="sl">Pending</div></div>
    <div class="sc gray"><div class="sn" id="s-overdue">—</div><div class="sl">Overdue</div></div>
    <div class="sc purple"><div class="sn">${AGENT_IDS.length}</div><div class="sl">Agents</div></div>
  </div>
  <div id="stats-error"></div>

  <!-- ASSIGN ALL -->
  <div class="sec">
    <div class="sh">
      <div class="st">⚡ Assign All Unassigned Now</div>
      <button class="btn bg" id="aall-btn" onclick="assignAllNow()">→ Assign All Equally</button>
    </div>
    <div class="sb">
      <div id="aall-result" class="empty">Click "Assign All Equally" to distribute all <strong id="ucount-hint">—</strong> unassigned tickets equally across all ${AGENT_IDS.length} agents.</div>
    </div>
  </div>

  <!-- ASSIGN TO SPECIFIC AGENTS -->
  <div class="sec">
    <div class="sh">
      <div>
        <div class="st">🎯 Assign to Specific Agents</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">Select agents → choose mode below</div>
      </div>
      <div class="bgrp">
        <button class="btn bo" onclick="selAll()">All</button>
        <button class="btn bo" onclick="selNone()">None</button>
        <button class="btn bo" id="asel-u-btn" onclick="assignSelectedUnassigned()">Unassigned Only</button>
        <button class="btn bp" id="asel-f-btn" onclick="assignSelectedFull()">Unassigned + Unresolved</button>
      </div>
    </div>
    <div class="sb">
      <div class="asg" id="asel-grid"></div>
      <div class="scnt" id="scnt"></div>
      <div id="asel-result"></div>
    </div>
  </div>

  <!-- UNRESOLVED TICKETS -->
  <div class="sec">
    <div class="sh">
      <div>
        <div class="st">🔴 Unresolved Tickets</div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">All open + pending — not yet resolved</div>
      </div>
      <div class="bgrp">
        <button class="btn bo" onclick="filterUR('all')">All</button>
        <button class="btn bo" onclick="filterUR('unassigned')">Unassigned</button>
        <button class="btn bo" onclick="filterUR('overdue')">Overdue</button>
      </div>
    </div>
    <div class="sb">
      <div class="tlist" id="ur-list"><div class="empty">Loading...</div></div>
    </div>
  </div>

  <!-- AGENT WORKLOAD -->
  <div class="sec">
    <div class="sh">
      <div class="st">👥 Agent Workload</div>
      <button class="btn bo" onclick="loadAgents()">↻ Refresh</button>
    </div>
    <div class="sb">
      <div class="ag" id="agent-grid"><div class="empty">Loading...</div></div>
    </div>
  </div>
</main>

<div class="toast" id="toast"></div>

<script>
const AGENTS = ${JSON.stringify(AGENT_IDS.map((id, i) => ({ id, name: AGENT_NAMES[i] || "Agent " + (i + 1) })))};
const COLS = ["#6c63ff","#ff6584","#00e5a0","#ffd166","#ff9f43","#38bdf8","#a78bfa","#34d399","#f472b6","#60a5fa","#facc15","#4ade80","#f87171","#818cf8"];
let selAgents = new Set(AGENTS.map(a => a.id));
let urData = [];

async function apiJSON(path, options) {
  const r = await fetch(path, options);
  let d = {};
  try { d = await r.json(); } catch(_) {}
  if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
  if (d && d.error) throw new Error(d.error);
  return d;
}

// ── AGENT SELECT ──────────────────────────────────────────────────────────────
function initSel() {
  // selAgents is already populated above — just render checkboxes
  document.getElementById("asel-grid").innerHTML = AGENTS.map(a =>
    '<label class="atog on" id="tog-' + a.id + '" onclick="togAgent(' + a.id + ')">' +
    '<div class="ck">✓</div><span class="tn">' + esc(a.name) + '</span></label>'
  ).join("");
  updScnt();
}

function togAgent(id) {
  const el = document.getElementById("tog-" + id);
  if (selAgents.has(id)) {
    selAgents.delete(id);
    el.className = "atog";
    el.querySelector(".ck").textContent = "";
  } else {
    selAgents.add(id);
    el.className = "atog on";
    el.querySelector(".ck").textContent = "✓";
  }
  updScnt();
}

function selAll()  { AGENTS.forEach(a => { selAgents.add(a.id);    const e=document.getElementById("tog-"+a.id); e.className="atog on"; e.querySelector(".ck").textContent="✓"; }); updScnt(); }
function selNone() { AGENTS.forEach(a => { selAgents.delete(a.id); const e=document.getElementById("tog-"+a.id); e.className="atog";    e.querySelector(".ck").textContent="";  }); updScnt(); }
function updScnt() { document.getElementById("scnt").textContent = selAgents.size + " agent" + (selAgents.size===1?"":"s") + " selected"; }

// ── LOAD DASHBOARD ────────────────────────────────────────────────────────────
async function loadAll() {
  const btn = document.getElementById("rbtn");
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  try {
    const d = await apiJSON("/api/stats");

    document.getElementById("s-open").textContent       = d.open;
    document.getElementById("s-unassigned").textContent = d.unassigned;
    document.getElementById("s-assigned").textContent   = d.assigned;
    document.getElementById("s-unresolved").textContent = d.unresolved;
    document.getElementById("s-pending").textContent    = d.pending;
    document.getElementById("s-overdue").textContent    = d.overdue;
    document.getElementById("ucount-hint").textContent  = d.unassigned;
    urData = d.unresolvedTickets || [];
    renderUR(urData);
    await loadAgents();
    document.getElementById("stats-error").innerHTML = "";
    document.getElementById("lsync").textContent = "synced " + new Date().toLocaleTimeString("en-IN");
  } catch(e) {
    document.getElementById("stats-error").innerHTML = '<div class="err-box">Failed to load stats: ' + esc(e.message) + '</div>';
    toast("API error: " + e.message, "error");
    console.error(e);
  }
  btn.disabled = false; btn.innerHTML = "↻ Refresh";
}

// ── UNRESOLVED LIST ───────────────────────────────────────────────────────────
const STATUS_LABEL = {2:"open", 3:"pending"};
const P_COLOR = {1:"#5a5a72", 2:"#ffd166", 3:"#ff9f43", 4:"#ff6584"};

function renderUR(tickets) {
  const el = document.getElementById("ur-list");
  if (!tickets.length) { el.innerHTML = '<div class="empty">🎉 No unresolved tickets!</div>'; return; }
  el.innerHTML = tickets.map(t => {
    const overdue = t.due_by && new Date(t.due_by) < new Date() && t.status < 4;
    const agName  = AGENTS.find(a => a.id === t.responder_id)?.name || "";
    const stLabel = overdue ? "overdue" : (STATUS_LABEL[t.status] || "open");
    const stClass = overdue ? "tag-overdue" : "tag-" + stLabel;
    return '<div class="tr">' +
      '<span class="tid">#' + t.id + '</span>' +
      '<div class="pdot" style="background:' + (P_COLOR[t.priority||1]) + '" title="P' + (t.priority||1) + '"></div>' +
      '<span class="tag tag-priority">P' + (t.priority || 1) + '</span>' +
      '<span class="tsub">' + esc(t.subject) + '</span>' +
      '<span class="tag ' + stClass + '">' + stLabel + '</span>' +
      (!t.responder_id ? '<span class="tag tag-unassigned">unassigned</span>' : '') +
      (agName ? '<span class="tagent">' + esc(agName) + '</span>' : '') +
    '</div>';
  }).join("");
}

function filterUR(mode) {
  if (mode === "all")        renderUR(urData);
  if (mode === "unassigned") renderUR(urData.filter(t => !t.responder_id));
  if (mode === "overdue")    renderUR(urData.filter(t => t.due_by && new Date(t.due_by) < new Date() && t.status < 4));
}

// ── AGENT WORKLOAD ────────────────────────────────────────────────────────────
async function loadAgents() {
  const grid = document.getElementById("agent-grid");
  try {
    const d = await apiJSON("/api/agents");
    if (!d.length) { grid.innerHTML = '<div class="empty">No agent data</div>'; return; }
    const maxOpen = Math.max(...d.map(a => a.count), 1);
    grid.innerHTML = d.map((a, i) =>
      '<div class="ac">' +
        '<div class="av" style="background:' + COLS[i%COLS.length] + '22;color:' + COLS[i%COLS.length] + '">' + initials(a.name) + '</div>' +
        '<div class="ai">' +
          '<div class="an">' + esc(a.name) + '</div>' +
          '<div class="astat">' + a.count + ' open · ' + a.unresolved + ' unresolved</div>' +
          '<div class="abar"><div class="abf" style="width:' + Math.round(a.count/maxOpen*100) + '%;background:' + COLS[i%COLS.length] + '"></div></div>' +
        '</div>' +
        '<button class="sbtn" onclick="doReshuffle(' + a.id + ',\'' + esc(a.name) + '\')">Shuffle</button>' +
      '</div>'
    ).join("");
  } catch(e) {
    grid.innerHTML = '<div class="err-box">Failed to load agents: ' + e.message + '</div>';
  }
}

// ── ASSIGN ACTIONS ────────────────────────────────────────────────────────────
async function assignAllNow() {
  const btn = document.getElementById("aall-btn");
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Assigning...';
  try {
    const d = await apiJSON("/api/assign-unassigned", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ agentIds: AGENTS.map(a=>a.id) }) });
    showResult(d, "aall-result");
    await loadAll();
  } catch(e) { toast("Assignment failed: " + e.message, "error"); }
  btn.disabled = false; btn.innerHTML = "→ Assign All Equally";
}

async function assignSelectedUnassigned() {
  if (!selAgents.size) { toast("Select at least one agent!", "error"); return; }
  const btn = document.getElementById("asel-u-btn");
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  try {
    const d = await apiJSON("/api/assign-unassigned", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ agentIds:[...selAgents] }) });
    showResult(d, "asel-result");
    await loadAll();
  } catch(e) { toast("Failed: " + e.message, "error"); }
  btn.disabled = false; btn.innerHTML = "Unassigned Only";
}

async function assignSelectedFull() {
  if (!selAgents.size) { toast("Select at least one agent!", "error"); return; }
  const btn = document.getElementById("asel-f-btn");
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Working...';
  try {
    const d = await apiJSON("/api/assign-full", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ agentIds:[...selAgents] }) });
    showResult(d, "asel-result");
    await loadAll();
  } catch(e) { toast("Failed: " + e.message, "error"); }
  btn.disabled = false; btn.innerHTML = "Unassigned + Unresolved";
}

async function doReshuffle(id, name) {
  if (!confirm("Move ALL of " + name + "'s tickets to other agents?")) return;
  toast("Reshuffling " + name + "...", "info");
  try {
    const d = await apiJSON("/api/reshuffle", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ agentId: id }) });
    toast("Moved " + d.reassigned + " tickets from " + name, "success");
    await loadAll();
  } catch(e) { toast("Reshuffle failed", "error"); }
}

// ── RESULT RENDERER ───────────────────────────────────────────────────────────
function showResult(data, elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (data.error) { el.innerHTML = '<div class="err-box">Error: ' + esc(data.error) + '</div>'; return; }
  if (!data.assigned) { el.innerHTML = '<div class="empty" style="padding:16px">✅ No unassigned tickets — all clear!</div>'; toast("Nothing to assign!", "success"); return; }
  const rows = (data.tickets||[]).slice(0,60).map(t =>
    '<div class="tr">' +
    '<span class="tid">#' + t.id + '</span>' +
    '<span class="tag ' + (t.type==="unassigned"?"tag-unassigned":"tag-pending") + '">' + (t.type||"") + '</span>' +
    '<span class="tsub">' + esc(t.subject) + '</span>' +
    (t.ok ? '<span class="tagent">→ ' + esc(t.agent||"") + '</span>' : '<span class="tag tag-fail">failed</span>') +
    '</div>'
  ).join("");
  el.innerHTML =
    '<div class="divider"></div>' +
    '<div class="rsum"><span style="color:var(--green);font-weight:600">✅ ' + data.assigned + ' assigned</span>' +
    (data.failed > 0 ? '<span style="color:var(--accent2)">❌ ' + data.failed + ' failed</span>' : '') + '</div>' +
    '<div class="tlist">' + rows + (data.tickets.length>60 ? '<div style="padding:8px;color:var(--muted);font-size:12px">...and '+(data.tickets.length-60)+' more</div>' : '') + '</div>';
  toast(data.assigned + " tickets assigned!", "success");
}

function initials(n){ return (n||"?").split(" ").map(w=>w[0]||"").join("").toUpperCase().slice(0,2)||"??"; }
function esc(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function toast(msg, type) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = "toast show" + (type?" "+type:"");
  clearTimeout(window._tt);
  window._tt = setTimeout(()=>t.className="toast", 3500);
}

initSel();
loadAll();
setInterval(loadAll, 90000);
</script>
</body>
</html>`;

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const p = url.parse(req.url).pathname;
  res.setHeader("Content-Type", "application/json");

  if (p === "/" || p === "/dashboard") {
    res.setHeader("Content-Type", "text/html");
    res.writeHead(200);
    res.end(HTML);
    return;
  }

  if (p === "/api/stats") {
    try {
      const data = await getStats();
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch(e) {
      console.error("/api/stats error:", e.response?.data || e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (p === "/api/agents") {
    try {
      const data = await getAgentCounts();
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch(e) {
      console.error("/api/agents error:", e.response?.data || e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (p === "/api/assign-unassigned" && req.method === "POST") {
    let b = ""; req.on("data", c => b += c);
    req.on("end", async () => {
      try {
        const { agentIds } = JSON.parse(b);
        const result = await runUnassignedOnly(agentIds);
        if (result.error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: result.error }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch(e) {
        console.error("/api/assign-unassigned error:", e.response?.data || e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (p === "/api/assign-full" && req.method === "POST") {
    let b = ""; req.on("data", c => b += c);
    req.on("end", async () => {
      try {
        const { agentIds } = JSON.parse(b);
        const result = await runFullAssignment(agentIds);
        if (result.error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: result.error }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch(e) {
        console.error("/api/assign-full error:", e.response?.data || e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (p === "/api/reshuffle" && req.method === "POST") {
    let b = ""; req.on("data", c => b += c);
    req.on("end", async () => {
      try {
        const { agentId } = JSON.parse(b);
        const result = await reshuffleAgent(agentId);
        if (result.error) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: result.error }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch(e) {
        console.error("/api/reshuffle error:", e.response?.data || e.message);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => console.log("🌐 Dashboard live on port " + PORT));

// ─── CRON ─────────────────────────────────────────────────────────────────────
cron.schedule("0 4 * * 1-6", () => runUnassignedOnly(AGENT_IDS), { timezone: "Asia/Kolkata" });
cron.schedule("*/30 3-14 * * 1-6", async () => {
  try {
    const all = await fetchAllPages();
    const u = all.filter(t => t.status === 2 && !t.responder_id);
    if (u.length >= 20) { console.log("🚨 Surge: " + u.length + " unassigned — auto-assigning"); await runUnassignedOnly(AGENT_IDS); }
  } catch(e) { console.error("Cron error:", e.message); }
}, { timezone: "Asia/Kolkata" });

console.log("🚀 TrustVA Ticket Desk running!");
console.log("👥 " + AGENT_IDS.length + " agents: " + AGENT_NAMES.join(", "));
