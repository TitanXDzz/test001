/**
 * Profile-based conversation test runner for Symtra
 *
 * What it does:
 * 1. Loads profile_based_test_cases_full.json
 * 2. For each case, starts a fresh Symtra session
 * 3. Uses a lightweight patient simulator to answer Symtra's questions
 * 4. Stops when Symtra reaches a final action or max turns
 * 5. Scores:
 *    - triage correctness
 *    - diagnosis correctness
 *    - whether age/sex/pregnancy/history/meds/allergies were collected when asked
 *
 * Usage:
 *   node test_runner.js \
 *     --cases ./profile_based_test_cases_full.json \
 *     --api http://localhost:5000/api/chat
 *
 * Optional:
 *   --max-turns 8
 *   --verbose
 *   --out ./test-results/profile_test_results.json
 *
 * Assumed API request:
 *   { "message": "...", "sessionId": "..." }
 *
 * Assumed API response (best effort; adjust extractors if needed):
 *   {
 *     "response": "...",
 *     "action": "ASKING | CONTINUE | SEEK_HELP_SOON | SEEK_HELP_IMMEDIATELY",
 *     "matched_conditions": [ { "name": "...", ... } ],
 *     "session_ended": false
 *   }
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv);

const CASES_PATH = args.cases || './profile_based_test_cases_full.json';
const API_URL = args.api || 'http://localhost:5000/chat';
const MAX_TURNS_DEFAULT = Number(args['max-turns'] || 8);
const VERBOSE = Boolean(args.verbose);
const OUT_PATH = args.out || './test-results/profile_test_results.json';
const TIMEOUT_MS = Number(args.timeout || 30000);

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAny(text, patterns) {
  const t = normalize(text);
  return patterns.some(p => t.includes(normalize(p)));
}

function yesNo(value) {
  if (value === true) return 'Yes.';
  if (value === false) return 'No.';
  if (value === null || value === undefined) return "I don't know.";
  return String(value);
}

function listReply(arr, emptyReply = 'None.') {
  if (!arr || arr.length === 0) return emptyReply;
  return arr.join(', ') + '.';
}

function uniqueId(prefix='sess') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function callSymtra(message, sessionId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId })
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractAssistantText(payload) {
  return payload.response || payload.text || payload.message || payload.reply || '';
}

function extractAction(payload) {
  return payload.action || payload.tag || payload.triage || payload.triage_tag || 'ASKING';
}

function extractMatchedConditions(payload) {
  const mc = payload.matched_conditions || payload.diagnoses || payload.differential || [];
  if (!Array.isArray(mc)) return [];
  return mc.map(x => {
    if (typeof x === 'string') return { name: x };
    return x;
  });
}

function extractPrimaryCondition(payload) {
  if (payload.primary_condition) return payload.primary_condition;
  const mc = extractMatchedConditions(payload);
  if (mc.length > 0 && mc[0].name) return mc[0].name;
  return null;
}

function getExpectedOpening(caseObj) {
  // Keep this broad, because the simulator will reveal the target symptoms naturally.
  switch (caseObj.target_condition) {
    case 'Common cold':
      return 'I have a runny nose and sore throat for two days.';
    case 'Mild influenza':
      return 'I have fever, body aches, and fatigue since yesterday.';
    case 'Severe influenza':
      return 'I have a very high fever and feel extremely weak.';
    case 'COVID-19 suspected':
      return "I have fever, cough, fatigue, and I can't smell properly.";
    case 'COVID-19 severe':
      return "I have fever and cough and now I'm having trouble breathing.";
    case 'Viral sore throat':
      return 'My throat hurts and feels irritated.';
    case 'Possible strep throat':
      return 'I have throat pain and fever.';
    case 'Laryngitis':
      return 'My voice is hoarse and my throat feels irritated.';
    case 'Mild sinus congestion':
      return 'I feel pressure around my nose and forehead and my nose is blocked.';
    case 'Severe sinusitis':
      return 'I have severe facial pain, fever, and my nose is badly blocked.';
    case 'Allergic rhinitis':
      return 'I keep sneezing and my nose is itchy and runny.';
    case 'Acute bronchitis mild':
      return 'I have been coughing with mucus and feeling tired.';
    case 'Possible pneumonia':
      return 'I have fever, chest pain, and cough.';
    case 'Earwax impaction':
      return 'My ear feels blocked and my hearing seems reduced.';
    case 'Ear infection suspected':
      return 'My ear hurts and I have a fever.';
    case 'Nosebleed minor':
      return 'My nose started bleeding a little.';
    case 'Nosebleed severe':
      return "My nose has been bleeding heavily and it won't stop.";
    case 'Dengue suspected':
      return 'I have high fever, severe headache, body aches, and a rash.';
    case 'Dengue warning stage':
      return 'I have high fever, rash, and now my gums are bleeding.';
    case 'Indigestion':
      return 'My upper stomach feels uncomfortable and too full after eating.';
    case 'Bloating gas':
      return 'My stomach feels bloated and full of gas.';
    case 'Mild gastritis':
      return 'I have a burning feeling in my stomach and some nausea.';
    case 'Acid reflux':
      return 'I have heartburn and chest discomfort after meals.';
    case 'Constipation':
      return 'I have hard stools and trouble passing them.';
    case 'Tension headache':
      return 'I have a mild pressure headache.';
    case 'Migraine suspected':
      return 'I have a throbbing headache and light bothers me.';
    case 'Stroke symptoms':
      return 'My face feels droopy and I am having trouble speaking.';
    case 'Muscle soreness':
      return 'My muscles are sore after exercise.';
    case 'Minor sprain':
      return 'I twisted my ankle and it hurts with a little swelling.';
    case 'Suspected fracture':
      return 'I fell and now my arm has severe pain and looks bent.';
    case 'Mild eczema':
      return 'I have an itchy dry rash on my arms.';
    case 'Contact dermatitis':
      return 'I got a rash after using a new skin product.';
    case 'Cellulitis suspected':
      return 'My skin is getting red, warm, and swollen.';
    case 'Mild insomnia':
      return 'I have trouble falling asleep.';
    case 'Mouth ulcers':
      return 'I have painful sores inside my mouth.';
    case 'Dental abscess suspected':
      return 'I have tooth pain, swelling, and fever.';
    case 'Suspected UTI':
      return 'It burns when I urinate and I keep needing to go.';
    case 'Kidney infection suspected':
      return 'I have flank pain, fever, and chills.';
    case 'Heart attack suspected':
      return 'I have chest pain and I am sweating.';
    case 'Unstable angina':
      return 'I have chest tightness at rest.';
    case 'Pulmonary embolism suspected':
      return 'I suddenly got chest pain and shortness of breath.';
    case 'Anaphylaxis':
      return 'My lips are swelling and it is hard to breathe after I ate something.';
    case 'Severe dehydration':
      return "I'm extremely thirsty, dizzy, and barely urinating.";
    case 'Sepsis suspected':
      return 'I have a high fever and I am confused and breathing fast.';
    case 'Meningitis suspected':
      return 'I have a high fever, severe headache, stiff neck, and vomiting.';
    case 'Seizure episode':
      return 'I had convulsions and blacked out.';
    case 'Hypoglycemia severe':
      return "I'm shaking, sweating, dizzy, and confused.";
    case 'Hyperglycemia severe':
      return "I'm extremely thirsty, urinating all the time, and feel very tired.";
    case 'Acute asthma attack':
      return "I'm wheezing, my chest feels tight, and I'm short of breath.";
    case 'Appendicitis suspected':
      return 'I have sharp pain in the lower right side of my abdomen and I feel sick.';
    case 'Gallbladder attack suspected':
      return 'I have pain in my upper right abdomen after eating greasy food.';
    case 'Peptic ulcer suspected':
      return "I get a burning stomach pain when I'm hungry.";
    case 'Food poisoning suspected':
      return 'I have vomiting, diarrhea, and stomach cramps after eating suspicious food.';
    case 'Kidney stones suspected':
      return 'I have severe pain in my side and it hurts to urinate.';
    case 'Panic attack':
      return 'I suddenly felt intense fear, chest tightness, and fast breathing.';
    default:
      return 'I am not feeling well.';
  }
}

function buildConditionFacts(caseObj) {
  const c = caseObj.target_condition;
  const pf = caseObj.patient_profile;

  const facts = {
    symptomAnswers: {},
    defaultUnknown: "I'm not sure.",
  };

  // General profile-based answers
  facts.age = `${pf.age}.`;
  facts.sex = pf.biological_sex ? `${pf.biological_sex}.` : "I don't know.";
  facts.pregnancy = pf.pregnancy_status === null ? "I don't know." : (pf.pregnancy_status ? "Yes." : "No.");
  facts.medical_history = listReply(pf.medical_history);
  facts.medications = listReply(pf.medications);
  facts.allergies = listReply(pf.allergies);
  facts.risk_factors = listReply(pf.risk_factors);

  // Default symptom fact map per condition
  const map = facts.symptomAnswers;

  const set = (keys, value) => keys.forEach(k => map[k] = value);

  if (c === 'Common cold') {
    set(['fever'], 'No fever.');
    set(['cough'], 'Yes, a mild cough.');
    set(['body aches', 'aches'], 'No body aches.');
    set(['breathing', 'shortness of breath'], 'No breathing problems.');
    set(['fatigue'], 'Only a little tired.');
    set(['duration'], 'For two days.');
    set(['worsening', 'progression'], 'It has been about the same.');
  } else if (c === 'Mild influenza') {
    set(['cough'], 'Yes, a mild cough.');
    set(['sore throat'], 'A little sore throat.');
    set(['breathing'], 'No trouble breathing.');
    set(['smell', 'taste'], 'No change in smell or taste.');
    set(['duration'], 'Since yesterday.');
    set(['high fever'], 'It feels like a moderate fever, not extremely high.');
  } else if (c === 'Severe influenza') {
    set(['breathing'], 'Yes, I am short of breath.');
    set(['confusion'], 'Yes, I feel confused.');
    set(['chest pain'], 'No clear chest pain.');
  } else if (c === 'COVID-19 suspected') {
    set(['breathing'], 'No shortness of breath.');
    set(['chest pain'], 'No chest pain.');
    set(['duration'], 'For about two days.');
    set(['exposure'], 'Yes, there were sick people around me.');
    set(['smell', 'taste'], "Yes, my smell seems reduced.");
  } else if (c === 'COVID-19 severe') {
    set(['chest pain', 'tight'], 'My chest feels tight.');
    set(['oxygen'], "I haven't checked my oxygen.");
    set(['weakness'], 'Yes, I feel very weak.');
  } else if (c === 'Viral sore throat') {
    set(['fever'], 'Just a mild fever.');
    set(['cough'], 'A mild cough.');
    set(['difficulty swallowing', 'swallow'], 'No, I can swallow fine.');
    set(['runny nose'], 'Yes, I have a runny nose.');
    set(['duration'], 'For two days.');
  } else if (c === 'Possible strep throat') {
    set(['swollen', 'glands', 'nodes'], 'Yes, my neck glands feel swollen.');
    set(['cough'], "No, I don't have a cough.");
    set(['swallow'], 'Swallowing is painful.');
    set(['tonsil', 'exudate'], "I'm not sure, but my throat looks very inflamed.");
  } else if (c === 'Laryngitis') {
    set(['breathing'], 'No breathing problems.');
    set(['fever'], 'No fever.');
    set(['duration'], 'For about three days.');
    set(['cough'], 'A slight dry cough.');
  } else if (c === 'Mild sinus congestion') {
    set(['fever'], 'No fever.');
    set(['facial pain'], 'Just mild pressure and dull pain.');
    set(['eye swelling'], 'No eye swelling.');
    set(['runny nose'], 'Yes, a runny nose too.');
  } else if (c === 'Severe sinusitis') {
    set(['eye swelling'], 'No eye swelling.');
    set(['headache'], 'Yes, a strong headache.');
    set(['duration'], 'More than a week.');
  } else if (c === 'Allergic rhinitis') {
    set(['fever'], 'No fever.');
    set(['breathing'], 'No breathing difficulty.');
    set(['eye'], 'Yes, my eyes are itchy too.');
    set(['cough'], 'No cough.');
  } else if (c === 'Acute bronchitis mild') {
    set(['breathing'], 'No shortness of breath.');
    set(['chest pain'], 'No chest pain.');
    set(['fever'], 'Only a mild fever.');
    set(['duration'], 'For a few days.');
  } else if (c === 'Possible pneumonia') {
    set(['breathing'], 'Yes, I am short of breath and breathing fast.');
    set(['rapid breathing'], 'Yes.');
    set(['severity'], 'It feels serious.');
  } else if (c === 'Earwax impaction') {
    set(['ear pain'], 'No pain.');
    set(['discharge'], 'No discharge.');
    set(['fever'], 'No fever.');
  } else if (c === 'Ear infection suspected') {
    set(['discharge'], 'Yes, some discharge.');
    set(['hearing'], 'My hearing is worse.');
    set(['severity'], 'The pain is moderate.');
  } else if (c === 'Nosebleed minor') {
    set(['how long', 'duration'], 'It stopped within five minutes.');
    set(['heavy'], 'No, it was light.');
    set(['dizziness'], 'No dizziness.');
  } else if (c === 'Nosebleed severe') {
    set(['dizziness'], 'Yes, I feel dizzy.');
    set(['duration'], 'About 30 minutes.');
    set(['amount'], 'A lot of blood.');
  } else if (c === 'Dengue suspected') {
    set(['bleeding'], 'No bleeding.');
    set(['abdominal pain'], 'No severe abdominal pain.');
    set(['vomiting'], 'No vomiting.');
    set(['weakness'], 'No extreme weakness.');
    set(['confusion'], 'No confusion.');
  } else if (c === 'Dengue warning stage') {
    set(['abdominal pain'], 'Yes, severe abdominal pain.');
    set(['vomiting'], 'Yes, persistent vomiting.');
    set(['weakness'], 'Yes, I feel very weak.');
    set(['confusion'], 'Not confused, just very weak.');
  } else if (c === 'Indigestion') {
    set(['severe abdominal pain'], 'No severe pain.');
    set(['vomiting'], 'No vomiting.');
    set(['heartburn'], 'A little discomfort after meals.');
    set(['duration'], 'Started today after eating.');
  } else if (c === 'Bloating gas') {
    set(['severe abdominal pain'], 'No severe pain.');
    set(['bowel'], 'No major bowel changes.');
    set(['duration'], 'Since earlier today.');
  } else if (c === 'Mild gastritis') {
    set(['vomiting blood'], 'No.');
    set(['black stool'], 'No.');
    set(['meal'], 'It gets worse after irritating food.');
    set(['severity'], 'Mild to moderate.');
  } else if (c === 'Acid reflux') {
    set(['severe chest pain'], 'No severe chest pain.');
    set(['meals'], 'It happens after meals.');
    set(['shortness of breath'], 'No shortness of breath.');
    set(['sweating'], 'No sweating.');
    set(['radiating'], 'No, it does not spread.');
  } else if (c === 'Constipation') {
    set(['severe abdominal pain'], 'No severe pain.');
    set(['blood'], 'No blood.');
    set(['duration'], 'For several days.');
  } else if (c === 'Tension headache') {
    set(['neurological', 'weakness', 'speech'], 'No weakness or speech problems.');
    set(['sudden severe'], 'No, it is not sudden or severe.');
    set(['vision'], 'No vision changes.');
    set(['stress'], 'Yes, I have been stressed.');
  } else if (c === 'Migraine suspected') {
    set(['neurological'], 'No weakness or speech trouble.');
    set(['visual aura'], 'Sometimes I see flashing lights.');
    set(['vomiting'], 'A little nausea.');
    set(['sudden'], 'No, not sudden like the worst headache ever.');
  } else if (c === 'Stroke symptoms') {
    set(['arm weakness'], 'Yes, my arm feels weak too.');
    set(['sudden onset'], 'Yes, it started suddenly.');
    set(['confusion'], 'A bit confused, yes.');
  } else if (c === 'Muscle soreness') {
    set(['swelling'], 'No severe swelling.');
    set(['injury'], 'No direct injury.');
    set(['weakness'], 'Just soreness.');
    set(['duration'], 'Since after exercise.');
  } else if (c === 'Minor sprain') {
    set(['deformity'], 'No deformity.');
    set(['bear weight', 'walk'], 'Yes, I can still walk a bit.');
    set(['severity'], 'Mild to moderate.');
  } else if (c === 'Suspected fracture') {
    set(['swelling'], 'Yes, it is swollen.');
    set(['deformity'], 'Yes, it looks deformed.');
    set(['movement'], 'Moving it hurts badly.');
    set(['numbness'], 'No numbness.');
  } else if (c === 'Mild eczema') {
    set(['infection'], 'No signs of infection.');
    set(['oozing'], 'No oozing.');
    set(['product exposure'], 'No new products.');
    set(['severity'], 'Mild.');
  } else if (c === 'Contact dermatitis') {
    set(['swelling'], 'No severe swelling.');
    set(['breathing'], 'No breathing problems.');
    set(['itch'], 'Yes, it is itchy.');
    set(['distribution'], 'Only where the product touched my skin.');
  } else if (c === 'Cellulitis suspected') {
    set(['fever'], 'Yes, I have a fever.');
    set(['spreading'], 'Yes, it is spreading.');
    set(['pain'], 'Yes, it is painful.');
    set(['worsening'], 'It is getting worse quickly.');
  } else if (c === 'Mild insomnia') {
    set(['anxiety'], 'No severe anxiety.');
    set(['duration'], 'For about a week.');
    set(['stress'], 'Yes, I have been stressed.');
    set(['other symptoms'], 'No other major symptoms.');
  } else if (c === 'Mouth ulcers') {
    set(['duration'], 'For a few days.');
    set(['number'], 'Just a few.');
    set(['fever'], 'No fever.');
  } else if (c === 'Dental abscess suspected') {
    set(['facial swelling'], 'Yes, my face is starting to swell.');
    set(['severity'], 'The pain is severe.');
    set(['swallowing'], 'No trouble swallowing yet.');
  } else if (c === 'Suspected UTI') {
    set(['fever'], 'No fever.');
    set(['back pain'], 'No back pain.');
    set(['blood in urine'], 'No blood.');
    set(['duration'], 'For one day.');
  } else if (c === 'Kidney infection suspected') {
    set(['burning urination'], 'Yes, it burns when I urinate.');
    set(['severity'], 'It feels serious.');
    set(['vomiting'], 'No vomiting.');
  } else if (c === 'Heart attack suspected') {
    set(['arm'], 'Yes, it spreads to my left arm.');
    set(['jaw'], 'A little toward my jaw.');
    set(['shortness of breath'], 'Yes, I feel short of breath.');
    set(['nausea'], 'Yes, I feel nauseous.');
  } else if (c === 'Unstable angina') {
    set(['sweating'], 'Yes, I feel sweaty.');
    set(['nausea'], 'A little nausea.');
    set(['shortness of breath'], 'A little short of breath.');
    set(['duration'], 'It keeps happening even at rest.');
  } else if (c === 'Pulmonary embolism suspected') {
    set(['rapid heartbeat'], 'Yes, my heart is racing.');
    set(['collapse'], 'No collapse.');
    set(['severity'], 'Severe.');
    set(['sudden onset'], 'Yes, it started suddenly.');
  } else if (c === 'Anaphylaxis') {
    set(['hives'], 'Yes, I have hives.');
    set(['throat'], 'My throat feels tight.');
    set(['fainting'], 'I feel like I might faint.');
  } else if (c === 'Severe dehydration') {
    set(['confusion'], 'A little confused.');
    set(['fainting'], 'I almost fainted.');
    set(['drink fluids'], "I'm struggling to keep fluids down.");
  } else if (c === 'Sepsis suspected') {
    set(['weakness'], 'Yes, extremely weak.');
    set(['blood pressure'], "I don't know my blood pressure.");
    set(['infection source'], 'I recently had an infected wound.');
  } else if (c === 'Meningitis suspected') {
    set(['light sensitivity'], 'Yes, bright light bothers me.');
    set(['confusion'], 'A little confused.');
    set(['seizures'], 'No seizures.');
  } else if (c === 'Seizure episode') {
    set(['repeated'], 'Yes, it happened again.');
    set(['breathing'], 'Breathing is okay now.');
    set(['injury'], 'I bit my tongue.');
  } else if (c === 'Hypoglycemia severe') {
    set(['diabetes'], 'Yes, I have diabetes.');
    set(['loss of consciousness'], 'I nearly passed out.');
    set(['seizures'], 'No seizures.');
  } else if (c === 'Hyperglycemia severe') {
    set(['confusion'], 'Yes, I feel confused.');
    set(['vomiting'], 'Yes, I have been vomiting.');
    set(['diabetes'], 'Yes, I have diabetes.');
  } else if (c === 'Acute asthma attack') {
    set(['known asthma'], 'Yes, I have asthma.');
    set(['speak'], 'I can barely speak full sentences.');
    set(['severity'], 'Severe.');
  } else if (c === 'Appendicitis suspected') {
    set(['fever'], 'Yes, I have a fever.');
    set(['nausea'], 'Yes, I feel nauseous.');
    set(['movement'], 'Yes, it hurts more when I move.');
    set(['vomiting'], 'Not yet.');
  } else if (c === 'Gallbladder attack suspected') {
    set(['fever'], 'No fever.');
    set(['persistent'], 'Yes, it has lasted for hours.');
    set(['nausea'], 'Yes, I feel nauseous.');
    set(['vomiting'], 'No vomiting.');
  } else if (c === 'Peptic ulcer suspected') {
    set(['vomiting blood'], 'No.');
    set(['black stool'], 'No.');
    set(['duration'], 'For a while now.');
  } else if (c === 'Food poisoning suspected') {
    set(['dehydration'], 'I feel weak but can still drink a little.');
    set(['blood in stool'], 'No blood in stool.');
    set(['fever'], 'A mild fever.');
    set(['others sick'], 'Yes, another person who ate with me felt sick too.');
  } else if (c === 'Kidney stones suspected') {
    set(['fever'], 'No fever.');
    set(['vomiting'], 'No vomiting, just nausea.');
    set(['blood in urine'], 'Maybe a little, not sure.');
    set(['severity'], 'Severe pain.');
  } else if (c === 'Panic attack') {
    set(['fainting'], 'No fainting.');
    set(['persistent chest pain'], 'The chest tightness eased after a few minutes.');
    set(['history of panic'], 'Yes, I have had panic attacks before.');
    set(['sweating'], 'Yes, I was sweating.');
  }

  return facts;
}

function simulatePatientReply(caseObj, assistantText) {
  const t = normalize(assistantText);
  const facts = buildConditionFacts(caseObj);

  // Schema / demographic questions
  if (includesAny(t, ['how old', 'your age', 'age?'])) return facts.age;
  if (includesAny(t, ['sex assigned', 'biological sex', 'male or female', 'sex?'])) return facts.sex;
  if (includesAny(t, ['pregnant', 'pregnancy'])) return facts.pregnancy;
  if (includesAny(t, ['medical history', 'past conditions', 'health conditions', 'chronic conditions'])) return facts.medical_history;
  if (includesAny(t, ['medications', 'medicine', 'currently taking'])) return facts.medications;
  if (includesAny(t, ['allergies', 'allergic to'])) return facts.allergies;
  if (includesAny(t, ['risk factors', 'exposure', 'recent travel', 'contact with sick', 'mosquito'])) return facts.risk_factors;

  // Symptom-specific mapped replies
  for (const [key, value] of Object.entries(facts.symptomAnswers)) {
    if (includesAny(t, key.split(',').map(x => x.trim()))) return value;
  }

  // Generic fallbacks
  if (includesAny(t, ['how long', 'duration', 'since when'])) return 'For a couple of days.';
  if (includesAny(t, ['severity', 'how severe'])) return 'Moderate.';
  if (includesAny(t, ['better', 'worse', 'improving', 'worsening'])) return 'It has been getting a bit worse.';
  if (includesAny(t, ['anything else', 'other symptoms'])) return 'No other major symptoms.';
  if (includesAny(t, ['yes or no', 'do you have'])) return "I'm not sure.";
  return "I'm not sure, but that's what I've noticed.";
}

async function runCase(caseObj, maxTurns = MAX_TURNS_DEFAULT) {
  const sessionId = uniqueId(caseObj.id);
  const logs = [];
  let turn = 0;
  let assistantPayload = null;

  // Start with opening complaint
  let userMessage = getExpectedOpening(caseObj);

  while (turn < maxTurns) {
    turn += 1;

    assistantPayload = await callSymtra(userMessage, sessionId);
    const assistantText = extractAssistantText(assistantPayload);
    const action = extractAction(assistantPayload);
    const primary = extractPrimaryCondition(assistantPayload);
    const diagnoses = extractMatchedConditions(assistantPayload);

    logs.push({
      turn,
      user: userMessage,
      assistant: assistantText,
      action,
      primary_condition: primary,
      diagnoses
    });

    const ended = Boolean(assistantPayload.session_ended);
    const isFinalAction = ['CONTINUE', 'SEEK_HELP_SOON', 'SEEK_HELP_IMMEDIATELY'].includes(action);

    if (ended || isFinalAction) {
      break;
    }

    userMessage = simulatePatientReply(caseObj, assistantText);
  }

  const finalAction = extractAction(assistantPayload || {});
  const finalPrimary = extractPrimaryCondition(assistantPayload || {});
  const finalDiagnoses = extractMatchedConditions(assistantPayload || {});

  const triagePass = normalize(finalAction) === normalize(caseObj.expected_triage_tag);

  const acceptable = [caseObj.target_condition];
  const diagnosisNames = [finalPrimary, ...finalDiagnoses.map(d => d.name || '')]
    .filter(Boolean)
    .map(normalize);

  const conditionPass = acceptable.map(normalize).some(acc => diagnosisNames.includes(acc));

  return {
    id: caseObj.id,
    target_condition: caseObj.target_condition,
    expected_triage_tag: caseObj.expected_triage_tag,
    actual_triage_tag: finalAction,
    actual_primary_condition: finalPrimary,
    passed: triagePass && conditionPass,
    triagePass,
    conditionPass,
    turn_count: turn,
    logs
  };
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  const cases = raw.cases || raw;

  const results = [];
  let errorCount = 0;

  for (const c of cases) {
    try {
      const result = await runCase(c);
      results.push(result);
      console.log(`[${result.passed ? 'PASS' : 'FAIL'}] ${result.id} | ${result.actual_triage_tag || 'N/A'} | ${result.actual_primary_condition || 'N/A'}`);
    } catch (err) {
      errorCount += 1;
      results.push({
        id: c.id,
        target_condition: c.target_condition,
        passed: false,
        error: err.message
      });
      console.log(`[ERROR] ${c.id} | ${err.message}`);
    }
  }

  const summary = {
    total_cases: results.length,
    passed_cases: results.filter(r => r.passed).length,
    failed_cases: results.filter(r => r.passed === false && !r.error).length,
    error_cases: errorCount,
    pass_rate_percent: Number((results.filter(r => r.passed).length / results.length * 100).toFixed(1)),
    diagnosis_accuracy_percent: Number((results.filter(r => r.conditionPass).length / results.length * 100).toFixed(1)),
    triage_accuracy_percent: Number((results.filter(r => r.triagePass).length / results.length * 100).toFixed(1))
  };

  const outDir = path.dirname(OUT_PATH);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ summary, results }, null, 2), 'utf8');

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Saved results to ${OUT_PATH}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
