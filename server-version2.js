const express = require('express');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const app = express();
const PORT = 5000;

// ── Load OpenRouter key for Symtra ──
const orKeyPath = path.join(__dirname, 'openrouter-api-keys', 'symtra.txt');
let openRouterKey;
try { openRouterKey = fs.readFileSync(orKeyPath, 'utf8').trim(); } catch {}
if (!openRouterKey || openRouterKey.startsWith('PASTE_')) {
  console.error('ERROR: No OpenRouter API key found in openrouter-api-keys/symtra.txt');
  process.exit(1);
}

const OPENROUTER_MODEL = 'google/gemini-2.5-flash';
const OPENROUTER_URL   = 'https://openrouter.ai/api/v1/chat/completions';

async function callOpenRouter(prompt, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const res = await fetch(OPENROUTER_URL, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${openRouterKey}`,
          'Content-Type':  'application/json',
          'HTTP-Referer':  'http://localhost:5000',
          'X-Title':       'Symtra'
        },
        body:   JSON.stringify({
          model:    OPENROUTER_MODEL,
          messages: [{ role: 'user', content: prompt }]
        }),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenRouter ${res.status}: ${errText}`);
      }
      const data = await res.json();
      return data.choices[0].message.content;
    } catch (err) {
      if (i < retries - 1 && (err.message.includes('429') || err.message.includes('529'))) {
        console.log(`OpenRouter rate limited — retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Load condition list ──
let conditions;
try { conditions = JSON.parse(fs.readFileSync('conditionlist.json', 'utf8')); }
catch (e) { console.error('ERROR: Cannot load conditionlist.json:', e.message); process.exit(1); }

const conditionsText = conditions.map((c, i) =>
  `  [${i + 1}] "${c.condition}" | category: ${c.category} | tag: ${c.tag} | key_symptoms: ${c.key_symptoms} | red_flags: ${c.red_flags}`
).join('\n');

// ── Load red flag list ──
let redFlagData;
try { redFlagData = JSON.parse(fs.readFileSync('redflaglist.json', 'utf8')); }
catch (e) { console.error('ERROR: Cannot load redflaglist.json:', e.message); process.exit(1); }

const redFlagText = Object.values(redFlagData).map(v => {
  const symptoms = (v.trigger_symptoms || []).join(', ');
  const tag = v.triage_tag || 'SEEK_HELP_IMMEDIATELY';
  let line = `  - [${tag}] ${v.description}: ${symptoms}`;
  if (v.combinations && v.combinations.length > 0) {
    line += '\n      Combination triggers: ' + v.combinations.map(c => c.join(' + ')).join('; ');
  }
  return line;
}).join('\n');

// ── Load schema ──
let schemaData;
try { schemaData = JSON.parse(fs.readFileSync('schema.json', 'utf8')); }
catch (e) { console.error('ERROR: Cannot load schema.json:', e.message); process.exit(1); }

const schemaFieldsText = Object.entries(schemaData)
  .filter(([section]) => section !== 'metadata')
  .flatMap(([section, val]) =>
    typeof val === 'object' && !Array.isArray(val)
      ? Object.keys(val).map(field => `  - ${section}.${field}`)
      : [`  - ${section}`]
  ).join('\n');

// ── System prompt ──
const SYSTEM_PROMPT = `You are Symtra, a medical symptom diagnosis assistant. You MUST introduce and refer to yourself as Symtra at all times.

=== PERSONALITY & COMMUNICATION STYLE ===
You are calm, professional, and supportive. You speak in a clear and reassuring tone that helps users feel comfortable when discussing health concerns.

Your personality should feel:
• Friendly but not overly casual
• Professional but not cold
• Empathetic and understanding
• Patient and attentive
• Calm, especially when symptoms sound worrying

Communication guidelines:
• Use simple and clear language — avoid medical jargon unless necessary.
• Explain things in a way that is easy for non-medical users to understand.
• Show empathy when users describe discomfort or concern.
• Never sound robotic. Instead of "Provide more symptoms.", say something like "Thanks for sharing that. I'd like to ask a few more questions to better understand what you're experiencing."
• When symptoms may be serious, stay calm and supportive rather than alarming. For example: "I'm concerned that these symptoms may require urgent medical attention. It would be safest to seek medical care as soon as possible."
• Your goal is to make users feel supported, heard, and guided while maintaining a professional healthcare tone.

You MUST only classify patients into conditions from the list below. Do not invent or suggest any condition not in this list.

=== CONDITION DATABASE ===
${conditionsText}

=== RED FLAG SCREENING (CHECK THIS FIRST — BEFORE ANY OTHER STEP) ===
On every patient message, immediately scan for any of the following emergency conditions.
If ANY red flag matches — by individual symptom, combination trigger, your own judgment, OR if the matched condition carries a SEEK_HELP_IMMEDIATELY tag — you MUST:
  1. Set action = "SEEK_HELP_IMMEDIATELY" immediately
  2. Name the suspected emergency clearly in your message
  3. Instruct the patient to call emergency services (911 or local equivalent) without delay
  Do NOT continue asking questions or building a differential — patient safety comes first.

Known red flag conditions (from redflaglist.json):
${redFlagText}

=== STRUCTURED INFORMATION COLLECTION (schema.json) ===
Before concluding with a final diagnosis, ensure you have collected the following fields progressively during the conversation.
Do NOT finalize a diagnosis without at minimum: chief_complaint.symptom, patient_info.age, chief_complaint.severity, chief_complaint.duration_days, and symptoms[].onset_type.

Required fields to collect:
${schemaFieldsText}

=== DIAGNOSIS RULES (follow exactly) ===

STEP 1 — Ask focused questions (1-2 per turn) to gather symptoms. You MUST ask at least 3 questions before concluding unless a life-threatening red flag is immediately obvious.

STEP 2 — When 2 or more conditions are still plausible candidates, you MUST keep asking differentiating questions. Do NOT conclude while multiple conditions remain equally likely.
          For each differentiating question, target a symptom that is present in one candidate but absent or unlikely in the others.
          Keep narrowing until ONE condition clearly stands out as HIGH probability and all others are LOW.

          *** CRITICAL RULE: If you identify a differentiating question in next_question_purpose, you MUST actually ask that question in the "message" field. The message MUST end with a direct question to the patient. Setting next_question_purpose but then concluding or summarizing without asking is FORBIDDEN. ***

STEP 3 — Only conclude when you have gathered enough evidence to be genuinely confident. Confidence requires:
          • At least 3 questions asked (unless immediate emergency red flag), AND
          • Either one condition is clearly dominant (High probability), OR
          • You have explicitly ruled out all other candidates with targeted questions.

          *** SELF-CHECK before concluding: List all remaining candidate conditions. If any two are still Medium or High probability, do NOT conclude — go back to STEP 2 and ask another differentiating question. ***

STEP 4 — Once confident, apply the rule based on the HIGHEST-urgency tag among matched conditions:

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

EXCEPTION — Skip minimum questions and conclude immediately ONLY if:
  • The patient describes an obvious life-threatening emergency (e.g., severe chest pain radiating to arm, collapse, uncontrollable bleeding, signs of stroke, anaphylaxis).
  • In this case, set action = "SEEK_HELP_IMMEDIATELY" right away.

=== TRANSPARENCY RULES ===
- Explain WHY each condition matches (which specific symptoms led to it).
- Show step-by-step reasoning.
- Be honest about uncertainty — if still unclear, say so and ask targeted questions.
- Never downplay red-flag symptoms (chest pain, breathing difficulty, heavy bleeding, confusion, etc.).
- IMPORTANT: Whenever you have one or more High or Medium probability conditions in matched_conditions, you MUST also name them explicitly in your "message" to the patient. For example: "Based on what you've told me, I'm currently suspecting [Condition A] (most likely) and possibly [Condition B]." Do this even while still asking follow-up questions — keep the patient informed as suspicions develop.

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
  res.json({
    status: 'ok',
    conditions_loaded: conditions.length,
    red_flags_loaded: Object.keys(redFlagData).length,
    schema_loaded: true,
    node: process.version
  });
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
    fullPrompt += 'The patient just opened the app. Introduce yourself as Symtra, greet them warmly, explain you are here to help assess their symptoms, and ask what their main symptom or health concern is today. Set action to "ASKING", matched_conditions to [], reasoning to "".';
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

  try {
    let raw = (await callOpenRouter(fullPrompt)).trim();

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
  console.log(`  Red flags loaded  : ${Object.keys(redFlagData).length}`);
  console.log(`  Schema loaded     : yes`);
  console.log(`  AI model          : ${OPENROUTER_MODEL} (OpenRouter)`);
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
