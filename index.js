const cron  = require("node-cron");
const axios = require("axios");
const http  = require("http");
const url   = require("url");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DOMAIN      = process.env.FRESHDESK_DOMAIN;
const API_KEY     = process.env.FRESHDESK_API_KEY;
const AGENT_IDS   = process.env.AGENT_IDS.split(",").map(Number);
const AGENT_NAMES = process.env.AGENT_NAMES.split(",").map(s => s.trim());
const PORT        = process.env.PORT || 3000;
const auth        = { username: API_KEY, password: "X" };

// ─── FRESHDESK API ────────────────────────────────────────────────────────────
async function getAllOpenUnassigned() {
  let page = 1, all = [];
  while (true) {
    const res = await axios.get(
      "https://" + DOMAIN + "/api/v2/tickets?filter=new_and_my_open&per_page=100&page=" + page,
      { auth }
    );
    const batch = res.data;
    const unassigned = batch.filter(t => t.status === 2 && !t.responder_id);
    all = all.concat(unassigned);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

async function getAllOpenTickets() {
  let page = 1, all = [];
  while (true) {
    const res = await axios.get(
      "https://" + DOMAIN + "/api/v2/tickets?filter=new_and_my_open&per_page=100&page=" + page,
      { auth }
    );
    const batch = res.data;
    all = all.concat(batch.filter(t => t.status === 2));
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

async function getAgentTickets(agentId) {
  const res = await axios.get(
    "https://" + DOMAIN + "/api/v2/tickets?filter=new_and_my_open&per_page=100",
    { auth }
  );
  return res.data.filter(t => t.status === 2 && t.responder_id === agentId);
}

async function assignTicket(ticketId, agentId) {
  try {
    await axios.put(
      "https://" + DOMAIN + "/api/v2/tickets/" + ticketId,
      { responder_id: agentId },
      { auth, headers: { "Content-Type": "application/json" } }
    );
    return true;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error("Failed ticket #" + ticketId + ": " + detail);
    return false;
  }
}

async function runAssignment(agentIdList) {
  agentIdList = agentIdList || AGENT_IDS;
  const tickets = await getAllOpenUnassigned();
  if (tickets.length === 0) return { assigned: 0, failed: 0, perAgent: {}, tickets: [] };
  let assigned = 0, failed = 0;
  const perAgent = {};
  agentIdList.forEach((id, i) => {
    const idx = AGENT_IDS.indexOf(id);
    perAgent[id] = { name: AGENT_NAMES[idx] || ("Agent " + (i+1)), count: 0 };
  });
  const results = [];
  for (let i = 0; i < tickets.length; i++) {
    const ticket  = tickets[i];
    const agentId = agentIdList[i % agentIdList.length];
    const ok = await assignTicket(ticket.id, agentId);
    if (ok) { perAgent[agentId].count++; assigned++; }
    else failed++;
    results.push({ id: ticket.id, subject: ticket.subject, agent: perAgent[agentId]?.name, ok });
  }
  return { assigned, failed, perAgent, tickets: results };
}

async function reshuffleAgent(agentId) {
  const tickets = await getAgentTickets(agentId);
  const otherAgents = AGENT_IDS.filter(id => id !== agentId);
  let reassigned = 0;
  for (let i = 0; i < tickets.length; i++) {
    const newAgent = otherAgents[i % otherAgents.length];
    const ok = await assignTicket(tickets[i].id, newAgent);
    if (ok) reassigned++;
  }
  return { reassigned, total: tickets.length };
}

// ─── HTML DASHBOARD ───────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TrustVA · Ticket Desk</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@600;700;800&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0f;
  --surface:#111118;
  --surface2:#1a1a24;
  --border:#2a2a38;
  --accent:#6c63ff;
  --accent2:#ff6584;
  --green:#00e5a0;
  --yellow:#ffd166;
  --text:#e8e8f0;
  --muted:#6b6b80;
  --font-head:'Syne',sans-serif;
  --font-body:'DM Sans',sans-serif;
  --font-mono:'DM Mono',monospace;
}
body{background:var(--bg);color:var(--text);font-family:var(--font-body);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;top:-200px;right:-200px;width:600px;height:600px;background:radial-gradient(circle,rgba(108,99,255,0.08) 0%,transparent 70%);pointer-events:none;z-index:0}
body::after{content:'';position:fixed;bottom:-200px;left:-100px;width:500px;height:500px;background:radial-gradient(circle,rgba(255,101,132,0.06) 0%,transparent 70%);pointer-events:none;z-index:0}

header{position:relative;z-index:10;padding:20px 32px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:rgba(10,10,15,0.8);backdrop-filter:blur(12px);position:sticky;top:0}
.logo{font-family:var(--font-head);font-size:20px;font-weight:800;letter-spacing:-0.5px}
.logo span{color:var(--accent)}
.header-right{display:flex;align-items:center;gap:12px}
.live-dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
.domain-badge{font-family:var(--font-mono);font-size:11px;color:var(--muted);background:var(--surface2);padding:4px 10px;border-radius:20px;border:1px solid var(--border)}

main{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:32px 24px}

.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:32px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:20px 24px;position:relative;overflow:hidden;transition:border-color 0.2s}
.stat-card:hover{border-color:var(--accent)}
.stat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.stat-card.blue::before{background:var(--accent)}
.stat-card.red::before{background:var(--accent2)}
.stat-card.green::before{background:var(--green)}
.stat-card.yellow::before{background:var(--yellow)}
.stat-num{font-family:var(--font-head);font-size:36px;font-weight:800;line-height:1;margin-bottom:6px}
.stat-label{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:500}

.section{background:var(--surface);border:1px solid var(--border);border-radius:20px;margin-bottom:24px;overflow:hidden}
.section-head{padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.section-title{font-family:var(--font-head);font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px}
.section-body{padding:24px}

.btn{display:inline-flex;align-items:center;gap:6px;padding:10px 20px;border-radius:10px;font-size:13px;font-weight:500;font-family:var(--font-body);cursor:pointer;border:none;transition:all 0.15s;white-space:nowrap}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:#7c74ff;transform:translateY(-1px)}
.btn-danger{background:transparent;border:1px solid var(--accent2);color:var(--accent2)}
.btn-danger:hover{background:rgba(255,101,132,0.1)}
.btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-ghost:hover{border-color:var(--accent);color:var(--accent)}
.btn-green{background:var(--green);color:#000}
.btn-green:hover{opacity:0.85;transform:translateY(-1px)}
.btn:disabled{opacity:0.4;cursor:not-allowed;transform:none!important}

.agent-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.agent-card{background:var(--surface2);border:1px solid var(--border);border-radius:14px;padding:16px;display:flex;align-items:center;gap:12px;transition:all 0.2s}
.agent-card:hover{border-color:var(--accent);transform:translateY(-2px)}
.avatar{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-family:var(--font-head);font-size:14px;font-weight:700;flex-shrink:0}
.agent-info{flex:1;min-width:0}
.agent-name{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px}
.agent-count{font-size:12px;color:var(--muted);font-family:var(--font-mono)}
.agent-bar{height:3px;border-radius:2px;background:var(--border);margin-top:8px;overflow:hidden}
.agent-bar-fill{height:100%;border-radius:2px;background:var(--accent);transition:width 0.6s ease}
.reshuffle-btn{padding:6px 10px;font-size:11px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;transition:all 0.15s;white-space:nowrap;font-family:var(--font-body)}
.reshuffle-btn:hover{border-color:var(--accent2);color:var(--accent2)}

.agent-select-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;margin-bottom:16px}
.agent-toggle{display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:var(--surface2);cursor:pointer;transition:all 0.15s;user-select:none}
.agent-toggle.selected{border-color:var(--accent);background:rgba(108,99,255,0.1)}
.agent-toggle input{display:none}
.check{width:16px;height:16px;border-radius:4px;border:1px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all 0.15s;font-size:10px}
.agent-toggle.selected .check{background:var(--accent);border-color:var(--accent)}
.toggle-name{font-size:12px;font-weight:500}

.ticket-list{max-height:300px;overflow-y:auto}
.ticket-list::-webkit-scrollbar{width:4px}
.ticket-list::-webkit-scrollbar-track{background:transparent}
.ticket-list::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.ticket-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px}
.ticket-row:last-child{border-bottom:none}
.ticket-id{font-family:var(--font-mono);font-size:11px;color:var(--accent);min-width:60px}
.ticket-subj{flex:1;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ticket-agent{font-size:11px;color:var(--green);font-family:var(--font-mono);white-space:nowrap}
.ticket-fail{font-size:11px;color:var(--accent2);font-family:var(--font-mono)}

.toast{position:fixed;bottom:24px;right:24px;background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:14px 20px;font-size:13px;z-index:1000;transform:translateY(100px);opacity:0;transition:all 0.3s;max-width:320px}
.toast.show{transform:translateY(0);opacity:1}
.toast.success{border-color:var(--green);color:var(--green)}
.toast.error{border-color:var(--accent2);color:var(--accent2)}

.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:spin 0.7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.empty{text-align:center;padding:40px;color:var(--muted);font-size:14px}
.tag{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em}
.tag-open{background:rgba(108,99,255,0.15);color:var(--accent)}
.tag-unassigned{background:rgba(255,101,132,0.15);color:var(--accent2)}

@media(max-width:600px){
  header{padding:14px 16px}
  main{padding:16px}
  .stats-row{grid-template-columns:1fr 1fr}
  .stat-num{font-size:28px}
}
</style>
</head>
<body>
<header>
  <div class="logo">Trust<span>VA</span> · Ticket Desk</div>
  <div class="header-right">
    <div class="live-dot"></div>
    <div class="domain-badge" id="domain-label">loading...</div>
    <button class="btn btn-ghost" onclick="loadDashboard()" id="refresh-btn">↻ Refresh</button>
  </div>
</header>

<main>
  <!-- STATS -->
  <div class="stats-row">
    <div class="stat-card blue">
      <div class="stat-num" id="stat-open">—</div>
      <div class="stat-label">Open Tickets</div>
    </div>
    <div class="stat-card red">
      <div class="stat-num" id="stat-unassigned">—</div>
      <div class="stat-label">Unassigned</div>
    </div>
    <div class="stat-card green">
      <div class="stat-num" id="stat-assigned">—</div>
      <div class="stat-label">Assigned</div>
    </div>
    <div class="stat-card yellow">
      <div class="stat-num" id="stat-agents">0</div>
      <div class="stat-label">Active Agents</div>
    </div>
  </div>

  <!-- QUICK ASSIGN ALL -->
  <div class="section">
    <div class="section-head">
      <div class="section-title">⚡ Assign All Unassigned Now</div>
      <button class="btn btn-green" id="assign-all-btn" onclick="assignAll()">
        Assign All Equally
      </button>
    </div>
    <div class="section-body">
      <div id="assign-result" class="empty">Click "Assign All Equally" to distribute all unassigned open tickets across all 14 agents.</div>
    </div>
  </div>

  <!-- ASSIGN TO SPECIFIC AGENTS -->
  <div class="section">
    <div class="section-head">
      <div class="section-title">🎯 Assign to Specific Agents</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" onclick="selectAll()">Select All</button>
        <button class="btn btn-ghost" onclick="selectNone()">Clear</button>
        <button class="btn btn-primary" id="assign-selected-btn" onclick="assignSelected()">Assign to Selected</button>
      </div>
    </div>
    <div class="section-body">
      <div class="agent-select-grid" id="agent-select-grid"></div>
      <div id="selected-count" style="font-size:12px;color:var(--muted);margin-top:4px">0 agents selected</div>
    </div>
  </div>

  <!-- AGENT WORKLOAD -->
  <div class="section">
    <div class="section-head">
      <div class="section-title">👥 Agent Workload</div>
      <button class="btn btn-ghost" onclick="loadAgents()">↻ Refresh</button>
    </div>
    <div class="section-body">
      <div class="agent-grid" id="agent-grid">
        <div class="empty">Loading agents...</div>
      </div>
    </div>
  </div>
</main>

<div class="toast" id="toast"></div>

<script>
const AGENTS = ${JSON.stringify(AGENT_IDS.map((id, i) => ({ id, name: AGENT_NAMES[i] || "Agent "+(i+1) })))};
const COLORS = ["#6c63ff","#ff6584","#00e5a0","#ffd166","#38bdf8","#fb923c","#a78bfa","#34d399","#f472b6","#60a5fa","#facc15","#4ade80","#f87171","#818cf8"];

let selectedAgents = new Set(AGENTS.map(a => a.id));

function initAgentSelect() {
  const grid = document.getElementById("agent-select-grid");
  grid.innerHTML = AGENTS.map(a => \`
    <label class="agent-toggle selected" id="toggle-\${a.id}">
      <input type="checkbox" checked onchange="toggleAgent(\${a.id}, this.checked)">
      <div class="check">✓</div>
      <span class="toggle-name">\${a.name}</span>
    </label>
  \`).join("");
  updateSelectedCount();
}

function toggleAgent(id, checked) {
  if (checked) selectedAgents.add(id);
  else selectedAgents.delete(id);
  const el = document.getElementById("toggle-"+id);
  if (el) el.className = "agent-toggle" + (checked ? " selected" : "");
  updateSelectedCount();
}

function selectAll() {
  AGENTS.forEach(a => { selectedAgents.add(a.id); document.getElementById("toggle-"+a.id).className="agent-toggle selected"; document.querySelector("#toggle-"+a.id+" input").checked=true; });
  updateSelectedCount();
}

function selectNone() {
  AGENTS.forEach(a => { selectedAgents.delete(a.id); document.getElementById("toggle-"+a.id).className="agent-toggle"; document.querySelector("#toggle-"+a.id+" input").checked=false; });
  updateSelectedCount();
}

function updateSelectedCount() {
  document.getElementById("selected-count").textContent = selectedAgents.size + " agent" + (selectedAgents.size===1?"":"s") + " selected";
}

async function loadDashboard() {
  document.getElementById("domain-label").textContent = "${DOMAIN}";
  document.getElementById("stat-agents").textContent = AGENTS.length;
  const btn = document.getElementById("refresh-btn");
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();
    document.getElementById("stat-open").textContent = data.open;
    document.getElementById("stat-unassigned").textContent = data.unassigned;
    document.getElementById("stat-assigned").textContent = data.assigned;
    await loadAgents();
  } catch(e) { showToast("Failed to load stats", "error"); }
  btn.disabled = false; btn.innerHTML = "↻ Refresh";
}

async function loadAgents() {
  const grid = document.getElementById("agent-grid");
  grid.innerHTML = '<div class="empty">Loading...</div>';
  try {
    const res = await fetch("/api/agents");
    const data = await res.json();
    const max = Math.max(...data.map(a => a.count), 1);
    grid.innerHTML = data.map((a, i) => \`
      <div class="agent-card">
        <div class="avatar" style="background:\${COLORS[i%COLORS.length]}22;color:\${COLORS[i%COLORS.length]}">\${a.name.split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2)}</div>
        <div class="agent-info">
          <div class="agent-name">\${a.name}</div>
          <div class="agent-count">\${a.count} open tickets</div>
          <div class="agent-bar"><div class="agent-bar-fill" style="width:\${Math.round(a.count/max*100)}%;background:\${COLORS[i%COLORS.length]}"></div></div>
        </div>
        <button class="reshuffle-btn" onclick="reshuffleAgent(\${a.id}, '\${a.name}')">Shuffle</button>
      </div>
    \`).join("");
  } catch(e) { grid.innerHTML = '<div class="empty">Failed to load agents</div>'; }
}

async function assignAll() {
  const btn = document.getElementById("assign-all-btn");
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Assigning...';
  try {
    const res = await fetch("/api/assign", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ agentIds: AGENTS.map(a=>a.id) }) });
    const data = await res.json();
    showResult(data);
    await loadDashboard();
  } catch(e) { showToast("Assignment failed", "error"); }
  btn.disabled = false; btn.innerHTML = "Assign All Equally";
}

async function assignSelected() {
  if (selectedAgents.size === 0) { showToast("Select at least one agent!", "error"); return; }
  const btn = document.getElementById("assign-selected-btn");
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Assigning...';
  try {
    const res = await fetch("/api/assign", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ agentIds: [...selectedAgents] }) });
    const data = await res.json();
    showResult(data);
    await loadDashboard();
  } catch(e) { showToast("Assignment failed", "error"); }
  btn.disabled = false; btn.innerHTML = "Assign to Selected";
}

async function reshuffleAgent(agentId, agentName) {
  if (!confirm("Reassign all of " + agentName + "'s tickets to other agents?")) return;
  showToast("Reshuffling " + agentName + "...", "");
  try {
    const res = await fetch("/api/reshuffle", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ agentId }) });
    const data = await res.json();
    showToast("Moved " + data.reassigned + " tickets from " + agentName, "success");
    await loadDashboard();
  } catch(e) { showToast("Reshuffle failed", "error"); }
}

function showResult(data) {
  if (data.assigned === 0) {
    document.getElementById("assign-result").innerHTML = '<div class="empty">✅ No unassigned tickets found — everything is already assigned!</div>';
    showToast("All tickets already assigned!", "success");
    return;
  }
  const rows = (data.tickets || []).slice(0, 50).map(t => \`
    <div class="ticket-row">
      <span class="ticket-id">#\${t.id}</span>
      <span class="ticket-subj">\${t.subject || "No subject"}</span>
      \${t.ok ? '<span class="ticket-agent">→ '+t.agent+'</span>' : '<span class="ticket-fail">failed</span>'}
    </div>
  \`).join("");
  document.getElementById("assign-result").innerHTML = \`
    <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap">
      <span style="color:var(--green);font-weight:600">✅ \${data.assigned} assigned</span>
      \${data.failed > 0 ? '<span style="color:var(--accent2)">❌ '+data.failed+' failed</span>' : ''}
    </div>
    <div class="ticket-list">\${rows}\${data.tickets.length > 50 ? '<div style="padding:10px 0;color:var(--muted);font-size:12px">...and '+(data.tickets.length-50)+' more</div>' : ''}</div>
  \`;
  showToast(data.assigned + " tickets assigned!", "success");
}

function showToast(msg, type) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (type ? " "+type : "");
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.className = "toast", 3000);
}

initAgentSelect();
loadDashboard();
setInterval(loadDashboard, 60000);
</script>
</body>
</html>`;

// ─── HTTP SERVER + API ────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  res.setHeader("Content-Type", "application/json");

  if (path === "/" || path === "/dashboard") {
    res.setHeader("Content-Type", "text/html");
    res.writeHead(200);
    res.end(HTML);
    return;
  }

  if (path === "/api/stats") {
    try {
      const tickets = await getAllOpenTickets();
      const unassigned = tickets.filter(t => !t.responder_id).length;
      res.writeHead(200);
      res.end(JSON.stringify({ open: tickets.length, unassigned, assigned: tickets.length - unassigned }));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (path === "/api/agents") {
    try {
      const tickets = await getAllOpenTickets();
      const counts = {};
      AGENT_IDS.forEach(id => counts[id] = 0);
      tickets.forEach(t => { if (t.responder_id && counts[t.responder_id] !== undefined) counts[t.responder_id]++; });
      const result = AGENT_IDS.map((id, i) => ({ id, name: AGENT_NAMES[i] || "Agent "+(i+1), count: counts[id] }));
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (path === "/api/assign" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { agentIds } = JSON.parse(body);
        const result = await runAssignment(agentIds);
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (path === "/api/reshuffle" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { agentId } = JSON.parse(body);
        const result = await reshuffleAgent(agentId);
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => console.log("🌐 Dashboard live on port " + PORT));

// ─── CRON SCHEDULE ────────────────────────────────────────────────────────────
cron.schedule("0 4 * * 1-6",       () => runAssignment(AGENT_IDS), { timezone: "Asia/Kolkata" });
cron.schedule("*/30 3-14 * * 1-6", async () => {
  const t = await getAllOpenUnassigned();
  if (t.length >= 20) { console.log("🚨 Surge! Auto-assigning..."); await runAssignment(AGENT_IDS); }
}, { timezone: "Asia/Kolkata" });

console.log("🚀 TrustVA Ticket Desk running!");
console.log("🌐 Open your Railway URL in the browser to see the dashboard");
console.log("👥 " + AGENT_IDS.length + " agents loaded: " + AGENT_NAMES.join(", "));
