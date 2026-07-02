require("dotenv").config();
const express = require("express");
const { WebSocketServer } = require("ws");
const { createServer } = require("http");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const fetch = require("node-fetch");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/stream" });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Twilio inbound call webhook ─────────────────────────────────────────────
app.post("/call", async (req, res) => {
  const from = req.body.From || "";
  console.log("INBOUND CALL FROM:", from);

  // Look up guest immediately — we have the number right here
  let guestContext = null;
  const phone = normalisePhone(from);
  if (phone) {
    const { data } = await supabase
      .from("guest_call_context")
      .select("*")
      .eq("phone", phone)
      .limit(1)
      .maybeSingle();
    if (data) {
      guestContext = data;
      console.log("GUEST FOUND:", data.guest_name);
    }
  }

  // Store context so the WebSocket handler can use it
  activeCalls.set(from, { phone, guestContext, history: [], from });

  // Return TwiML to connect the call to our WebSocket stream
  const wsUrl = process.env.APP_URL.replace("https://", "wss://").replace("http://", "ws://");
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}/stream">
      <Parameter name="from" value="${from}"/>
    </Stream>
  </Connect>
</Response>`);
});

// ── Active call sessions ────────────────────────────────────────────────────
const activeCalls = new Map();

// ── WebSocket handler — Twilio Media Streams ────────────────────────────────
wss.on("connection", (ws) => {
  let callData = null;
  let streamSid = null;
  let audioBuffer = [];
  let silenceTimer = null;
  let callSid = null;

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.streamSid;
      callSid = msg.start?.callSid;
      const from = msg.start?.customParameters?.from;
      callData = activeCalls.get(from);
      console.log("STREAM STARTED:", streamSid, "FROM:", from);

      // Send opening greeting via Twilio
      const greeting = buildGreeting(callData?.guestContext);
      await sendSpeech(callSid, greeting);
    }

    if (msg.event === "media") {
      // Accumulate audio — in production you'd use a proper STT service
      // For now we use Twilio's built-in <Gather> via status callbacks
    }

    if (msg.event === "stop") {
      console.log("STREAM STOPPED:", streamSid);
      if (callData) {
        await createTrelloCard(callData);
        activeCalls.delete(callData.from);
      }
    }
  });

  ws.on("close", () => {
    console.log("WS CLOSED");
  });
});

// ── Speech input via Twilio Gather ──────────────────────────────────────────
app.post("/gather", async (req, res) => {
  const from = req.body.From || "";
  const speech = req.body.SpeechResult || "";
  const callSid = req.body.CallSid;

  console.log("SPEECH:", speech, "FROM:", from);

  const callData = activeCalls.get(from);
  if (!callData) {
    return res.type("text/xml").send(twimlGather("I'm sorry, I lost your session. Please call back."));
  }

  if (!speech.trim()) {
    return res.type("text/xml").send(twimlGather("Sorry, I didn't catch that. Could you repeat?"));
  }

  // Add to history
  callData.history.push({ role: "user", content: speech });

  // Ask Claude
  const response = await askClaude(callData, speech);
  callData.history.push({ role: "assistant", content: response });

  // Check if issue needs escalation
  const needsEscalation = detectEscalation(response);
  if (needsEscalation) {
    callData.needsEscalation = true;
    callData.issueDescription = speech;
  }

  res.type("text/xml").send(twimlGather(response));
});

// ── Initial greeting handler ─────────────────────────────────────────────────
app.post("/answer", async (req, res) => {
  const from = req.body.From || "";
  const callSid = req.body.CallSid;

  console.log("INBOUND CALL FROM:", from);

  const phone = normalisePhone(from);
  let guestContext = null;

  if (phone) {
    const { data } = await supabase
      .from("guest_call_context")
      .select("*")
      .eq("phone", phone)
      .limit(1)
      .maybeSingle();
    if (data) {
      guestContext = data;
      console.log("GUEST FOUND:", data.guest_name);
    }
  }

  activeCalls.set(from, { phone, guestContext, history: [], from, callSid, needsEscalation: false });

  const greeting = buildGreeting(guestContext);

  res.type("text/xml").send(twimlGather(greeting));
});

// ── Call ended ───────────────────────────────────────────────────────────────
app.post("/status", async (req, res) => {
  const from = req.body.From || "";
  const status = req.body.CallStatus;

  console.log("CALL STATUS:", status, "FROM:", from);

  if (status === "completed" || status === "busy" || status === "no-answer") {
    const callData = activeCalls.get(from);
    if (callData && callData.history.length > 0) {
      await createTrelloCard(callData);
    }
    activeCalls.delete(from);
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

function buildGreeting(guest) {
  if (guest) {
    return `Hello ${guest.guest_name}! Welcome to Allure Abode guest support. How can I help you today?`;
  }
  return "Hello! Thank you for calling Allure Abode. How can I help you today?";
}

function buildSystemPrompt(callData) {
  const g = callData.guestContext;
  if (!g) {
    return `You are Aria, a friendly guest support assistant for Allure Abode, a short-term rental company in the UK. The caller was not found in the system. Ask for their name and property and help as best you can. Be warm, concise and professional. Speak in British English. Keep responses SHORT — under 3 sentences — as this is a phone call. If you cannot resolve something, say you will pass it to the team.`;
  }
  return `You are Aria, a friendly guest support assistant for Allure Abode, a short-term rental company in the UK. Be warm, concise and professional. Speak in British English. Keep responses SHORT — under 3 sentences — as this is a phone call. If you cannot resolve something, say you will pass it to the team.

The guest is ${g.guest_name}, staying at ${g.property_name}.
Check-in: ${g.check_in} | Check-out: ${g.check_out}
WiFi: ${g.wifi_name} / ${g.wifi_password}
Door Code: ${g.door_code}
Parking: ${g.parking_info}
Check-in Instructions: ${g.check_in_instructions}
House Rules: ${g.house_rules}`;
}

async function askClaude(callData, userMessage) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 200,
      system: buildSystemPrompt(callData),
      messages: callData.history.slice(-10), // last 10 messages for context
    });
    return response.content[0].text;
  } catch (e) {
    console.error("CLAUDE ERROR:", e);
    return "I'm having a technical issue. I'll pass your query to the team and someone will call you back.";
  }
}

function detectEscalation(response) {
  const escalationPhrases = ["pass", "team", "follow up", "contact", "call back", "maintenance", "can't", "cannot", "unable"];
  return escalationPhrases.some(p => response.toLowerCase().includes(p));
}

function twimlGather(speech) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Amy" language="en-GB">${escapeXml(speech)}</Say>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="2" timeout="10">
  </Gather>
  <Say voice="Polly.Amy" language="en-GB">Is there anything else I can help you with?</Say>
  <Gather input="speech" action="/gather" method="POST" speechTimeout="2" timeout="10">
  </Gather>
  <Say voice="Polly.Amy" language="en-GB">Thank you for calling Allure Abode. Goodbye!</Say>
  <Hangup/>
</Response>`;
}

