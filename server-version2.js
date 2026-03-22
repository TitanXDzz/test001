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

// ── Server-side Red Flag Scanner ──────────────────────────────────────────────
// Normalises common patient phrasings to canonical trigger symptom phrases
function normalizeSymptoms(text) {
  return text.toLowerCase()
    // breathing
    .replace(/can'?t breathe|trouble breathing|hard to breathe|hard time breathing|difficulty breathing|cannot breathe|unable to breathe|not breathing well/g, 'difficulty breathing')
    .replace(/short of breath|shortness of breath|not enough air|out of breath/g, 'severe shortness of breath')
    .replace(/gasping for air|gasping|can barely breathe/g, 'gasping for air')
    .replace(/can'?t speak.*(full )?sentences?|unable to speak.*sentences?|barely speak/g, 'unable to speak full sentences')
    .replace(/blue lips?|lips? (are |is )?blue|cyanosis/g, 'blue lips')
    // cardiac
    .replace(/chest (pain|hurt|ache|hurts?|is painful)|pain in (my )?chest/g, 'chest pain')
    .replace(/chest pressure|pressure (on|in) (my )?chest/g, 'chest pressure')
    .replace(/chest.*(tight|tightness)|tight.*(chest)/g, 'tight chest')
    .replace(/spread(ing)?.*(arm|shoulder)|radiat(ing)?.*(arm|shoulder)|pain.*(arm|shoulder).*chest|chest.*pain.*(arm|shoulder)/g, 'pain spreading to arm')
    .replace(/spread(ing)?.*(jaw)|radiat(ing)?.*(jaw)|jaw.*pain|pain.*jaw/g, 'pain spreading to jaw')
    .replace(/sweat(ing)?|drenched in sweat|profuse sweat/g, 'sweating')
    // stroke FAST
    .replace(/face.*(droop|drop|fell|drooping)|droop.*(face)/g, 'face drooping')
    .replace(/arm.*(weak|weakness|numb)|weak.*(arm)/g, 'arm weakness')
    .replace(/trouble speaking|difficulty speaking|slurred speech|can'?t speak|hard to speak|speech (problem|difficulty|trouble)/g, 'speech difficulty')
    .replace(/sudden confusion|confused|confusion|disoriented|not thinking clearly/g, 'confusion')
    .replace(/vision.*(loss|lost|gone)|can'?t see suddenly|sudden.*(blur|vision)/g, 'vision loss')
    .replace(/loss of balance|can'?t balance|losing balance|falling over/g, 'loss of balance')
    .replace(/worst headache|sudden severe headache|sudden terrible headache|thunderclap headache/g, 'sudden severe headache')
    // allergy / anaphylaxis
    .replace(/swoll?en?.*(lips?|tongue|throat)|lips?.*(swoll?en|swelling)|tongue.*(swoll?en|swelling)|throat.*(swoll?en|swelling|tight|closing)/g, 'swelling of throat')
    .replace(/hives|urticaria/g, 'hives')
    .replace(/faint(ing|ed)?|passed? out|about to faint|nearly fainted|feel(ing)? like (i might )?faint/g, 'fainting')
    // sepsis / meningitis
    .replace(/high fever|very high (fever|temperature)|extremely high (fever|temperature)/g, 'high fever')
    .replace(/stiff neck|neck.*(stiff|rigid|stiffness)|can'?t move (my )?neck|neck won'?t move/g, 'stiff neck')
    .replace(/light.*(sensitive|bother|hurt|sensitivity)|sensitive.*light|photophobia|bright light (bother|hurt)/g, 'light sensitivity')
    .replace(/rapid(ly)? breath(ing)?|breathing fast|fast breathing|breathing quickly/g, 'rapid breathing')
    .replace(/extreme(ly)? weak(ness)?|very weak|can barely move|too weak to/g, 'extreme weakness')
    // seizure
    .replace(/seizure|convuls(ion|ions|ing|ed)?|blacked? out|uncontrolled? shaking|fit \(seizure\)|twitching uncontrollably/g, 'seizure')
    .replace(/loss of consciousness|lost consciousness/g, 'loss of consciousness')
    // bleeding
    .replace(/heavy bleeding|bleeding heavily|a lot of blood|severe bleeding/g, 'heavy bleeding')
    .replace(/bleeding (that )?(won'?t|doesn'?t|will not) stop|can'?t stop bleeding|bleeding non.?stop/g, 'bleeding that will not stop')
    .replace(/vomit(ing)? blood|throw(ing)? up blood/g, 'vomiting blood')
    .replace(/blood in (my )?(stool|poop|bowel movement)|bloody stool/g, 'blood in stool')
    .replace(/cough(ing)? (up )?blood|blood when (i )?cough/g, 'coughing blood')
    .replace(/bleeding gums?|gums?.*(bleed|bleeding)/g, 'bleeding gums')
    // dehydration
    .replace(/extreme(ly)? thirst(y)?|very thirst(y)?|terribly thirsty/g, 'extreme thirst')
    .replace(/can'?t (keep|hold) fluids?|unable to drink|can'?t drink/g, 'unable to drink fluids')
    .replace(/barely urinating|not urinating|very little urine|no urine/g, 'very little urine')
    // abdominal / appendicitis
    .replace(/severe (stomach|abdominal|belly|gut) pain|very bad (stomach|abdominal) pain|excruciating (stomach|abdominal) pain/g, 'severe abdominal pain')
    .replace(/lower right (stomach|abdomen|abdominal|belly|side|quadrant)|right lower (abdomen|stomach|belly|abdominal|side|quadrant)|right side (lower|bottom)|pain.*(lower right)/g, 'right lower abdominal pain')
    .replace(/can'?t stop vomiting|persistent vomiting|vomiting (again and again|repeatedly|over and over)/g, 'persistent vomiting');
}

function serverRedFlagCheck(patientMessages) {
  const rawText = patientMessages.join(' ');
  const text = normalizeSymptoms(rawText);

  // Sort by priority (lower number = more critical, check first)
  const sorted = Object.entries(redFlagData)
    .sort((a, b) => (a[1].priority || 99) - (b[1].priority || 99));

  for (const [key, flag] of sorted) {
    const triggers = (flag.trigger_symptoms || []).map(s => s.toLowerCase());
    const strategy = flag.match_strategy;

    if (strategy === 'any') {
      if (triggers.some(t => text.includes(t))) {
        return { triggered: true, key, description: flag.description, tag: flag.triage_tag };
      }
    } else if (strategy === 'combination') {
      const combos = flag.combinations || [];
      const hit = combos.find(combo => combo.every(s => text.includes(s.toLowerCase())));
      if (hit) {
        return { triggered: true, key, description: flag.description, tag: flag.triage_tag };
      }
    }
  }
  return { triggered: false };
}

// ── Condition Tag Enforcer ─────────────────────────────────────────────────────
// Ensures triage action is never lower than what matched conditions demand
function enforceConditionTriage(llmAction, matchedConditions) {
  const urgency = { 'SEEK_HELP_IMMEDIATELY': 3, 'SEEK_HELP_SOON': 2, 'CONTINUE': 1, 'ASKING': 0 };
  let highest = llmAction;

  for (const mc of matchedConditions) {
    const prob = (mc.probability || '').toLowerCase();
    const cond = conditions.find(c => c.condition.toLowerCase() === (mc.name || '').toLowerCase());
    if (!cond) continue;

    // High probability + serious condition tag → always enforce
    if (prob === 'high' && cond.tag === 'SEEK_HELP_IMMEDIATELY') {
      return 'SEEK_HELP_IMMEDIATELY';
    }

    // Medium probability + SEEK_HELP_IMMEDIATELY → at minimum SEEK_HELP_SOON
    if (prob === 'medium' && cond.tag === 'SEEK_HELP_IMMEDIATELY') {
      if ((urgency['SEEK_HELP_SOON'] || 0) > (urgency[highest] || 0)) {
        highest = 'SEEK_HELP_SOON';
      }
    }

    // Any probability + SEEK_HELP_SOON → at minimum SEEK_HELP_SOON
    if (cond.tag === 'SEEK_HELP_SOON' && (urgency[highest] || 0) < (urgency['SEEK_HELP_SOON'] || 0)) {
      highest = 'SEEK_HELP_SOON';
    }
  }

  return highest;
}

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

=== ⚠️ MANDATORY SAFETY RULES — READ BEFORE ANYTHING ELSE ===

RULE 1 — TRIAGE IS BASED ON WORST SYMPTOM, NOT JUST DIAGNOSIS LABEL
Your triage action must reflect the MOST DANGEROUS symptom reported by the patient — not only the predicted condition name.
Even if your best-match condition is "Mild influenza" or "Common cold", if the patient also reports any of the following, you MUST escalate:
  • Shortness of breath / difficulty breathing → SEEK_HELP_IMMEDIATELY
  • Confusion (especially with fever) → SEEK_HELP_IMMEDIATELY
  • Chest pain with sweating, arm/jaw pain, or nausea → SEEK_HELP_IMMEDIATELY
  • Stiff neck with high fever → SEEK_HELP_IMMEDIATELY
  • Unable to speak in full sentences → SEEK_HELP_IMMEDIATELY
  • Face drooping or sudden arm weakness with speech difficulty → SEEK_HELP_IMMEDIATELY
  • Active seizure / loss of consciousness → SEEK_HELP_IMMEDIATELY
  • Throat/lip swelling with breathing difficulty → SEEK_HELP_IMMEDIATELY

RULE 2 — RE-CHECK RED FLAGS AFTER EVERY PATIENT MESSAGE
Every time the patient answers a follow-up question, re-scan ALL symptoms they have reported so far.
Dangerous symptoms often appear in ANSWERS to your questions, not just the opening message.
Examples:
  → You ask about breathing. Patient says "yes, I'm short of breath." → SEEK_HELP_IMMEDIATELY immediately. Do not ask more questions.
  → You ask about confusion. Patient says "yes, a bit confused" and they have high fever → SEEK_HELP_IMMEDIATELY (sepsis/meningitis).
  → You ask about chest pain spreading. Patient says "yes, to my left arm" → SEEK_HELP_IMMEDIATELY (cardiac).
Once a red flag is confirmed in any answer, stop gathering information and escalate immediately.

RULE 3 — SAFETY BIAS (NON-NEGOTIABLE)
When genuinely uncertain between two triage levels:
  • CONTINUE vs SEEK_HELP_SOON → choose SEEK_HELP_SOON
  • SEEK_HELP_SOON vs SEEK_HELP_IMMEDIATELY → choose SEEK_HELP_IMMEDIATELY
Patient safety is always more important than avoiding false alarms.

RULE 4 — DO NOT DEFAULT TO MILD CONDITIONS
"Common cold", "Mild sinus congestion", "Tension headache", "Indigestion" etc. must ONLY be your top match when:
  (a) The patient has no dangerous or severe symptoms whatsoever
  (b) More serious conditions have been ruled out with specific targeted questions
  (c) All symptoms are explicitly mild
If the patient has risk factors (elderly, chronic illness, immunocompromised) or severe-sounding symptoms, bias toward the more serious condition.

RULE 5 — DO NOT RULE OUT SERIOUS CONDITIONS PREMATURELY
If a more serious condition shares 50%+ of its key symptoms with what the patient has reported, but you have NOT yet asked about the remaining symptoms — ask those questions before ruling it out.
Example: Patient has fever + cough + fatigue → COVID-19 suspected and Possible pneumonia are both plausible. Ask about breathing, smell, and chest pain before concluding it's just a cold.

=== RED FLAG SCREENING (CHECK THIS ON EVERY TURN — BEFORE ANYTHING ELSE) ===
Scan ALL patient-reported symptoms against the red flag patterns below.
If ANY red flag matches — by individual symptom, combination trigger, your own clinical judgment — you MUST:
  1. Set action = "SEEK_HELP_IMMEDIATELY"
  2. Name the suspected emergency clearly
  3. Tell the patient to call emergency services immediately
  Do NOT ask more questions. Patient safety is the absolute priority.

Known red flag conditions:
${redFlagText}

CRITICAL RED FLAG COMBINATIONS TO MEMORISE:
  • Chest pain + sweating → cardiac emergency → SEEK_HELP_IMMEDIATELY
  • Chest pain + shortness of breath → cardiac or pulmonary emergency → SEEK_HELP_IMMEDIATELY
  • Chest pain + pain to arm or jaw → heart attack → SEEK_HELP_IMMEDIATELY
  • High fever + stiff neck → meningitis → SEEK_HELP_IMMEDIATELY
  • High fever + confusion → sepsis or meningitis → SEEK_HELP_IMMEDIATELY
  • High fever + rapid breathing → sepsis → SEEK_HELP_IMMEDIATELY
  • Shortness of breath (severe) or difficulty breathing → SEEK_HELP_IMMEDIATELY
  • Face drooping + speech difficulty → stroke → SEEK_HELP_IMMEDIATELY
  • Seizure / convulsions / loss of consciousness → SEEK_HELP_IMMEDIATELY
  • Throat or lip swelling + difficulty breathing → anaphylaxis → SEEK_HELP_IMMEDIATELY
  • Severe right lower abdominal pain + fever → appendicitis → SEEK_HELP_IMMEDIATELY
  • Bleeding gums + severe abdominal pain + persistent vomiting (dengue) → SEEK_HELP_IMMEDIATELY

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
          *** CRITICAL RULE: If you identify a differentiating question in next_question_purpose, you MUST actually ask that question in the "message" field. Setting next_question_purpose but then concluding or summarizing without asking is FORBIDDEN. ***

STEP 3 — Only conclude when you have gathered enough evidence to be genuinely confident. Confidence requires:
          • At least 3 questions asked (unless immediate emergency red flag), AND
          • Either one condition is clearly dominant (High probability), OR
          • You have explicitly ruled out all other candidates with targeted questions.
          *** SELF-CHECK before concluding: List all remaining candidate conditions. If any two are still Medium or High probability, do NOT conclude — go back to STEP 2. ***

STEP 4 — Determine the FINAL TRIAGE LEVEL using BOTH of these checks — use whichever gives the HIGHER urgency:
          (A) Symptom-based triage: Does the patient have any red flag symptom? → apply Rule 1 above
          (B) Condition-based triage: What is the tag of the highest-probability matched condition?
          → Final action = whichever of (A) or (B) gives the MORE urgent result.

  action = "CONTINUE"               — all matched conditions are CONTINUE-tag and NO red flag symptoms
  action = "SEEK_HELP_SOON"         — highest matched condition is SEEK_HELP_SOON OR patient has moderate-risk symptoms
  action = "SEEK_HELP_IMMEDIATELY"  — ANY red flag symptom confirmed OR any High-probability condition has SEEK_HELP_IMMEDIATELY tag

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
    const matchedConditions = parsed.matched_conditions || [];
    const reasoning = parsed.reasoning || '';
    const nextQuestionPurpose = parsed.next_question_purpose || '';

    // ── Server-side safety enforcement ──────────────────────────────────────
    // Run deterministic red flag check across all patient messages so far
    const patientMessages = session.history.filter(m => m.role === 'user').map(m => m.text);
    const redFlagResult   = serverRedFlagCheck(patientMessages);

    let action = parsed.action || 'ASKING';

    // 1. Hard override: red flag detected in patient text
    if (redFlagResult.triggered && redFlagResult.tag === 'SEEK_HELP_IMMEDIATELY') {
      action = 'SEEK_HELP_IMMEDIATELY';
    }

    // 2. Condition tag enforcement: ensure action is never lower than conditions demand
    if (action !== 'SEEK_HELP_IMMEDIATELY') {
      action = enforceConditionTriage(action, matchedConditions);
    }
    // ────────────────────────────────────────────────────────────────────────

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
