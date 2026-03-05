const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = 5000;

// ── Load API key ──
let apiKey;
try { apiKey = fs.readFileSync('gemini-api-key.txt', 'utf8').trim(); } catch { apiKey = process.env.GEMINI_API_KEY; }
if (!apiKey) { console.error('ERROR: No Gemini API key found.'); process.exit(1); }

const genAI = new GoogleGenerativeAI(apiKey);
const geminiModel = genAI.getGenerativeModel(
  { model: 'gemini-2.5-flash' },
  { apiVersion: 'v1beta' }
);

// ── Load condition list ──
let conditions;
try { conditions = JSON.parse(fs.readFileSync('conditionlist.json', 'utf8')); }
catch (e) { console.error('ERROR: Cannot load conditionlist.json:', e.message); process.exit(1); }

const conditionsText = conditions.map((c, i) =>
  `  [${i + 1}] "${c.condition}" | category: ${c.category} | tag: ${c.tag} | key_symptoms: ${c.key_symptoms} | red_flags: ${c.red_flags}`
).join('\n');

// ── System prompt ──
const SYSTEM_PROMPT = `You are a medical symptom diagnosis assistant. You MUST only classify patients into conditions from the list below. Do not invent or suggest any condition not in this list.

=== CONDITION DATABASE ===
${conditionsText}

=== DIAGNOSIS RULES (follow exactly) ===

STEP 1 — Ask focused questions (1-2 per turn) to gather symptoms.
STEP 2 — When multiple conditions are still possible, ask a question that DIFFERENTIATES them.
          (Ask about a symptom present in one condition but not the others.)
STEP 3 — Once confident, apply the rule based on the HIGHEST-urgency tag among matched conditions:

  tag = CONTINUE:
    → List all matched conditions ranked High/Medium/Low probability.
    → Advise the patient to monitor at home but see a doctor if symptoms worsen.
    → Set action = "CONTINUE"

  tag = SEEK_HELP_SOON:
    → List all matched conditions ranked by probability.
    → Tell the patient to seek medical attention within 24-48 hours.
    → Set action = "SEEK_HELP_SOON"

  tag = SEEK_HELP_IMMEDIATELY:
    → List suspected conditions.
    → Tell the patient to seek EMERGENCY medical help IMMEDIATELY.
    → Set action = "SEEK_HELP_IMMEDIATELY"  ← session ends

  No condition matches at all:
    → Tell the patient their symptoms don't match the condition database.
    → Tell them to seek immediate medical help regardless.
    → Set action = "UNKNOWN"  ← session ends

=== TRANSPARENCY RULES ===
- Explain WHY each condition matches (which specific symptoms led to it).
- Show step-by-step reasoning.
- Be honest about uncertainty — if still unclear, say so and ask targeted questions.
- Never downplay red-flag symptoms (chest pain, breathing difficulty, heavy bleeding, confusion, etc.).

=== STRICT JSON RESPONSE FORMAT ===
Your ENTIRE response must be one valid JSON object. No text before or after it. No markdown fences.

{
  "message": "Your full response to the patient. Use \\n for line breaks.",
  "action": "ASKING",
  "matched_conditions": [
    {
      "name": "exact condition name from the database",
      "probability": "High",
      "reason": "specific symptoms that match this condition"
    }
  ],
  "reasoning": "Step-by-step diagnostic thinking — what symptoms you considered and why",
  "next_question_purpose": "If ASKING — what symptom you are trying to clarify and which conditions it differentiates"
}

Valid action values:
  "ASKING"                 — still gathering information
  "CONTINUE"               — diagnosis done, tag is CONTINUE
  "SEEK_HELP_SOON"         — diagnosis done, tag is SEEK_HELP_SOON
  "SEEK_HELP_IMMEDIATELY"  — diagnosis done, tag is SEEK_HELP_IMMEDIATELY (SESSION ENDS)
  "UNKNOWN"                — no condition matched (SESSION ENDS)
`;

// ── Session store ──
const sessions = new Map();
function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { history: [], ended: false });
  return sessions.get(id);
}

// ── Middleware ──
app.use(express.json());
app.use(express.static(path.join(__dirname, 'static')));

// ── Routes ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates', 'index-version2.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', conditions_loaded: conditions.length, node: process.version });
});

