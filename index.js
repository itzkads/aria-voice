require("dotenv").config();
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const ESCALATE_TAG = "[ESCALATE]";

// ── Active call sessions, keyed by CallSid ──────────────────────────────────
const activeCalls = new Map();

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Aria voice server is running"));

// ── Initial call handler — Twilio "A call comes in" webhook ────────────────
app.post("/answer", async (req, res) => {
  const from = req.body.From || "";
  const callSid = req.body.CallSid;

  console.log("INBOUND CALL:", callSid, "FROM:", from);

  const phone = normalisePhone(from);
  const guestContext = await lookupGuest(phone);

  activeCalls.set(callSid, {
    phone,
    from,
    guestContext,
    history: [],
    needsEscalation: false,
  });

  const greeting = buildGreeting(guestContext);
  res.type("text/xml").send(twimlGather(greeting));
});

// ── Speech input handler — Twilio <Gather> action ───────────────────────────
app.post("/gather", async (req, res) => {
  const callSid = req.body.CallSid;
  const speech = (req.body.SpeechResult || "").trim();

  console.log("SPEECH:", speech, "CALLSID:", callSid);

  const callData = activeCalls.get(callSid);
  if (!callData) {
    return res.type("text/xml").send(
      twimlEnd("I'm sorry, I lost track of your call. Please call back and we'll help you right away.")
    );
  }

  if (!speech) {
    return res.type("text/xml").send(twimlGather("Sorry, I didn't catch that. Could you say that again?"));
  }

  callData.history.push({ role: "user", content: speech });

  let reply = await askClaude(callData);
  const escalate = reply.includes(ESCALATE_TAG);
  if (escalate) {
    reply = reply.split(ESCALATE_TAG).join("").trim();
    callData.needsEscalation = true;
  }

  callData.history.push({ role: "assistant", content: reply });

  res.type("text/xml").send(twimlGather(reply));
});

// ── Call status callback — Twilio "Call status changes" webhook ────────────
app.post("/status", async (req, res) => {
  const callSid = req.body.CallSid;
  const status = req.body.CallStatus;

  console.log("CALL STATUS:", status, "CALLSID:", callSid);

  const terminalStatuses = ["completed", "busy", "no-answer", "failed", "canceled"];
  if (terminalStatuses.includes(status)) {
    const callData = activeCalls.get(callSid);
    if (callData && callData.history.length > 0) {
      await createTrelloCard(callData);
    }
    activeCalls.delete(callSid);
  }

  res.sendStatus(200);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalisePhone(raw) {
  if (!raw) return "";
  let n = raw.replace(/[^\d+]/g, "");
  if (n.startsWith("07") && n.length === 11) n = "+44" + n.slice(1);
  if (n.startsWith("447") && !n.startsWith("+")) n = "+" + n;
  return n;
}

async function lookupGuest(phone) {
  if (!phone) return null;
  try {
    const { data, error } = await supabase
      .from("guest_call_context")
      .select("*")
      .eq("phone", phone)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("SUPABASE LOOKUP ERROR:", error);
      return null;
    }
    if (data) console.log("GUEST FOUND:", data.guest_name);
    return data || null;
  } catch (e) {
    console.error("SUPABASE LOOKUP EXCEPTION:", e);
    return null;
  }
}

function buildGreeting(guest) {
  if (guest) {
    return `Hello ${guest.guest_name}! Welcome to Allure Abode guest support. How can I help you today?`;
  }
  return "Hello! Thank you for calling Allure Abode. How can I help you today?";
}

function buildSystemPrompt(callData) {
  const g = callData.guestContext;
  const base = `You are Aria, a friendly guest support assistant for Allure Abode, a short-term rental company in the UK. Be warm, concise and professional. Speak in British English. Keep responses SHORT — under 3 sentences — as this is a phone call.

This reply will be read aloud by a text-to-speech voice, not displayed as text. Never use markdown, asterisks, bullet points, numbered lists, or any other written formatting. Write plain spoken sentences only, exactly as you'd say them out loud.

If the guest raises something you cannot resolve yourself — a maintenance issue, a complaint, a refund request, or anything else needing a human to act — say a brief, reassuring line letting them know the team will follow up, then end your reply with the exact token ${ESCALATE_TAG} on its own line. Only use ${ESCALATE_TAG} when human follow-up is genuinely required, never for questions you've already answered.`;

  if (!g) {
    return `${base}\n\nThe caller could not be matched to a reservation. Ask for their name and property so the team can follow up if needed.`;
  }

  return `${base}

The guest is ${g.guest_name}, staying at ${g.property_name}.
Check-in: ${g.check_in} | Check-out: ${g.check_out}
WiFi: ${g.wifi_name} / ${g.wifi_password}
Door Code: ${g.door_code}
Parking: ${g.parking_info}
Check-in Instructions: ${g.check_in_instructions}
House Rules: ${g.house_rules}`;
}

async function askClaude(callData) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: buildSystemPrompt(callData),
      messages: callData.history.slice(-10),
    });
    return response.content[0].text;
  } catch (e) {
    console.error("CLAUDE ERROR:", e);
    return `I'm having a technical issue. I'll pass your query to the team and someone will call you back. ${ESCALATE_TAG}`;
  }
}

function twimlGather(speech) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural" language="en-GB">${escapeXml(speech)}</Say>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="2" timeout="10">
  </Gather>
  <Say voice="Polly.Amy-Neural" language="en-GB">Is there anything else I can help you with?</Say>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="2" timeout="10">
  </Gather>
  <Say voice="Polly.Amy-Neural" language="en-GB">Thank you for calling Allure Abode. Goodbye!</Say>
  <Hangup/>
</Response>`;
}

function twimlEnd(speech) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy-Neural" language="en-GB">${escapeXml(speech)}</Say>
  <Hangup/>
</Response>`;
}

function escapeXml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function createTrelloCard(callData) {
  if (!process.env.TRELLO_API_KEY || !process.env.TRELLO_TOKEN || !process.env.TRELLO_LIST_ID) {
    console.warn("TRELLO NOT CONFIGURED — skipping card creation");
    return;
  }

  const guest = callData.guestContext;
  const name = guest ? guest.guest_name : "Unknown Guest";
  const property = guest ? guest.property_name : "Unknown Property";
  const prefix = callData.needsEscalation ? "🚨 Escalation" : "📞 Guest Call";

  const summary = callData.history
    .map((m) => `${m.role === "user" ? "Guest" : "Aria"}: ${m.content}`)
    .join("\n");

  const title = `${prefix} — ${name} — ${property}`;
  const desc = `**Guest:** ${name}
**Phone:** ${callData.phone}
**Property:** ${property}
**Check-in:** ${guest?.check_in || "N/A"} | **Check-out:** ${guest?.check_out || "N/A"}
**Needs follow-up:** ${callData.needsEscalation ? "Yes" : "No"}

**Call Transcript:**
${summary}`;

  try {
    const resp = await fetch(
      `https://api.trello.com/1/cards?key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idList: process.env.TRELLO_LIST_ID,
          name: title,
          desc,
        }),
      }
    );
    if (!resp.ok) {
      console.error("TRELLO ERROR:", resp.status, await resp.text());
      return;
    }
    console.log("TRELLO CARD CREATED FOR:", name);
  } catch (e) {
    console.error("TRELLO ERROR:", e);
  }
}

process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));

// ── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Aria voice server running on port ${PORT}`));