function escapeXml(str) {
  return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function sendSpeech(callSid, text) {
  // Update live call via Twilio REST API
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const twiml = `<Response><Say voice="Polly.Amy" language="en-GB">${escapeXml(text)}</Say><Gather input="speech" action="${process.env.APP_URL}/gather" method="POST" speechTimeout="2" timeout="10"></Gather><Hangup/></Response>`;
    await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ Twiml: twiml }),
    });
  } catch (e) {
    console.error("SEND SPEECH ERROR:", e);
  }
}

async function createTrelloCard(callData) {
  if (!process.env.TRELLO_API_KEY || !process.env.TRELLO_TOKEN || !process.env.TRELLO_LIST_ID) return;

  const guest = callData.guestContext;
  const name = guest ? guest.guest_name : "Unknown Guest";
  const property = guest ? guest.property_name : "Unknown Property";

  const summary = callData.history
    .map(m => `${m.role === "user" ? "Guest" : "Aria"}: ${m.content}`)
    .join("\n");

  const title = `📞 Guest Call — ${name} — ${property}`;
  const desc = `**Guest:** ${name}
**Phone:** ${callData.phone}
**Property:** ${property}
**Check-in:** ${guest?.check_in || "N/A"} | **Check-out:** ${guest?.check_out || "N/A"}

**Call Summary:**
${summary}`;

  try {
    await fetch(`https://api.trello.com/1/cards?key=${process.env.TRELLO_API_KEY}&token=${process.env.TRELLO_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idList: process.env.TRELLO_LIST_ID,
        name: title,
        desc: desc,
      }),
    });
    console.log("TRELLO CARD CREATED FOR:", name);
  } catch (e) {
    console.error("TRELLO ERROR:", e);
  }
}

// ── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Aria voice server running on port ${PORT}`));
