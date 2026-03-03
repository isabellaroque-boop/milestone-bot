// index.js — Weekly Milestone Slack Bot
// Runs every Thursday at 9am (configured via cron in railway.toml)

const ICS_URL = "https://doc.finlert.com/calendars/f18dddff-c687-4446-9c9b-312648a33a02/1d568a30-6046-4e39-a516-7b10f9a607dc/28913c12-a056-4ab8-ae58-86c2816802b9.ics";

// --- ICS Parser ---
function parseICS(text) {
  const events = [];
  const blocks = text.split("BEGIN:VEVENT").slice(1);
  for (const b of blocks) {
    const get = (key) => {
      const m = b.match(new RegExp(`${key}[^:]*:([^\\r\\n]+)`));
      return m ? m[1].trim() : "";
    };
    const summary = get("SUMMARY");
    const dtstart = get("DTSTART");
    const cats = get("CATEGORIES").toLowerCase();
    if (!summary || !dtstart) continue;

    const sl = summary.toLowerCase();
    const isBirthday = sl.includes("birthday") || cats.includes("birthday");
    const isAnniversary = (sl.includes("anniversary") || cats.includes("anniversary"))
      && !sl.startsWith("6 month");

    if (!isBirthday && !isAnniversary) continue;

    const ds = dtstart.replace(/\D/g, "").slice(0, 8);
    const month = parseInt(ds.slice(4, 6)) - 1;
    const day = parseInt(ds.slice(6, 8));
    const type = isBirthday ? "Birthday" : "Anniversary";
    events.push({ summary, type, month, day });
  }
  return events;
}

function getThisWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const mon = new Date(now); mon.setDate(now.getDate() - ((day + 6) % 7)); mon.setHours(0,0,0,0);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6); sun.setHours(23,59,59,999);
  return { mon, sun };
}

// --- Main ---
async function run() {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const slackChannel = process.env.SLACK_CHANNEL; // e.g. "C12345678" or "#general"
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!slackToken || !slackChannel || !anthropicKey) {
    console.error("Missing env vars: SLACK_BOT_TOKEN, SLACK_CHANNEL, ANTHROPIC_API_KEY");
    process.exit(1);
  }

  // 1. Fetch & parse calendar
  console.log("Fetching calendar...");
  const icsRes = await fetch(ICS_URL);
  const icsText = await icsRes.text();
  const allEvents = parseICS(icsText);

  // 2. Filter to this week (match by month+day, ignoring year — recurring events)
  const { mon, sun } = getThisWeekRange();
  const year = mon.getFullYear();
  const weekEvents = allEvents.filter(({ month, day }) => {
    const d = new Date(year, month, day);
    return d >= mon && d <= sun;
  });

  console.log(`Found ${weekEvents.length} milestone(s) this week.`);
  if (weekEvents.length === 0) {
    console.log("Nothing to post — exiting.");
    return;
  }

  // 3. Generate message with Claude
  const list = weekEvents.map(e => `- ${e.summary} (${e.type})`).join("\n");
  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `Write a short, warm Slack message celebrating these team milestones this week. Keep it concise — 2-4 lines max. Use minimal emoji. No preamble, just the message:\n\n${list}`
      }]
    })
  });
  const claudeData = await claudeRes.json();
  const message = claudeData.content?.find(b => b.type === "text")?.text;
  if (!message) { console.error("No message from Claude"); process.exit(1); }
  console.log("Message:", message);

  // 4. Post to Slack
  const slackRes = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${slackToken}`
    },
    body: JSON.stringify({ channel: slackChannel, text: message })
  });
  const slackData = await slackRes.json();
  if (slackData.ok) {
    console.log("✅ Posted to Slack successfully!");
  } else {
    console.error("❌ Slack error:", slackData.error);
    process.exit(1);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