app.post('/chat', async (req, res) => {
  const { message, sessionId = 'default', language = 'en' } = req.body;
  if (!message) return res.status(400).json({ error: 'Empty message' });

  const session = getSession(sessionId);
  if (session.ended) return res.status(400).json({ error: 'Session has ended. Please start a new session.' });

  const isInit = (message === '__INIT__');

  if (!isInit) session.history.push({ role: 'user', text: message });

  const langInstruction = language === 'th'
    ? 'IMPORTANT: You MUST respond entirely in Thai (ภาษาไทย). All fields in the JSON, including "message" and "reasoning", must be written in Thai.'
    : 'IMPORTANT: You MUST respond entirely in English. All fields in the JSON must be in English.';

  // Build prompt
  let fullPrompt = SYSTEM_PROMPT + '\n\n' + langInstruction + '\n\n';

  if (isInit) {
    fullPrompt += 'The patient just opened the app. Greet them warmly, explain you will help assess their symptoms, and ask what their main symptom or health concern is today. Set action to "ASKING", matched_conditions to [], reasoning to "".';
  } else {
    const history = session.history;
    if (history.length > 1) {
      fullPrompt += '=== Conversation history ===\n';
      for (const msg of history.slice(0, -1)) {
        fullPrompt += `${msg.role === 'user' ? 'Patient' : 'Assistant'}: ${msg.text}\n`;
      }
      fullPrompt += '\n';
    }
    fullPrompt += `Patient's latest message: ${message}\n\nYour JSON response:`;
  }

  // Retry logic for rate limits
  const generateWithRetry = async (prompt, retries = 3) => {
    for (let i = 0; i < retries; i++) {
      try {
        return await geminiModel.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { thinkingConfig: { thinkingBudget: 0 } }
        });
      } catch (err) {
        const m = err.message.match(/retry in (\d+(?:\.\d+)?)s/i);
        const wait = m ? parseFloat(m[1]) * 1000 : 5000;
        if (i < retries - 1 && err.message.includes('429')) {
          console.log(`Rate limited — retrying in ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
        } else throw err;
      }
    }
  };

  try {
    const result = await generateWithRetry(fullPrompt);
    let raw = result.response.text().trim();

    // Robustly extract the JSON object — handles code fences, preamble text, etc.
    let parsed;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        parsed = null;
      }
    }
    if (!parsed) {
      // Last resort fallback — show raw text as message
      parsed = { message: raw, action: 'ASKING', matched_conditions: [], reasoning: '', next_question_purpose: '' };
    }

    const assistantMessage = parsed.message || raw;
    const action = parsed.action || 'ASKING';
    const matchedConditions = parsed.matched_conditions || [];
    const reasoning = parsed.reasoning || '';
    const nextQuestionPurpose = parsed.next_question_purpose || '';

    // Store assistant message (including greeting so first user reply has full context)
    session.history.push({ role: 'assistant', text: assistantMessage });

    if (action === 'SEEK_HELP_IMMEDIATELY' || action === 'UNKNOWN') {
      session.ended = true;
    }

    res.json({
      response: assistantMessage,
      action,
      matched_conditions: matchedConditions,
      reasoning,
      next_question_purpose: nextQuestionPurpose,
      session_ended: session.ended,
      turn: session.history.filter(m => m.role === 'user').length
    });

  } catch (err) {
    console.error('Gemini error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/reset', (req, res) => {
  const { sessionId = 'default' } = req.body || {};
  sessions.delete(sessionId);
  res.json({ status: 'reset' });
});

// ── Start server & open browser ──
app.listen(PORT, () => {
  console.log('\n' + '='.repeat(54));
  console.log('  Medical Symptom Diagnosis Chatbot  [v2]');
  console.log('='.repeat(54));
  console.log(`  Conditions loaded : ${conditions.length}`);
  console.log(`  Running at        : http://localhost:${PORT}`);
  console.log('  Opening browser...');
  console.log('  Press Ctrl+C to stop');
  console.log('='.repeat(54) + '\n');

  // Auto-open browser after short delay
  setTimeout(() => {
    const url = `http://localhost:${PORT}`;
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : `open "${url}"`;
    exec(cmd, err => { if (err) console.log(`  (Could not auto-open browser — visit ${url} manually)`); });
  }, 800);
});
