const cron = require("node-cron");
const axios = require("axios");

const DOMAIN = process.env.FRESHDESK_DOMAIN;
const API_KEY = process.env.FRESHDESK_API_KEY;

// Your agent IDs from Freshdesk Admin → Agents
const AGENT_IDS = process.env.AGENT_IDS.split(",").map(Number);

const auth = {
  username: API_KEY,
  password: "X"
};

async function getUnassignedTickets() {
  const res = await axios.get(
    `https://${DOMAIN}/api/v2/tickets?filter=new_and_my_open&per_page=100`,
    { auth }
  );
  return res.data.filter(t => !t.responder_id);
}

async function assignTicket(ticketId, agentId) {
  await axios.put(
    `https://${DOMAIN}/api/v2/tickets/${ticketId}`,
    { responder_id: agentId },
    { auth, headers: { "Content-Type": "application/json" } }
  );
}

async function runAssignment() {
  console.log("⏰ Running auto-assignment at", new Date().toLocaleString());

  const tickets = await getUnassignedTickets();
  console.log(`Found ${tickets.length} unassigned tickets`);

  if (tickets.length === 0) {
    console.log("Nothing to assign. Done!");
    return;
  }

  for (let i = 0; i < tickets.length; i++) {
    const agentId = AGENT_IDS[i % AGENT_IDS.length];
    await assignTicket(tickets[i].id, agentId);
    console.log(`Ticket #${tickets[i].id} → Agent ${agentId}`);
  }

  console.log(`✅ Done! ${tickets.length} tickets assigned across ${AGENT_IDS.length} agents.`);
}

// Runs every day at 9:30 AM India time (IST = UTC+5:30)
// Cron format: minute hour * * *
cron.schedule("30 4 * * *", () => {
  runAssignment().catch(console.error);
}, {
  timezone: "Asia/Kolkata"
});

console.log("🚀 Auto-assign bot is running. Waiting for 9:30 AM IST...");
