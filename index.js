const cron = require("node-cron");
const axios = require("axios");
const twilio = require("twilio");

// ─── CONFIG FROM ENV ───────────────────────────────────────────────────────────
const DOMAIN       = process.env.FRESHDESK_DOMAIN;
const API_KEY      = process.env.FRESHDESK_API_KEY;
const AGENT_IDS    = process.env.AGENT_IDS.split(",").map(Number);
const AGENT_NAMES  = process.env.AGENT_NAMES.split(",").map(s => s.trim());

const TWILIO_SID   = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_WHATSAPP_FROM; // e.g. whatsapp:+14155238886
const YOUR_NUMBER  = process.env.YOUR_WHATSAPP_NUMBER; // e.g. whatsapp:+919999999999

const MANAGER_NUMBERS = process.env.MANAGER_WHATSAPP_NUMBERS
  ? process.env.MANAGER_WHATSAPP_NUMBERS.split(",").map(s => s.trim())
  : [];

const SLA_WARN_HOURS  = parseInt(process.env.SLA_WARN_HOURS  || "4");
const SLA_BREACH_HOURS= parseInt(process.env.SLA_BREACH_HOURS|| "8");
const MAX_PER_AGENT   = parseInt(process.env.MAX_PER_AGENT    || "30");

const auth = { username: API_KEY, password: "X" };
const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);

// ─── WHATSAPP HELPER ───────────────────────────────────────────────────────────
async function sendWhatsApp(to, message) {
  try {
    await twilioClient.messages.create({
      from: TWILIO_FROM,
      to,
      body: message
    });
    console.log(`📱 WhatsApp sent to ${to}`);
  } catch (err) {
    console.error("WhatsApp send failed:", err.message);
  }
}

async function broadcastWhatsApp(numbers, message) {
  for (const num of numbers) {
    await sendWhatsApp(num, message);
  }
}

// ─── FRESHDESK API HELPERS ─────────────────────────────────────────────────────
async function getTickets(filter = "new_and_my_open", page = 1) {
  const res = await axios.get(
    `https://${DOMAIN}/api/v2/tickets?filter=${filter}&per_page=100&page=${page}`,
    { auth }
  );
  return res.data;
}

