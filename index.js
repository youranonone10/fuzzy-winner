const cron  = require("node-cron");
const axios = require("axios");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DOMAIN      = process.env.FRESHDESK_DOMAIN;
const API_KEY     = process.env.FRESHDESK_API_KEY;
const AGENT_IDS   = process.env.AGENT_IDS.split(",").map(Number);
const AGENT_NAMES = process.env.AGENT_NAMES.split(",").map(s => s.trim());

const auth = { username: API_KEY, password: "X" };

// ─── GET ALL OPEN + UNASSIGNED TICKETS ────────────────────────────────────────
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
  console.log("📋 Found " + all.length + " open unassigned tickets");
  return all;
}

// ─── ASSIGN ONE TICKET TO ONE AGENT ──────────────────────────────────────────
// Only sets responder_id. Never changes status or anything else.
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
    console.error("❌ Failed ticket #" + ticketId + ": " + detail);
    return false;
  }
}

// ─── MAIN: EQUAL ROUND-ROBIN ASSIGNMENT ───────────────────────────────────────
async function runAssignment(triggeredBy) {
  triggeredBy = triggeredBy || "schedule";
  console.log("\n🌅 ===== AUTO-ASSIGN STARTED (" + triggeredBy + ") =====");
  const startTime = Date.now();

  const tickets = await getAllOpenUnassigned();

  if (tickets.length === 0) {
    console.log("✅ No unassigned tickets found. Nothing to do!");
    return;
  }

  let assigned = 0, failed = 0;
  const perAgent = {};
  AGENT_IDS.forEach((id, i) => {
    perAgent[id] = { name: AGENT_NAMES[i] || ("Agent " + (i + 1)), count: 0 };
  });

  for (let i = 0; i < tickets.length; i++) {
    const ticket  = tickets[i];
    const agentId = AGENT_IDS[i % AGENT_IDS.length]; // equal round-robin
    const ok = await assignTicket(ticket.id, agentId);
    if (ok) {
      perAgent[agentId].count++;
      assigned++;
      console.log("✅ #" + ticket.id + " → " + perAgent[agentId].name);
    } else {
      failed++;
    }
  }

  const duration = Math.round((Date.now() - startTime) / 1000);
  console.log("\n📊 DONE! Assigned: " + assigned + " | Failed: " + failed + " | Time: " + duration + "s");
  console.log("👥 Per agent breakdown:");
  Object.values(perAgent).forEach(a => {
    console.log("   • " + a.name + ": " + a.count + " tickets");
  });
}

// ─── SURGE CHECK: auto-assign if 20+ new tickets pile up ─────────────────────
let lastCount = 0;
async function checkSurge() {
  const tickets = await getAllOpenUnassigned();
  const spike = tickets.length - lastCount;
  if (tickets.length > 0 && spike >= 20) {
    console.log("🚨 Surge! " + spike + " new tickets — auto-assigning now");
    await runAssignment("surge-auto");
  } else {
    console.log("📈 Surge check: " + tickets.length + " unassigned (+" + Math.max(0,spike) + " new)");
  }
  lastCount = tickets.length;
}

// ─── SCHEDULE (IST) ───────────────────────────────────────────────────────────
// 9:30 AM IST = 4:00 AM UTC — runs Mon to Sat
cron.schedule("0 4 * * 1-6",       () => runAssignment("9:30am"), { timezone: "Asia/Kolkata" });
// Surge check every 30 min during work hours
cron.schedule("*/30 3-14 * * 1-6", checkSurge,                    { timezone: "Asia/Kolkata" });

console.log("🚀 Freshdesk Auto-Assign Bot is running!");
console.log("📋 Assigns open+unassigned tickets equally to " + AGENT_IDS.length + " agents");
console.log("⏰ Runs at 9:30 AM IST every weekday + surge check every 30 min");
console.log("❌ Never closes or resolves any ticket");
console.log("👥 Agents: " + AGENT_NAMES.join(", "));
