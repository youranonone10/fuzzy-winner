// ─── RUN THIS ONCE TO GET YOUR CORRECT AGENT IDs ──────────────────────────────
// node get-agent-ids.js
// Then copy the output into your Railway environment variables

const axios = require("axios");

const DOMAIN  = process.env.FRESHDESK_DOMAIN;   // e.g. primeamsterdam.freshdesk.com
const API_KEY = process.env.FRESHDESK_API_KEY;

async function getAgents() {
  try {
    console.log(`\nFetching agents from https://${DOMAIN}...\n`);

    const res = await axios.get(
      `https://${DOMAIN}/api/v2/agents?per_page=100`,
      {
        auth: { username: API_KEY, password: "X" },
        headers: { "Content-Type": "application/json" }
      }
    );

    const agents = res.data;

    console.log("=".repeat(55));
    console.log(" AGENT NAME                    | ID");
    console.log("=".repeat(55));

    agents.forEach(a => {
      const name = (a.contact.name || "Unknown").padEnd(30);
      console.log(` ${name} | ${a.id}`);
    });

    console.log("=".repeat(55));
    console.log(`\nTotal agents found: ${agents.length}\n`);

    // Print ready-to-use env variable
    const ids   = agents.map(a => a.id).join(",");
    const names = agents.map(a => a.contact.name).join(",");

    console.log("─".repeat(55));
    console.log("Copy these into your Railway environment variables:\n");
    console.log(`AGENT_IDS=${ids}`);
    console.log(`\nAGENT_NAMES=${names}`);
    console.log("─".repeat(55));

  } catch (err) {
    if (err.response) {
      console.error(`\n❌ Freshdesk API error ${err.response.status}:`, err.response.data);
      if (err.response.status === 401) {
        console.error("👉 Your API key is wrong. Go to Freshdesk → Profile Settings → copy API key.");
      }
      if (err.response.status === 404) {
        console.error("👉 Your domain is wrong. It should be: yourcompany.freshdesk.com");
      }
    } else {
      console.error("\n❌ Network error:", err.message);
    }
  }
}

getAgents();