async function getAllUnassigned() {
  let page = 1, all = [];
  while (true) {
    const batch = await getTickets("new_and_my_open", page);
    const unassigned = batch.filter(t => !t.responder_id);
    all = all.concat(unassigned);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

async function assignTicket(ticketId, agentId, note = null) {
  try {
    await axios.put(
      `https://${DOMAIN}/api/v2/tickets/${ticketId}`,
      { responder_id: agentId },
      { auth, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`❌ Failed to assign ticket #${ticketId} to agent ${agentId}: ${detail}`);
    throw err; // re-throw so caller can skip this ticket
  }
  if (note) {
    try {
      await axios.post(
        `https://${DOMAIN}/api/v2/tickets/${ticketId}/notes`,
        { body: note, private: true },
        { auth, headers: { "Content-Type": "application/json" } }
      );
    } catch (err) {
      console.warn(`⚠️ Note failed for ticket #${ticketId} (ticket was assigned OK):`, err.message);
    }
  }
}

async function getAgentTicketCounts() {
  const counts = {};
  AGENT_IDS.forEach(id => counts[id] = 0);
  const open = await getTickets("open");
  open.forEach(t => {
    if (t.responder_id && counts[t.responder_id] !== undefined) {
      counts[t.responder_id]++;
    }
  });
  return counts;
}

async function getOverdueTickets() {
  const tickets = await getTickets("open");
  const now = new Date();
  return tickets.filter(t => {
    const created = new Date(t.created_at);
    const ageHours = (now - created) / 3600000;
    return ageHours >= SLA_WARN_HOURS && !t.responder_id;
  });
}

// ─── SMART CATEGORY ROUTING ────────────────────────────────────────────────────
function detectCategory(ticket) {
  const text = `${ticket.subject || ""} ${ticket.description_text || ""}`.toLowerCase();
  if (/billing|invoice|payment|charge|refund/.test(text))   return "billing";
  if (/error|bug|crash|not working|issue|broken/.test(text)) return "technical";
  if (/cancel|subscription|plan|upgrade/.test(text))        return "account";
  if (/delivery|order|shipping|track/.test(text))           return "delivery";
  return "general";
}

// Priority: urgent tickets first
function sortByPriority(tickets) {
  const order = { 4: 0, 3: 1, 2: 2, 1: 3 }; // 4=urgent,3=high,2=medium,1=low
  return [...tickets].sort((a, b) => (order[b.priority] || 3) - (order[a.priority] || 3));
}

// ─── FEATURE 1: MORNING AUTO-ASSIGN ───────────────────────────────────────────
async function runMorningAssignment() {
  console.log("\n🌅 ===== MORNING AUTO-ASSIGN STARTED =====");
  const startTime = Date.now();

  const tickets = sortByPriority(await getAllUnassigned());
  console.log(`Found ${tickets.length} unassigned tickets`);

  if (tickets.length === 0) {
    const msg = `✅ *Good morning team!*\n\nNo unassigned tickets right now. All clear! 🎉\n\n_${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}_`;
    await sendWhatsApp(YOUR_NUMBER, msg);
    return;
  }

  // Load balance: assign to agents with least tickets
  const currentCounts = await getAgentTicketCounts();
  let assigned = 0, skipped = 0;
  const perAgentSummary = {};
  AGENT_IDS.forEach((id, i) => perAgentSummary[id] = { name: AGENT_NAMES[i] || `Agent ${i+1}`, count: 0, categories: {} });

  for (const ticket of tickets) {
    // Find agent with least current load
    const eligibleAgents = AGENT_IDS.filter(id => (currentCounts[id] || 0) < MAX_PER_AGENT);
    if (eligibleAgents.length === 0) {
      console.warn(`⚠️ All agents at max capacity (${MAX_PER_AGENT}). Skipping ticket #${ticket.id}`);
      skipped++;
      continue;
    }

    const agentId = eligibleAgents.reduce((a, b) =>
      (currentCounts[a] || 0) <= (currentCounts[b] || 0) ? a : b
    );

    const category = detectCategory(ticket);
    const agentName = AGENT_NAMES[AGENT_IDS.indexOf(agentId)] || `Agent`;
    const note = `🤖 Auto-assigned by bot at ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} | Category: ${category}`;

    try {
      await assignTicket(ticket.id, agentId, note);
      currentCounts[agentId] = (currentCounts[agentId] || 0) + 1;
      perAgentSummary[agentId].count++;
      perAgentSummary[agentId].categories[category] = (perAgentSummary[agentId].categories[category] || 0) + 1;
      assigned++;
      console.log(`✅ Ticket #${ticket.id} [${category}] → ${agentName}`);
    } catch (err) {
      skipped++;
      console.error(`⏭️ Skipped ticket #${ticket.id} due to error`);
    }
  }

  const duration = Math.round((Date.now() - startTime) / 1000);

  // Build WhatsApp summary
  const agentLines = Object.values(perAgentSummary)
    .filter(a => a.count > 0)
    .map(a => {
      const cats = Object.entries(a.categories).map(([k, v]) => `${k}:${v}`).join(", ");
      return `  • ${a.name}: *${a.count} tickets* (${cats})`;
    }).join("\n");

  const summary = `🌅 *Good morning! Auto-assignment complete*\n\n` +
    `📊 *Summary*\n` +
    `✅ Assigned: *${assigned}* tickets\n` +
    `⏭️ Skipped: *${skipped}* (agents at max)\n` +
    `⏱️ Completed in: ${duration}s\n\n` +
    `👥 *Per Agent*\n${agentLines}\n\n` +
    `🕐 _${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}_`;

  await sendWhatsApp(YOUR_NUMBER, summary);
  if (MANAGER_NUMBERS.length) await broadcastWhatsApp(MANAGER_NUMBERS, summary);

  console.log(`\n✅ Done! ${assigned} assigned, ${skipped} skipped in ${duration}s`);
}

// ─── FEATURE 2: SLA BREACH ALERT ──────────────────────────────────────────────
async function checkSLABreaches() {
  console.log("\n⚠️  Checking SLA breaches...");
  const tickets = await getTickets("open");
  const now = new Date();
  const warnings = [], breaches = [];

  tickets.forEach(t => {
    const ageHours = (now - new Date(t.created_at)) / 3600000;
    if (ageHours >= SLA_BREACH_HOURS) breaches.push({ ...t, ageHours: Math.round(ageHours) });
    else if (ageHours >= SLA_WARN_HOURS) warnings.push({ ...t, ageHours: Math.round(ageHours) });
  });

  if (breaches.length === 0 && warnings.length === 0) return;

  let msg = `⚠️ *SLA Alert*\n\n`;
  if (breaches.length > 0) {
    msg += `🔴 *BREACHED (${breaches.length} tickets)*\n`;
    breaches.slice(0, 5).forEach(t => {
      const agent = AGENT_NAMES[AGENT_IDS.indexOf(t.responder_id)] || "Unassigned";
      msg += `  • #${t.id}: ${(t.subject || "No subject").slice(0, 40)} — ${t.ageHours}h (${agent})\n`;
    });
    if (breaches.length > 5) msg += `  ...and ${breaches.length - 5} more\n`;
    msg += "\n";
  }
  if (warnings.length > 0) {
    msg += `🟡 *WARNING (${warnings.length} tickets approaching SLA)*\n`;
    warnings.slice(0, 5).forEach(t => {
      const agent = AGENT_NAMES[AGENT_IDS.indexOf(t.responder_id)] || "Unassigned";
      msg += `  • #${t.id}: ${(t.subject || "No subject").slice(0, 40)} — ${t.ageHours}h (${agent})\n`;
    });
  }
  msg += `\n_${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}_`;

  await sendWhatsApp(YOUR_NUMBER, msg);
  if (breaches.length > 0 && MANAGER_NUMBERS.length) {
    await broadcastWhatsApp(MANAGER_NUMBERS, msg);
  }
}

// ─── FEATURE 3: END-OF-DAY REPORT ─────────────────────────────────────────────
async function endOfDayReport() {
  console.log("\n📊 Running end-of-day report...");
  const open   = await getTickets("open");
  const resolved = await getTickets("resolved");

  const counts = await getAgentTicketCounts();
  const agentLines = AGENT_IDS.map((id, i) => {
    const name = AGENT_NAMES[i] || `Agent ${i+1}`;
    return `  • ${name}: *${counts[id] || 0}* open`;
  }).join("\n");

  const msg = `📊 *End of Day Report*\n\n` +
    `📬 Open tickets: *${open.length}*\n` +
    `✅ Resolved today: *${resolved.length}*\n` +
    `🔴 Unassigned: *${open.filter(t => !t.responder_id).length}*\n\n` +
    `👥 *Agent Workload*\n${agentLines}\n\n` +
    `_${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}_`;

  await sendWhatsApp(YOUR_NUMBER, msg);
  if (MANAGER_NUMBERS.length) await broadcastWhatsApp(MANAGER_NUMBERS, msg);
}

// ─── FEATURE 4: SURGE DETECTION ───────────────────────────────────────────────
let lastTicketCount = 0;
async function checkForSurge() {
  const unassigned = await getAllUnassigned();
  const current = unassigned.length;
  const spike = current - lastTicketCount;

  if (spike >= 20) {
    console.log(`🚨 Surge detected! ${spike} new unassigned tickets`);
    const msg = `🚨 *Ticket Surge Alert!*\n\n` +
      `${spike} new unassigned tickets in the last 30 minutes!\n` +
      `Total unassigned: *${current}*\n\n` +
      `Consider running manual assignment now.\n` +
      `_${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}_`;
    await sendWhatsApp(YOUR_NUMBER, msg);
  }
  lastTicketCount = current;
}

// ─── SCHEDULE ALL JOBS ─────────────────────────────────────────────────────────
// 9:30 AM IST = 4:00 AM UTC
cron.schedule("0 4 * * 1-6", runMorningAssignment,  { timezone: "Asia/Kolkata" });

// SLA check every 2 hours during work hours (9AM-7PM IST)
cron.schedule("0 3,5,7,9,11,13 * * 1-6", checkSLABreaches, { timezone: "Asia/Kolkata" });

// End of day report at 6:30 PM IST
cron.schedule("30 13 * * 1-6", endOfDayReport,       { timezone: "Asia/Kolkata" });

// Surge check every 30 minutes
cron.schedule("*/30 * * * *", checkForSurge);

console.log("🚀 Freshdesk Auto-Assign Bot started!");
console.log("📅 Schedule (IST):");
console.log("   • 9:30 AM  → Morning auto-assignment");
console.log("   • Every 2h → SLA breach check");
console.log("   • 6:30 PM  → End of day report");
console.log("   • Every 30m→ Surge detection");
