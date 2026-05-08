const cron   = require("node-cron");
const axios  = require("axios");
const twilio = require("twilio");

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const DOMAIN    = process.env.FRESHDESK_DOMAIN;
const API_KEY   = process.env.FRESHDESK_API_KEY;
const AGENT_IDS = process.env.AGENT_IDS.split(",").map(Number);
const AGENT_NAMES = process.env.AGENT_NAMES.split(",").map(s => s.trim());

const TWILIO_SID   = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_FROM  = process.env.TWILIO_WHATSAPP_FROM;
const YOUR_NUMBER  = process.env.YOUR_WHATSAPP_NUMBER;

const MANAGER_NUMBERS = process.env.MANAGER_WHATSAPP_NUMBERS
  ? process.env.MANAGER_WHATSAPP_NUMBERS.split(",").map(s => s.trim())
  : [];

const auth = { username: API_KEY, password: "X" };
const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);

// ─── WHATSAPP ──────────────────────────────────────────────────────────────────
async function sendWhatsApp(to, message) {
  try {
    await twilioClient.messages.create({ from: TWILIO_FROM, to, body: message });
    console.log("📱 WhatsApp sent to " + to);
  } catch (err) {
    console.error("WhatsApp failed:", err.message);
  }
}

async function broadcastWhatsApp(numbers, message) {
  for (const num of numbers) await sendWhatsApp(num, message);
}

// ─── GET ALL OPEN + UNASSIGNED TICKETS ────────────────────────────────────────
// STATUS 2 = Open. Bot ONLY assigns. NEVER closes or resolves anything.
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

// ─── ASSIGN ONE TICKET ────────────────────────────────────────────────────────
// Only sets responder_id. Does NOT touch status or anything else.
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
    console.error("❌ Failed ticket #" + ticketId + " → agent " + agentId + ": " + detail);
    return false;
  }
}

// ─── MAIN: ASSIGN ALL OPEN UNASSIGNED TICKETS EQUALLY ─────────────────────────
async function runAssignment(triggeredBy) {
  triggeredBy = triggeredBy || "schedule";
  console.log("\n🌅 ===== AUTO-ASSIGN STARTED (" + triggeredBy + ") =====");
  const startTime = Date.now();

  const tickets = await getAllOpenUnassigned();

  if (tickets.length === 0) {
    await sendWhatsApp(YOUR_NUMBER,
      "✅ *Auto-assign ran (" + triggeredBy + ")*\n\nNo open unassigned tickets found. All clear!\n\n_" + now() + "_"
    );
    return;
  }

  // Pure equal round-robin — ticket 0→agent 0, ticket 1→agent 1, wraps around
  let assigned = 0, failed = 0;
  const perAgent = {};
  AGENT_IDS.forEach((id, i) => {
    perAgent[id] = { name: AGENT_NAMES[i] || ("Agent " + (i + 1)), count: 0 };
  });

  for (let i = 0; i < tickets.length; i++) {
    const ticket  = tickets[i];
    const agentId = AGENT_IDS[i % AGENT_IDS.length];
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
  const agentLines = Object.values(perAgent)
    .map(a => "  • " + a.name + ": *" + a.count + " tickets*")
    .join("\n");

  const msg =
    "🌅 *Ticket Assignment Complete*\n\n" +
    "📊 *Summary*\n" +
    "✅ Assigned: *" + assigned + "* tickets\n" +
    "❌ Failed: *" + failed + "*\n" +
    "⏱️ Time: " + duration + "s\n\n" +
    "👥 *Per Agent (equal split)*\n" + agentLines + "\n\n" +
    "_" + now() + "_";

  await sendWhatsApp(YOUR_NUMBER, msg);
  if (MANAGER_NUMBERS.length) await broadcastWhatsApp(MANAGER_NUMBERS, msg);
  console.log("✅ Done! " + assigned + " assigned, " + failed + " failed in " + duration + "s");
}

// ─── SURGE: auto-assign if 20+ new tickets pile up ────────────────────────────
let lastCount = 0;
async function checkSurge() {
  const tickets = await getAllOpenUnassigned();
  const spike = tickets.length - lastCount;
  if (tickets.length > 0 && spike >= 20) {
    console.log("🚨 Surge! " + spike + " new tickets — auto-assigning now");
    await runAssignment("surge-auto");
  }
  lastCount = tickets.length;
}

// ─── END OF DAY REPORT ────────────────────────────────────────────────────────
async function endOfDayReport() {
  const res = await axios.get(
    "https://" + DOMAIN + "/api/v2/tickets?filter=new_and_my_open&per_page=100",
    { auth }
  );
  const open       = res.data.filter(t => t.status === 2);
  const unassigned = open.filter(t => !t.responder_id);
  const msg =
    "📊 *End of Day Report*\n\n" +
    "📬 Open tickets: *" + open.length + "*\n" +
    "🔴 Still unassigned: *" + unassigned.length + "*\n\n" +
    (unassigned.length > 0 ? "⚠️ Some tickets still need assignment tomorrow!\n\n" : "✅ All tickets assigned!\n\n") +
    "_" + now() + "_";
  await sendWhatsApp(YOUR_NUMBER, msg);
  if (MANAGER_NUMBERS.length) await broadcastWhatsApp(MANAGER_NUMBERS, msg);
}

function now() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

// ─── SCHEDULE ─────────────────────────────────────────────────────────────────
// 9:30 AM IST daily (Mon-Sat)
cron.schedule("0 4 * * 1-6",       () => runAssignment("9:30am"), { timezone: "Asia/Kolkata" });
// Every 30 min during work hours — surge check
cron.schedule("*/30 3-14 * * 1-6", checkSurge,                    { timezone: "Asia/Kolkata" });
// 6:30 PM end of day report
cron.schedule("30 13 * * 1-6",     endOfDayReport,                { timezone: "Asia/Kolkata" });

console.log("🚀 Bot running!");
console.log("✅ Assigns open+unassigned tickets equally to all " + AGENT_IDS.length + " agents");
console.log("❌ NEVER closes or resolves any ticket");
console.log("👥 Agents: " + AGENT_NAMES.join(", "));
