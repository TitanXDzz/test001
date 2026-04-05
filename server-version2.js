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
// Normalises natural-language patient phrasings to canonical trigger keywords
function normalizeSymptoms(text) {
  let t = text.toLowerCase();

  // === BREATHING ===
  t = t.replace(/can'?t breathe|cannot breathe|trouble breathing|hard(?: time)? to? breathe|difficulty breathing|unable to breathe|not breathing (?:well|properly|right)|breathing (?:is )?hard|struggling to breathe|having trouble breathing/g, 'difficulty breathing');
  t = t.replace(/short of breath|shortness of breath|not enough air|out of breath|breath(?:ing)? is short/g, 'severe shortness of breath');
  t = t.replace(/gasping(?: for air)?|can barely breathe|barely breathing|struggling for air/g, 'gasping for air');
  t = t.replace(/can'?t (?:speak|talk) in (?:full )?sentences?|unable to speak.*sentences?|barely (?:speak|talk)|speaking in (?:short|incomplete) sentences?/g, 'unable to speak full sentences');
  t = t.replace(/blue lips?|lips? (?:are |is |turning )?blue|bluish lips?|cyanosis/g, 'blue lips');
  t = t.replace(/wheez(?:e|ing)|whistling (?:when|while) breathing/g, 'wheezing');

  // === CARDIAC ===
  t = t.replace(/chest (?:pain|hurt|hurts?|ache|aches?|is painful|is sore|discomfort)|pain (?:in|on) (?:my )?(?:chest|heart area)|chest feels? (?:painful|sore)|tight chest|chest tightness|chest (?:feels? )?tight/g, 'chest pain');
  t = t.replace(/chest pressure|pressure (?:on|in|around) (?:my )?chest|feels? like (?:pressure|weight|elephant) on (?:my )?chest/g, 'chest pressure');
  t = t.replace(/spread(?:ing)? (?:to|toward) (?:my )?(?:left )?(?:arm|shoulder)|radiat(?:ing|es) (?:to|toward) (?:my )?(?:left )?(?:arm|shoulder)|pain going (?:down|to) (?:my )?(?:left )?(?:arm|shoulder)|arm (?:pain|ache).*chest|chest.*pain.*arm/g, 'pain spreading to arm');
  t = t.replace(/spread(?:ing)? (?:to|toward) (?:my )?jaw|radiat(?:ing|es) (?:to|toward) (?:my )?jaw|jaw (?:pain|ache)|pain.*(?:to|in) (?:my )?jaw/g, 'pain spreading to jaw');
  t = t.replace(/sweat(?:ing|s|ed)?|drenched(?: in sweat)?|profuse(?:ly)? sweat(?:ing)?/g, 'sweating');
  t = t.replace(/heart (?:racing|pounding|beating fast|palpitat)|palpitat|rapidly? (?:beating|pounding) heart|fast heart(?:beat)?/g, 'rapid heartbeat');

  // === STROKE ===
  t = t.replace(/face (?:drooping|droop|drop|fell|is drooping|looks? drooped?|feels? droopy)|drooping face|facial droop/g, 'face drooping');
  t = t.replace(/arm (?:weakness|is weak|feels? weak|won'?t move|can'?t lift)|weak(?:ness in| )arm|one arm (?:is )?weak/g, 'arm weakness');
  t = t.replace(/trouble speaking|difficulty speaking|slurred speech|can'?t speak|hard to speak|speech (?:problem|difficulty|trouble|slurred)|words (?:won'?t come|aren'?t coming|are slurred)/g, 'speech difficulty');
  t = t.replace(/(?:sudden(?:ly)?|new) confusion|confused|confusion|disoriented|not thinking clearly|mind (?:is )?foggy|can'?t think (?:straight|clearly)/g, 'confusion');
  t = t.replace(/vision (?:loss|lost|gone|is gone)|can'?t see (?:well |properly |clearly )?suddenly|sudden(?:ly)? (?:blind|can'?t see|loss of vision)|blurry vision (?:sudden|all of (?:a )?sudden)/g, 'vision loss');
  t = t.replace(/loss of balance|can'?t balance|losing balance|falling over|unsteady (?:on my feet|walking)|dizzy and falling/g, 'loss of balance');
  t = t.replace(/worst headache(?: of my life)?|sudden(?:ly)? severe headache|sudden(?:ly)? terrible headache|thunderclap headache|worst pain in my head/g, 'sudden severe headache');

  // === ALLERGY / ANAPHYLAXIS ===
  t = t.replace(/swoll?en?.*(lips?|tongue|throat)|lips?.*(swoll?en|swelling)|tongue.*(swoll?en|swelling)|throat.*(swoll?en|swelling|closing(?: up)?|tightening)|mouth (?:swollen|swelling)/g, 'swelling of throat');
  t = t.replace(/hives|urticaria|welts (?:all over|on skin)|itchy (?:bumps|welts) (?:all over|everywhere)/g, 'hives');
  t = t.replace(/faint(?:ing|ed)?|passed? out|about to faint|feel(?:ing)? like (?:i(?:'m| am| might| could) )?faint(?:ing)?|nearly fainted|almost fainted|collapsed?|falling? unconscious/g, 'fainting');

  // === SEPSIS / MENINGITIS / INFECTION ===
  t = t.replace(/high fever|very high (?:fever|temperature)|extremely high (?:fever|temperature)|temperature (?:is )?(?:very|extremely) high|fever (?:is )?(?:very|extremely|dangerously) high|burning up|spiking (?:a )?fever/g, 'high fever');
  t = t.replace(/stiff neck|neck.*(?:stiff|rigid|stiffness)|can'?t (?:move|turn|bend) (?:my )?neck|neck won'?t move|neck (?:is |feels? )stiff|stiffness in (?:my )?neck/g, 'stiff neck');
  t = t.replace(/light.*(?:sensitive|bother|hurt|sensitivity|hurts?)|sensitive (?:to|about) light|photophobia|bright light (?:bother|hurt|is painful)|light (?:is )?painful/g, 'light sensitivity');
  t = t.replace(/rapid(?:ly)? breath(?:ing)?|breathing (?:fast|quickly|rapidly)|fast breathing|breath(?:ing)? (?:rate )?is (?:fast|rapid|quick)/g, 'rapid breathing');
  t = t.replace(/extreme(?:ly)? weak(?:ness)?|very weak|can barely move|too weak to|incredibly weak|severely weak|weakness is (?:severe|extreme|bad)/g, 'extreme weakness');

  // === SEIZURE ===
  t = t.replace(/seizure|convuls(?:ion|ions|ing|ed)?|blacked? out|fit \(seizure\)|epileptic|grand mal/g, 'seizure');
  t = t.replace(/body (?:shook|shake|shakes?|shak(?:ing|ed)) uncontroll|shak(?:ing|ed) (?:uncontrollably|violently|all over)|uncontroll(?:ably|able) shak|twitching uncontrollably|jerking uncontrollably/g, 'seizure');
  t = t.replace(/passed? out|lost consciousness|loss of consciousness|went unconscious|became unconscious/g, 'loss of consciousness');

  // === BLEEDING ===
  t = t.replace(/heavy bleeding|bleeding heavily|a lot of blood (?:coming out|flowing)|severe bleeding|profuse bleeding/g, 'heavy bleeding');
  t = t.replace(/bleeding (?:that |which )?(?:won'?t|doesn'?t|will not|refuses to) stop|can'?t stop (?:the )?bleeding|non.?stop bleeding/g, 'bleeding that will not stop');
  t = t.replace(/vomit(?:ing)? (?:up )?blood|throw(?:ing)? up blood|blood in (?:my )?vomit|threw up blood/g, 'vomiting blood');
  t = t.replace(/blood in (?:my )?(?:stool|poop|bowel movement|feces)|bloody stool|stool (?:has|with|is) blood/g, 'blood in stool');
  t = t.replace(/cough(?:ing)? (?:up )?blood|blood when (?:i )?cough|spitting (?:up )?blood/g, 'coughing blood');
  t = t.replace(/bleeding gums?|gums?.*(?:bleed|bleeding|are bleeding)|gums that bleed/g, 'bleeding gums');
  t = t.replace(/nose(?:bleed| bleeding| is bleeding)|bleeding (?:from|out of) (?:my )?nose/g, 'nose bleeding');

  // === DEHYDRATION ===
  t = t.replace(/extreme(?:ly)? thirst(?:y)?|very thirst(?:y)?|terribly thirst(?:y)?|incredibly thirst(?:y)?/g, 'extreme thirst');
  t = t.replace(/can'?t (?:keep|hold) fluids?(?: down)?|unable to drink|can'?t drink|vomiting everything|nothing (?:is )?staying down/g, 'unable to drink fluids');
  t = t.replace(/barely urinating|not urinating|very little urine|no urine|haven'?t (?:urinated|peed) in/g, 'very little urine');

  // === ABDOMINAL ===
  t = t.replace(/severe (?:stomach|abdominal|belly|gut|tummy) pain|very bad (?:stomach|abdominal|belly) pain|excruciating (?:stomach|abdominal|belly) pain|(?:terrible|horrible|awful) (?:stomach|abdominal|belly) pain/g, 'severe abdominal pain');
  t = t.replace(/lower right (?:stomach|abdomen|abdominal|belly|side|quadrant|area)|right lower (?:abdomen|stomach|belly|abdominal|side|quadrant|area)|right side (?:lower|bottom)|pain.*lower right|lower right.*pain/g, 'right lower abdominal pain');
  t = t.replace(/can'?t stop vomiting|persistent vomiting|vomiting (?:again and again|repeatedly|over and over|keeps? happening|non.?stop)|keeps? vomiting|won'?t stop vomiting/g, 'persistent vomiting');

  return t;
}

// Additional dangerous combinations not fully covered by redflaglist.json
const EXTRA_IMMEDIATE_COMBINATIONS = [
  ['high fever', 'extreme weakness'],     // severe infection / sepsis
  ['high fever', 'confusion'],            // sepsis / meningitis (backup)
  ['high fever', 'stiff neck'],           // meningitis (backup)
  ['high fever', 'rapid breathing'],      // sepsis (backup)
  ['chest pain', 'sweating'],             // cardiac (backup)
  ['chest pain', 'severe shortness of breath'], // cardiac/PE (backup)
  ['chest pain', 'pain spreading to arm'],      // cardiac (backup)
  ['chest pain', 'rapid heartbeat'],      // cardiac / PE
  ['hives', 'difficulty breathing'],      // anaphylaxis (backup)
  ['swelling of throat', 'difficulty breathing'], // anaphylaxis (backup)
  ['bleeding gums', 'severe abdominal pain'],     // dengue warning
  ['bleeding gums', 'persistent vomiting'],       // dengue warning
  ['nose bleeding', 'persistent vomiting'],       // dengue warning
  ['right lower abdominal pain', 'high fever'],   // appendicitis (backup)
  ['fainting', 'severe shortness of breath'],     // PE / cardiac
];

// Symptoms that alone (without combinations) always warrant SEEK_HELP_IMMEDIATELY
const SOLO_IMMEDIATE_SYMPTOMS = [
  'difficulty breathing',
  'severe shortness of breath',
  'gasping for air',
  'unable to speak full sentences',
  'blue lips',
  'face drooping',
  'speech difficulty',
  'vision loss',
  'sudden severe headache',
  'seizure',
  'loss of consciousness',
  'vomiting blood',
  'coughing blood',
  'heavy bleeding',
  'bleeding that will not stop',
  'swelling of throat',
];

function serverRedFlagCheck(patientMessages) {
  const rawText = patientMessages.join(' ');
  const text = normalizeSymptoms(rawText);

  // 1. Check solo immediate symptoms first
  for (const sym of SOLO_IMMEDIATE_SYMPTOMS) {
    if (text.includes(sym)) {
      return { triggered: true, key: 'solo_immediate', description: sym, tag: 'SEEK_HELP_IMMEDIATELY' };
    }
  }

  // 2. Check redflaglist.json (sorted by priority)
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

  // 3. Check extra dangerous combinations
  for (const combo of EXTRA_IMMEDIATE_COMBINATIONS) {
    if (combo.every(s => text.includes(s))) {
      return { triggered: true, key: 'combination', description: combo.join(' + '), tag: 'SEEK_HELP_IMMEDIATELY' };
    }
  }

  return { triggered: false };
}

// ── Condition Tag Enforcer ─────────────────────────────────────────────────────
function enforceConditionTriage(llmAction, matchedConditions) {
  const urgency = { 'SEEK_HELP_IMMEDIATELY': 3, 'SEEK_HELP_SOON': 2, 'CONTINUE': 1, 'ASKING': 0 };
  let highest = llmAction;

  for (const mc of matchedConditions) {
    const prob = (mc.probability || '').toLowerCase();
    const cond = conditions.find(c => c.condition.toLowerCase() === (mc.name || '').toLowerCase());
    if (!cond) continue;

    // High OR Medium probability + SEEK_HELP_IMMEDIATELY → always enforce IMMEDIATELY
    // Safety-first: even medium confidence in a deadly condition warrants immediate escalation
    if ((prob === 'high' || prob === 'medium') && cond.tag === 'SEEK_HELP_IMMEDIATELY') {
      return 'SEEK_HELP_IMMEDIATELY';
    }

    // Any probability + SEEK_HELP_SOON → upgrade if currently lower
    if (cond.tag === 'SEEK_HELP_SOON' && (urgency[highest] || 0) < urgency['SEEK_HELP_SOON']) {
      highest = 'SEEK_HELP_SOON';
    }
  }

  return highest;
}

// ── Asked-field detector ──────────────────────────────────────────────────────
// Scans an assistant message for keywords indicating which fields were asked about.
// Used to prevent re-asking fields the LLM already covered (even if collectedFields
// wasn't updated because the LLM forgot to self-report).
const FIELD_ASKED_KEYWORDS = {
  medications:      ['medication', 'medicine', 'taking any', 'ยา', 'รับประทานยา', 'กินยา'],
  allergies:        ['allerg', 'แพ้'],
  medical_history:  ['medical history', 'surgery', 'surgeries', 'past illness', 'chronic condition',
                     'ประวัติ', 'ผ่าตัด', 'โรคประจำตัว', 'เจ็บป่วย'],
  age:              ['how old', 'your age', 'อายุ'],
  biological_sex:   ['gender', 'biological sex', 'เพศ'],
  pregnancy_status: ['pregnant', 'pregnancy', 'ตั้งครรภ์', 'มีครรภ์'],
  chief_complaint:  ['main symptom', 'chief complaint', 'อาการ', 'อาการหลัก'],
  severity:         ['scale of 0', 'severity', 'how severe', 'how bad', 'ความรุนแรง', 'คะแนน'],
  duration:         ['how long', 'when did', 'duration', 'นานแค่ไหน', 'เริ่มมีอาการ'],
};

function detectAskedFields(text) {
  const t = text.toLowerCase();
  const found = [];
  for (const [field, keywords] of Object.entries(FIELD_ASKED_KEYWORDS)) {
    if (keywords.some(kw => t.includes(kw.toLowerCase()))) found.push(field);
  }
  return found;
}

// ── Load schema ──
let schemaData;
try { schemaData = JSON.parse(fs.readFileSync('schema.json', 'utf8')); }
catch (e) { console.error('ERROR: Cannot load schema.json:', e.message); process.exit(1); }

// ── Load extraction agent prompt ──
let extractionAgentPrompt;
try { extractionAgentPrompt = fs.readFileSync('extraction-agent.txt', 'utf8'); }
catch (e) { console.error('ERROR: Cannot load extraction-agent.txt:', e.message); process.exit(1); }

// ── Decision Log ──
const LOG_PATH = path.join(__dirname, 'symtra-decision-log.json');
let decisionLog;
try {
  decisionLog = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
  // Strip out the example/schema entry on first real use
  decisionLog.log_entries = (decisionLog.log_entries || []).filter(e => !e._example);
} catch {
  decisionLog = { _description: 'Symtra Decision Log', _schema_version: '1.0', log_entries: [] };
}

function appendDecisionLog(entry) {
  decisionLog.log_entries.push(entry);
  fs.writeFile(LOG_PATH, JSON.stringify(decisionLog, null, 2), err => {
    if (err) console.error('Decision log write error:', err.message);
  });
}

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

=== ⚠️ MANDATORY SAFETY RULES ===

RULE 1 — TRIAGE BY WORST SYMPTOM, NOT BY DIAGNOSIS LABEL
Your action must reflect the most dangerous symptom present, regardless of what condition you diagnosed.
Even if the top condition is "Common cold" or "Mild influenza", if the patient confirms ANY of these, escalate:
  • Difficulty breathing / shortness of breath → SEEK_HELP_IMMEDIATELY
  • Confusion (especially with fever) → SEEK_HELP_IMMEDIATELY
  • Chest pain + sweating / arm pain / jaw pain → SEEK_HELP_IMMEDIATELY
  • High fever + stiff neck → SEEK_HELP_IMMEDIATELY
  • High fever + extreme weakness → SEEK_HELP_IMMEDIATELY
  • High fever + confusion or rapid breathing → SEEK_HELP_IMMEDIATELY
  • Seizure / loss of consciousness / convulsions → SEEK_HELP_IMMEDIATELY
  • Face drooping / arm weakness / speech difficulty → SEEK_HELP_IMMEDIATELY
  • Throat or lip swelling + difficulty breathing → SEEK_HELP_IMMEDIATELY
  • Bleeding gums + persistent vomiting → SEEK_HELP_IMMEDIATELY

RULE 2 — ACT IMMEDIATELY WHEN A RED FLAG CONFIRMED IN ANY ANSWER
Red flags appear in follow-up answers, not just opening messages. After every patient reply, re-check ALL symptoms reported so far.
  → Patient says "yes, short of breath" → stop, escalate to SEEK_HELP_IMMEDIATELY
  → Patient says "yes, a bit confused" + has fever → SEEK_HELP_IMMEDIATELY
  → Patient says "yes, pain goes to my arm" + has chest pain → SEEK_HELP_IMMEDIATELY
  → Patient says "my gums are bleeding" + fever + vomiting → SEEK_HELP_IMMEDIATELY
Do NOT continue the conversation once a red flag is confirmed.

RULE 3 — UNCERTAINTY = ESCALATE
  • Unsure CONTINUE vs SEEK_HELP_SOON → choose SEEK_HELP_SOON
  • Unsure SEEK_HELP_SOON vs SEEK_HELP_IMMEDIATELY → choose SEEK_HELP_IMMEDIATELY

RULE 4 — MANDATORY PRE-CONCLUSION SAFETY CHECKLIST
Before concluding with CONTINUE or SEEK_HELP_SOON, verify you have asked the relevant safety questions below.
If NOT yet asked, ask them before concluding.

  IF patient has fever:
    → Ask: "Do you have a stiff neck or pain when moving your neck?"
    → Ask: "Are you feeling confused or disoriented at all?"
    → Ask: "Are you breathing faster than usual, or finding it hard to breathe?"
    → Ask: "Do you feel extremely weak — too weak to move normally?"
    [fever + stiff neck → meningitis → IMMEDIATE]
    [fever + confusion OR rapid breathing OR extreme weakness → sepsis → IMMEDIATE]

  IF patient has cough, congestion, sore throat, or any respiratory symptom:
    → Ask: "Are you having any difficulty breathing or shortness of breath?"
    → Ask: "Are you feeling confused or unusually weak?"
    [breathing difficulty → IMMEDIATE] [confusion + fever → IMMEDIATE]

  IF patient has chest pain, tightness, or pressure:
    → Ask: "Does the pain spread to your arm, shoulder, or jaw?"
    → Ask: "Are you sweating or feeling nauseous with it?"
    → Ask: "Are you short of breath?"
    [any YES → cardiac emergency → IMMEDIATE]

  IF patient has headache:
    → Ask: "Did this come on suddenly and very severely?"
    → Ask: "Do you have a stiff neck or sensitivity to bright light?"
    [sudden + severe + stiff neck or light sensitivity → meningitis → IMMEDIATE]

  IF patient has abdominal pain:
    → Ask: "Is the pain mainly in the lower right side of your abdomen?"
    → Ask: "Do you have fever with this pain?"
    [right lower + fever → appendicitis → IMMEDIATE]

  IF patient has fever + rash, muscle pain, or headache (possible dengue):
    → Ask: "Are your gums or nose bleeding at all, even slightly?"
    → Ask: "Do you have severe stomach pain?"
    → Ask: "Are you vomiting repeatedly or unable to keep fluids down?"
    [bleeding gums OR nose bleeding + any of the above → dengue warning → IMMEDIATE]

  IF patient has dizziness, disorientation, confusion, or any neurological/mental symptom:
    → Ask: "Have you had any episodes where your body shook, convulsed, or you lost consciousness?"
    → Ask: "Have you had any seizures or blackouts — even briefly?"
    [any YES → seizure emergency → IMMEDIATE]

  IF patient feels extremely weak, shaky, confused, or sweating without clear cause:
    → Ask: "Do you have diabetes or take insulin?"
    → Ask: "Did you miss a meal or take medication recently?"
    → Ask: "Are you shaking or trembling right now?"
    [shaking + diabetes + missed meal → hypoglycemia → IMMEDIATE]

  IF patient had a seizure, convulsion, or lost consciousness:
    → Do NOT ask follow-up. Escalate to SEEK_HELP_IMMEDIATELY immediately.

  IF patient has fever, any infection signs, skin infection, or urinary symptoms — and immunocompromised status not yet asked:
    → Ask: "Are you immunocompromised — for example, do you have HIV, cancer, or take medications that suppress your immune system?"
    [If YES → escalate one level higher than normal: mild symptoms → SEEK_HELP_SOON; moderate symptoms → SEEK_HELP_IMMEDIATELY]

  IF patient has any bleeding, bruising, a fall, or head injury — and anticoagulant status not yet asked:
    → Ask: "Are you currently taking any blood thinners or anticoagulants such as warfarin, rivaroxaban, or aspirin?"
    [If YES → escalate one level higher: minor bleeding → SEEK_HELP_SOON; any head injury or significant bleeding → SEEK_HELP_IMMEDIATELY]

=== RED FLAG SCREENING (CHECK ON EVERY TURN — BEFORE ANY OTHER STEP) ===
Scan ALL patient-reported symptoms. If ANY match, set action = "SEEK_HELP_IMMEDIATELY" and tell patient to call emergency services immediately. Do NOT continue asking questions.

Known red flag conditions:
${redFlagText}

=== MEASURABLE THRESHOLDS (APPLY ON EVERY TURN) ===
Use these numeric and semi-numeric rules alongside symptom keywords. Always apply the worse interpretation if both text and number are given.

- Fever >= 38.5°C → minimum SEEK_HELP_SOON
- Fever >= 39.0°C with weakness or confusion → SEEK_HELP_IMMEDIATELY
- Fever lasting >= 3 days → SEEK_HELP_SOON
- Pain severity >= 7/10 → SEEK_HELP_SOON
- Pain severity >= 9/10 → SEEK_HELP_IMMEDIATELY
- Persistent vomiting >= 3 episodes in 24h OR unable to keep fluids down → SEEK_HELP_IMMEDIATELY
- Diarrhea >= 6 loose stools in 24h → SEEK_HELP_SOON
- Diarrhea >= 6 stools/24h + dizziness or very low urine → SEEK_HELP_IMMEDIATELY
- Nosebleed lasting > 20 minutes → SEEK_HELP_IMMEDIATELY
- Oxygen saturation < 94% (if patient provides it) → SEEK_HELP_IMMEDIATELY
- Heart rate > 120 at rest with concerning symptoms → SEEK_HELP_IMMEDIATELY
- No urine output for >= 8 hours → SEEK_HELP_IMMEDIATELY
- Severe focal abdominal pain persisting > 6 hours → SEEK_HELP_IMMEDIATELY

=== DURATION IS MANDATORY — ALWAYS COLLECT AND ALWAYS USE ===
- ALWAYS ask for how long the chief complaint has been present if not yet given.
- NEVER conclude a session without knowing chief_complaint.duration_days.
- Duration directly affects triage — apply the threshold rules above.
- Include duration in your reasoning on every turn once known.
- Duration thresholds override lower-urgency condition tags. Example: fever for 4 days → minimum SEEK_HELP_SOON even if condition tag is CONTINUE.

=== STRUCTURED INFORMATION COLLECTION (schema.json) ===
EVERY field in the schema is MANDATORY. Do NOT conclude until all fields below are collected.
This schema feeds directly into the prescription module — incomplete data will break downstream processing.

MANDATORY FIELDS — collect all of these before finalizing:
${schemaFieldsText}

=== DURATION COLLECTION RULES ===
Always convert any time expression the patient gives into a number of days for duration_days.
Examples:
- "since yesterday" → 1
- "for about a week" → 7
- "started this morning" → 0 (same day)
- "a few days" → 3
- "two weeks" → 14
- "since last Monday" → calculate days from today
If the patient is vague (e.g. "a while"), ask them to estimate in days or weeks.
NEVER leave duration_days as null when concluding.

=== SEVERITY SCALE (0-10) — USE THIS CLINICALLY ===
0 = none, 1-2 = minimal, 3-4 = mild, 5-6 = moderate, 7-8 = severe, 9 = very severe, 10 = extreme/unbearable.
- Severity >= 7 → raise triage to minimum SEEK_HELP_SOON
- Severity >= 9 → strongly consider SEEK_HELP_IMMEDIATELY
- If patient gives a descriptor ("very painful", "unbearable"), map it to the scale and ask to confirm.
- If both a descriptor and a number are given, use the worse interpretation.
NEVER leave severity as null when concluding.

=== RISK FACTOR COLLECTION — ALWAYS ASK ===
Risk factors change diagnostic weighting. Always ask about relevant risk factors based on the presenting complaint.
Examples by category:
- Cardiovascular: diabetes, hypertension, smoking, obesity, family history of heart disease
- Respiratory: asthma, COPD, smoking history
- Infectious: recent travel, sick contacts, immunocompromised
- Metabolic: diabetes, thyroid disease, kidney disease
- General: pregnancy, elderly age, chronic steroid use, recent surgery or hospitalization
Use collected risk factors to:
- Raise urgency if a high-risk patient has moderate symptoms (e.g. diabetic with chest discomfort → SEEK_HELP_SOON minimum)
- Adjust differential diagnosis weighting
- Inform reasoning field
NEVER leave risk_factors as an empty array when concluding unless patient explicitly denies all relevant ones.

=== INTERVIEW STAGES — FOLLOW IN ORDER ===
Progress through these stages in sequence. Skip ahead ONLY if a red flag forces immediate escalation.

Stage 1 — Intake: Identify chief complaint (main symptom)
Stage 2 — Symptom Clarification: collect severity (0–10), duration (days), onset_type (sudden/gradual/unknown), progression (improving/stable/worsening)
Stage 3 — Early Red Flag Screening: ask red-flag questions specific to the presenting symptoms
Stage 4 — Patient Profile: collect age, biological_sex, pregnancy_status
Stage 5 — Medical Safety: collect medications, allergies, medical_history
Stage 6 — Secondary Red Flag Check: re-evaluate red flags with full context (medications, history, pregnancy)
Stage 7 — Final Verification: confirm all collected data is consistent and complete
Stage 8 — Triage Decision: conclude ONLY after all required fields are filled

Report your current stage in the "interview_stage" field of every response.

=== CONTRADICTION DETECTION — MANDATORY ===
On EVERY turn, compare the patient's new message against ALL previously collected information.

Contradictions to check:
- Severity: earlier "mild" vs now "9/10 pain"
- Symptom presence: earlier "no fever" vs now mentions fever
- Medications: earlier "no medications" vs now names a drug
- Function: "severe pain" but "can do everything normally"
- Timeline: "started today" vs later "been going on for 5 days"

IF a contradiction is detected:
1. DO NOT proceed with the interview
2. DO NOT conclude
3. Set action to "ASKING"
4. Ask a direct clarification question referencing both conflicting pieces of information
   Example: "Earlier you mentioned the pain was mild, but now it sounds much more severe. Could you clarify how bad it actually is?"
5. Set "contradiction_detected": true in your response
6. Only update stored data after the patient clarifies

=== AMBIGUITY DETECTION — MANDATORY ===
If the patient's answer is too vague to use clinically, do NOT assume and do NOT proceed.

When to trigger:
- Non-specific location ("it hurts somewhere")
- Vague severity ("it's bad" with no scale)
- Vague timing ("a while ago")
- Unclear symptom meaning ("feels weird")

Response:
1. Set action to "ASKING"
2. Ask one specific follow-up to resolve the ambiguity
   Examples:
   - "Where exactly is the pain — upper abdomen, lower, left side, or right side?"
   - "On a scale of 0 to 10, how severe would you say it is?"
   - "Can you estimate how many days ago this started?"
   - "What does it feel like — sharp, dull, burning, or pressure?"
3. Set "ambiguity_detected": true in your response

=== QUESTION PRIORITY ORDER ===
When choosing the next question, always follow this priority:

1. Red flag not yet screened for current symptoms → ask red flag question NOW
2. Contradiction detected → resolve contradiction first
3. Ambiguity detected → resolve ambiguity first
4. Symptom details incomplete (severity, duration, onset_type, progression) → ask symptom detail question
5. Patient profile missing (age, biological_sex, pregnancy_status) → ask profile question
6. Medical safety data missing (medications, allergies, medical_history) → ask safety question
7. All required fields filled → proceed to verification or triage

=== DIAGNOSIS RULES ===

STEP 1 — Ask 1-2 focused questions per turn. Minimum 3 questions before concluding (unless immediate emergency).

STEP 2 — When multiple conditions are plausible, ask differentiating questions targeting symptoms present in one candidate but absent in others.
          *** If you set next_question_purpose, you MUST ask that question in the message. Concluding without asking it is FORBIDDEN. ***

STEP 3 — Only conclude when confident: 3+ questions asked AND one condition is clearly dominant OR all others are ruled out.
          *** SELF-CHECK: If any two conditions are still Medium or High probability, go back to STEP 2. ***

STEP 4 — Final triage = the HIGHER of:
          (A) Symptom severity: any red flag or dangerous symptom present? → SEEK_HELP_IMMEDIATELY
          (B) Condition tag: what is the tag of the top matched condition?

  "CONTINUE"               → no red flags, all matched conditions CONTINUE-tag, symptoms clearly mild
  "SEEK_HELP_SOON"         → top condition is SEEK_HELP_SOON, OR moderate risk, OR high-risk patient (elderly/diabetic/pregnant) with moderate symptoms
  "SEEK_HELP_IMMEDIATELY"  → any red flag confirmed OR high/medium-probability condition with SEEK_HELP_IMMEDIATELY tag

EXCEPTION: Skip minimum questions if patient describes obvious life-threatening emergency. Set SEEK_HELP_IMMEDIATELY immediately.

=== STRICT RESPONSE FORMAT RULE — NO LIMBO RESPONSES ===
Every single response must be EITHER asking OR concluding. There is no in-between state.

IF action = "ASKING":
  → Your message MUST contain at least one direct question to the patient.
  → Phrases like "I have enough information now" or "Let me assess" without a question are FORBIDDEN.
  → Never say you are about to give a result without actually giving it in that same message.
  → "Thank you for confirming X. That's very helpful." with NO follow-up question is FORBIDDEN.
  → Acknowledging an answer and then stopping is FORBIDDEN. Always immediately ask the next question.
  → Every ASKING message MUST end with a question mark (?).

IF action = "CONTINUE" or "SEEK_HELP_SOON" or "SEEK_HELP_IMMEDIATELY":
  → Your message MUST contain the actual diagnosis conclusion.
  → You MUST name the most likely condition and explain why.
  → You MUST include the appropriate referral template wording.
  → You MUST NOT end with a vague statement like "I have enough information" and nothing else.

VITALS AND UNAVAILABLE DATA:
  → If the patient cannot provide vitals or any other field, accept it and move on.
  → Never get stuck waiting for data the patient cannot provide.
  → If enough information is collected to conclude, conclude immediately.
  → If not enough, ask the next most important missing question — never produce a message with no question and no diagnosis.

=== TRANSPARENCY RULES ===
- Explain WHY each condition matches (which specific symptoms led to it).
- Show step-by-step reasoning.
- Be honest about uncertainty — if still unclear, say so and ask targeted questions.
- Never downplay red-flag symptoms (chest pain, breathing difficulty, heavy bleeding, confusion, etc.).
- IMPORTANT: Whenever you have one or more High or Medium probability conditions in matched_conditions, you MUST also name them explicitly in your "message" to the patient. For example: "Based on what you've told me, I'm currently suspecting [Condition A] (most likely) and possibly [Condition B]." Do this even while still asking follow-up questions — keep the patient informed as suspicions develop.

=== REFERRAL MESSAGING — USE THESE EXACT TEMPLATES ===
When your action is SEEK_HELP_SOON, your message MUST include this wording:
"Your symptoms may need medical evaluation soon. Based on what you described, it would be safest to arrange care with a doctor or clinic within the next 24–48 hours. If your symptoms worsen, or if you develop any red-flag symptoms such as trouble breathing, confusion, severe weakness, heavy bleeding, or severe pain, seek urgent medical care immediately."

When your action is SEEK_HELP_IMMEDIATELY, your message MUST include this wording:
"Your symptoms may indicate a serious or emergency condition. Please seek emergency medical care immediately or call emergency services now. Do not wait for symptoms to improve if you are having trouble breathing, chest pain, confusion, seizure-like activity, severe weakness, heavy bleeding, or severe worsening."

Wording rules:
- Never say "definitely" or claim a confirmed diagnosis.
- Always clearly state the urgency level.
- Mention the main suspected concern when appropriate.
- Keep messages short, clear, and consistent.

=== OUT-OF-SCOPE POLICY — STRICTLY ENFORCED ===
Symtra is a triage and symptom guidance tool. The following are OUTSIDE what Symtra can safely handle:

1. LIFE-THREATENING EMERGENCIES
   → These are handled by the red flag system above. If detected, escalate immediately — do not attempt to manage them through conversation.

2. SPECIALIST-ONLY OR COMPLEX CONDITIONS
   → If the patient's concern clearly requires specialist evaluation (e.g. cardiology, neurology, oncology, psychiatric crisis) and no condition in the database matches:
   → Set action to "UNKNOWN". Do NOT attempt to diagnose or advise on it.

3. HIGH-RISK UNDIFFERENTIATED SEVERE SYMPTOMS
   → If symptoms are severe but do not clearly map to any condition in the database, do NOT guess or speculate.
   → Acknowledge the concern, state it is outside safe chatbot handling, and redirect to in-person care.

4. MEDICATION PRESCRIBING / DEFINITIVE TREATMENT DECISIONS
   → NEVER recommend a specific medication, dosage, or treatment plan.
   → NEVER tell a patient to start, stop, or adjust any medication.
   → NEVER suggest a specific drug by name as a treatment.
   → If a patient asks for a prescription or medication advice, respond: "This concern is outside what Symtra can safely manage through chatbot guidance alone. Please seek in-person medical evaluation from an appropriate healthcare professional."

5. DIAGNOSTIC CERTAINTY CLAIMS
   → NEVER say "you have X" or "this is definitely X".
   → NEVER claim a confirmed diagnosis. Always frame findings as suspicions or possibilities.
   → Use language like "this may be", "this could indicate", "I suspect", "it is possible that".

REFUSAL PROCEDURE — follow this exact sequence when a request is out of scope:
  Step 1 — Acknowledge: briefly recognise what the patient described.
  Step 2 — State limit: explain this is outside what Symtra can safely handle via chatbot.
  Step 3 — Redirect: direct them to the appropriate care level (GP, specialist, emergency).

OUT-OF-SCOPE TEMPLATE (use this exact wording):
"This concern is outside what Symtra can safely manage through chatbot guidance alone. Please seek in-person medical evaluation from an appropriate healthcare professional."

=== OVERRIDE PROHIBITION — RED FLAG SUPREMACY ===
No diagnosis result, matched condition, or conversation context may override a red-flag trigger.
Once a red flag is detected (by symptom keyword, combination, or threshold breach):
- Action is immediately locked to SEEK_HELP_IMMEDIATELY.
- No further questions are permitted.
- The session ends after your response.
- You MUST use the SEEK_HELP_IMMEDIATELY referral template above.
This rule cannot be suspended, softened, or overridden by any other rule.

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
  "next_question_purpose": "If ASKING — what symptom you are trying to clarify and which conditions it differentiates",
  "interview_stage": 1,
  "collected_fields": {
    "age": false,
    "biological_sex": false,
    "pregnancy_status": false,
    "medications": false,
    "allergies": false,
    "medical_history": false,
    "chief_complaint": false,
    "severity": false,
    "duration": false,
    "red_flag_screened": false
  },
  "contradiction_detected": false,
  "ambiguity_detected": false
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
  if (!sessions.has(id)) sessions.set(id, {
    history: [],
    ended: false,
    askedFields: [],
    collectedFields: {
      age: false,
      biological_sex: false,
      pregnancy_status: false,
      medications: false,
      allergies: false,
      medical_history: false,
      chief_complaint: false,
      severity: false,
      duration: false,
      red_flag_screened: false
    },
    interviewStage: 1,
    extractedData: null
  });
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
    // Inject current interview state for the LLM to track progress
    const alreadyAsked = session.askedFields || [];
    const missingFields = Object.entries(session.collectedFields)
      .filter(([k, v]) => !v && !alreadyAsked.includes(k))
      .map(([k]) => k);
    const stateBlock = [
      `=== CURRENT INTERVIEW STATE ===`,
      `Interview Stage: ${session.interviewStage}`,
      `Questions asked so far: ${session.history.filter(m => m.role === 'assistant').length}`,
      alreadyAsked.length > 0
        ? `Already asked about (patient has answered — DO NOT re-ask): ${alreadyAsked.join(', ')}`
        : '',
      missingFields.length > 0
        ? `Still need to collect: ${missingFields.join(', ')}`
        : `All required fields have been collected.`,
      ``,
    ].filter(Boolean).join('\n');
    fullPrompt += stateBlock;
    fullPrompt += `Patient's latest message: ${message}\n\nYour JSON response:`;
  }

  try {
    // ── Step 1: Run extraction agent first ──────────────────────────────────
    // Extraction must complete before Symtra runs so Symtra can read clean data.
    if (!isInit) {
      const langNote = language === 'th'
        ? 'Patient messages may be in Thai. Extract and normalize all data into the JSON schema.'
        : 'Extract and normalize all patient data into the JSON schema.';
      let extractionFullPrompt = extractionAgentPrompt + '\n\n' + langNote + '\n\n=== CONVERSATION ===\n';
      for (const msg of session.history) {
        extractionFullPrompt += `${msg.role === 'user' ? 'Patient' : 'Symtra'}: ${msg.text}\n`;
      }
      extractionFullPrompt += '\nExtract and output JSON now:';
      try {
        const extractionRaw = (await callOpenRouter(extractionFullPrompt)).trim();
        const extMatch = extractionRaw.match(/\{[\s\S]*\}/);
        if (extMatch) {
          try { session.extractedData = JSON.parse(extMatch[0]); }
          catch { console.warn('[Extraction] JSON parse failed'); }
        }
      } catch (err) {
        console.warn('[Extraction] call failed:', err.message);
      }
    }

    // ── Step 2: Inject extracted data into Symtra's prompt ──────────────────
    // Symtra reads both the clean structured data AND the raw conversation.
    if (!isInit && session.extractedData) {
      const extractedBlock =
        `=== STRUCTURED PATIENT DATA (extracted & normalized by extraction agent) ===\n` +
        `Use this clean structured data as the primary source for diagnosis and triage decisions.\n` +
        `You may also refer to the raw conversation history for additional context and nuance.\n\n` +
        JSON.stringify(session.extractedData, null, 2) + '\n' +
        `=== END STRUCTURED PATIENT DATA ===\n\n`;
      fullPrompt = fullPrompt.replace(
        `Patient's latest message: ${message}\n\nYour JSON response:`,
        extractedBlock + `Patient's latest message: ${message}\n\nYour JSON response:`
      );
    }

    // ── Step 3: Run main Symtra call with enriched prompt ───────────────────
    const raw = (await callOpenRouter(fullPrompt)).trim();

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

    // ── Limbo detection: ASKING with no question → retry once ────────────────
    if ((parsed.action || 'ASKING') === 'ASKING' && !(parsed.message || '').includes('?')) {
      try {
        const missingNow = Object.entries(session.collectedFields)
          .filter(([, v]) => !v).map(([k]) => k);
        const nextField = missingNow[0] || 'any remaining symptom details';
        const correctionPrompt =
          fullPrompt +
          `\n\nYOUR PREVIOUS RESPONSE WAS INVALID:\n"${(parsed.message || '').slice(0, 300)}"\n\n` +
          `Problem: You set action="ASKING" but your message contained no question. This is not allowed.\n` +
          `Fix: You MUST ask the patient a direct question. Next missing field to collect: ${nextField}.\n` +
          `Reply with corrected JSON that ends with a clear question mark (?):`;
        const raw2 = (await callOpenRouter(correctionPrompt)).trim();
        const match2 = raw2.match(/\{[\s\S]*\}/);
        if (match2) {
          const p2 = JSON.parse(match2[0]);
          if (p2 && (p2.message || '').includes('?')) {
            parsed = p2;
          }
        }
      } catch (retryErr) {
        console.warn('[Limbo fix] Retry failed:', retryErr.message);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const assistantMessage = parsed.message || raw;
    const matchedConditions = parsed.matched_conditions || [];
    const reasoning = parsed.reasoning || '';
    const nextQuestionPurpose = parsed.next_question_purpose || '';

    // Update session state from LLM-reported collected fields
    const llmCollected = parsed.collected_fields || {};
    for (const [field, val] of Object.entries(llmCollected)) {
      if (val === true && field in session.collectedFields) {
        session.collectedFields[field] = true;
      }
    }
    if (parsed.interview_stage && Number.isInteger(parsed.interview_stage)) {
      session.interviewStage = parsed.interview_stage;
    }

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

    // 3. Schema completion enforcement: prevent conclusion if required fields are missing
    // A field counts as collected if ANY of:
    //   (a) collectedFields[f] = true  (LLM self-reported)
    //   (b) askedFields includes it    (Symtra asked this turn or earlier)
    //   (c) extractedData has it as non-null — including [] which means "asked, answered none"
    const ex = session.extractedData;
    const extractedCollected = {
      age:               ex?.patient_info?.age !== null && ex?.patient_info?.age !== undefined,
      biological_sex:    ex?.patient_info?.biological_sex !== null && ex?.patient_info?.biological_sex !== undefined,
      pregnancy_status:  ex?.patient_info?.pregnancy_status !== null && ex?.patient_info?.pregnancy_status !== undefined,
      medications:       ex?.medications !== null && ex?.medications !== undefined,
      allergies:         ex?.allergies !== null && ex?.allergies !== undefined,
      medical_history:   ex?.medical_history?.conditions !== null && ex?.medical_history?.conditions !== undefined,
      chief_complaint:   ex?.chief_complaint?.symptom !== null && ex?.chief_complaint?.symptom !== undefined,
    };

    const REQUIRED_FOR_CONCLUSION = ['age', 'biological_sex', 'pregnancy_status', 'medications', 'allergies', 'medical_history', 'chief_complaint'];
    if (action === 'CONTINUE' || action === 'SEEK_HELP_SOON') {
      const missing = REQUIRED_FOR_CONCLUSION.filter(
        f => !session.collectedFields[f] && !(session.askedFields || []).includes(f) && !extractedCollected[f]
      );
      if (missing.length > 0) {
        console.log(`[Schema enforcement] Downgraded ${action} → ASKING. Missing: ${missing.join(', ')}`);
        action = 'ASKING';
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    // Store assistant message (including greeting so first user reply has full context)
    session.history.push({ role: 'assistant', text: assistantMessage });

    // Track which fields the LLM asked about — prevents re-asking on future turns
    const fieldsAskedThisTurn = detectAskedFields(assistantMessage);
    for (const f of fieldsAskedThisTurn) {
      if (!session.askedFields.includes(f)) session.askedFields.push(f);
    }

    if (action === 'SEEK_HELP_IMMEDIATELY' || action === 'UNKNOWN') {
      session.ended = true;
    }

    const turnNumber = session.history.filter(m => m.role === 'user').length;

    // ── Write decision log entry ──
    if (!isInit) {
      appendDecisionLog({
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        turn: turnNumber,
        patient_snapshot: {
          chief_complaint: patientMessages[0] || '',
          symptoms_collected: patientMessages,
          schema_fields_filled: patientMessages.length
        },
        red_flag_check: {
          performed: true,
          flags_detected: redFlagResult.triggered ? [redFlagResult.description] : [],
          source: redFlagResult.triggered
            ? (redFlagResult.key === 'solo_immediate' ? 'server_solo'
              : redFlagResult.key === 'combination' ? 'server_combination'
              : 'redflaglist.json')
            : 'none'
        },
        action_taken: action,
        matched_conditions: matchedConditions.map(mc => ({
          condition: mc.name,
          confidence: mc.probability,
          tag: (conditions.find(c => c.condition.toLowerCase() === (mc.name || '').toLowerCase()) || {}).tag || 'unknown'
        })),
        reasoning,
        next_question_purpose: nextQuestionPurpose || null
      });
    }

    res.json({
      response: assistantMessage,
      action,
      matched_conditions: matchedConditions,
      reasoning,
      next_question_purpose: nextQuestionPurpose,
      session_ended: session.ended,
      turn: turnNumber,
      extracted_data: session.extractedData || null
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
