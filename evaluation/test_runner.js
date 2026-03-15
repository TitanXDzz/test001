/**
 * Symtra AI Evaluation — Patient Simulator Mode
 *
 * Uses Gemini AI to simulate a realistic patient that:
 *   - Knows its condition and profile (secret — never revealed directly)
 *   - Answers Symtra's questions naturally and gradually
 *   - Only reveals what is directly asked
 *
 * Usage:
 *   node test_runner.js
 *   node test_runner.js --verbose
 *   node test_runner.js --max-turns 10
 *   node test_runner.js --cases ./profile_based_test_cases_full.json
 *   node test_runner.js --api http://localhost:5000
 *
 * Output:
 *   test-results/eval_results.json   — full per-case results with conversation logs
 *   test-results/eval_summary.json   — summary metrics only
 */

const fs   = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── CLI args ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key  = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) { args[key] = true; }
    else { args[key] = next; i++; }
  }
  return args;
}

const args       = parseArgs(process.argv);
const CASES_PATH = args.cases      || path.resolve(__dirname, 'profile_based_test_cases_full.json');
const BASE_URL   = (args.api       || 'http://localhost:5000').replace(/\/chat$/, '');
const SYMTRA_URL = BASE_URL + '/chat';
const RESET_URL  = BASE_URL + '/reset';
const MAX_TURNS  = Number(args['max-turns'] || 10);
const VERBOSE    = Boolean(args.verbose);
const TIMEOUT_MS = Number(args.timeout || 30000);
const LIMIT      = args.limit ? Number(args.limit) : null;

// ── Load API keys ─────────────────────────────────────────────────────────────
// Start from the middle key to reduce quota collision with the server (which starts at key 0)
const keysDir = path.resolve(__dirname, '../api-keys');
let apiKeys = [];
if (fs.existsSync(keysDir)) {
  apiKeys = fs.readdirSync(keysDir)
    .filter(f => f.endsWith('.txt'))
    .sort()
    .map(f => fs.readFileSync(path.join(keysDir, f), 'utf8').trim())
    .filter(k => k.length > 0);
}
if (apiKeys.length === 0) {
  console.error('ERROR: No API keys found in ../api-keys/');
  process.exit(1);
}
let keyIndex = Math.floor(apiKeys.length / 2);

function getPatientModel(systemPrompt) {
  return new GoogleGenerativeAI(apiKeys[keyIndex])
    .getGenerativeModel(
      { model: 'gemini-2.5-flash', systemInstruction: systemPrompt },
      { apiVersion: 'v1beta' }
    );
}

// ── Patient AI caller with key rotation and backoff ───────────────────────────
async function callPatientAI(systemPrompt, history) {
  let totalAttempts = 0;
  const maxAttempts = apiKeys.length * 4;

  while (totalAttempts < maxAttempts) {
    totalAttempts++;
    try {
      const model  = getPatientModel(systemPrompt);
      const result = await model.generateContent({
        contents: history,
        generationConfig: {
          thinkingConfig: { thinkingBudget: 0 },
          maxOutputTokens: 120
        }
      });
      return result.response.text().trim();
    } catch (err) {
      const isDaily    = err.message.includes('PerDay') || err.message.includes('RESOURCE_EXHAUSTED');
      const isInvalid  = err.message.includes('API_KEY_INVALID') || err.message.includes('key expired') || err.message.includes('key was reported as leaked');
      const isRateLimit = err.message.includes('429');

      if (isInvalid || isDaily) {
        // Skip this key entirely
        if (keyIndex < apiKeys.length - 1) {
          keyIndex++;
          console.log(`[Patient AI] Key ${keyIndex} invalid/exhausted. Switching to key ${keyIndex + 1}/${apiKeys.length}...`);
        } else {
          throw new Error('All patient AI keys are invalid or exhausted.');
        }
      } else if (isRateLimit) {
        // Per-minute rate limit — wait the suggested time then retry same key
        const m    = err.message.match(/retry in (\d+(?:\.\d+)?)s/i);
        const wait = m ? Math.ceil(parseFloat(m[1])) * 1000 + 1000 : 15000;
        console.log(`[Patient AI] Rate limited. Waiting ${wait / 1000}s...`);
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
  throw new Error('Patient AI: exhausted all retry attempts.');
}

// ── Symtra API calls ───────────────────────────────────────────────────────────
async function callSymtra(message, sessionId) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SYMTRA_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message, sessionId }),
      signal:  ctrl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function resetSession(sessionId) {
  try {
    await fetch(RESET_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sessionId })
    });
  } catch { /* best-effort */ }
}

// ── Build patient AI system prompt ────────────────────────────────────────────
function buildPatientPrompt(caseObj) {
  const p = caseObj.patient_profile;

  const profile = [
    `Age: ${p.age}`,
    `Biological sex: ${p.biological_sex || 'not specified'}`,
    `Pregnancy status: ${p.pregnancy_status === null ? 'not applicable' : p.pregnancy_status ? 'yes' : 'no'}`,
    `Medical history: ${p.medical_history?.length  ? p.medical_history.join(', ')  : 'none'}`,
    `Current medications: ${p.medications?.length  ? p.medications.join(', ')      : 'none'}`,
    `Allergies: ${p.allergies?.length              ? p.allergies.join(', ')        : 'none'}`,
    `Risk factors: ${p.risk_factors?.length        ? p.risk_factors.join(', ')     : 'none'}`
  ].join('\n');

  return `You are roleplaying as a patient using a medical symptom checker chatbot called Symtra.

=== YOUR PATIENT PROFILE ===
${profile}

=== YOUR ACTUAL CONDITION (SECRET) ===
You have: ${caseObj.target_condition}
NEVER say this condition name. Never hint at it directly.

=== HOW TO BEHAVE ===
1. Answer ONLY what is directly asked. Do NOT volunteer extra symptoms unprompted.
2. Reveal symptoms GRADUALLY — one or two details at a time, only when Symtra asks.
3. Use plain patient language. Say "my chest hurts" not "I have chest pain radiating to the left arm."
4. Stay fully consistent — never contradict yourself across the conversation.
5. If asked about a symptom you do NOT have, say "No" or "I don't think so."
6. Answer demographic questions (age, sex, medications, history) honestly from your profile.
7. Keep every reply SHORT — 1 to 3 sentences only.
8. You do not know what your diagnosis is. You are just describing how you feel.`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function extractAction(payload) {
  return payload.action || payload.triage || 'ASKING';
}

function extractPrimaryCondition(payload) {
  const mc = payload.matched_conditions;
  if (Array.isArray(mc) && mc.length > 0) {
    const first = mc[0];
    return typeof first === 'string' ? first : (first.name || first.condition || '');
  }
  return payload.primary_condition || '';
}

function extractDiagnosisList(payload) {
  const mc = payload.matched_conditions;
  if (Array.isArray(mc)) {
    return mc.map(x => typeof x === 'string' ? x : (x.name || x.condition || '')).filter(Boolean);
  }
  return [];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Run a single test case ────────────────────────────────────────────────────
async function runCase(caseObj) {
  const sessionId    = `eval-${caseObj.id}-${Date.now()}`;
  const systemPrompt = buildPatientPrompt(caseObj);
  const patientHistory = [];
  const logs           = [];
  let turn             = 0;
  let symtraPayload    = null;

  await resetSession(sessionId);

  // Generate opening message from patient AI
  patientHistory.push({
    role:  'user',
    parts: [{ text: 'Symtra just greeted you and asked what your main health concern is today. Write a short opening message — 1 to 2 sentences — describing your main symptom(s) naturally, like a real patient would. Do not list all your symptoms at once.' }]
  });
  const openingMessage = await callPatientAI(systemPrompt, patientHistory);
  patientHistory.push({ role: 'model', parts: [{ text: openingMessage }] });

  let userMessage = openingMessage;

  while (turn < MAX_TURNS) {
    turn++;

    // Send patient message to Symtra
    symtraPayload = await callSymtra(userMessage, sessionId);
    const symtraText = symtraPayload.response || symtraPayload.message || '';
    const action     = extractAction(symtraPayload);

    logs.push({
      turn,
      patient:            userMessage,
      symtra:             symtraText,
      action,
      matched_conditions: symtraPayload.matched_conditions || []
    });

    if (VERBOSE) {
      console.log(`    Turn ${turn}`);
      console.log(`    Patient : ${userMessage}`);
      console.log(`    Symtra  : ${symtraText.slice(0, 120)}${symtraText.length > 120 ? '...' : ''}`);
      console.log(`    Action  : ${action}\n`);
    }

    const ended   = Boolean(symtraPayload.session_ended);
    const isFinal = ['CONTINUE', 'SEEK_HELP_SOON', 'SEEK_HELP_IMMEDIATELY', 'UNKNOWN'].includes(action);
    if (ended || isFinal) break;

    // Patient AI responds to Symtra's question
    patientHistory.push({
      role:  'user',
      parts: [{ text: `Symtra asked: "${symtraText}"\n\nRespond as the patient. Answer only what was asked. Keep it short (1-3 sentences).` }]
    });
    const patientReply = await callPatientAI(systemPrompt, patientHistory);
    patientHistory.push({ role: 'model', parts: [{ text: patientReply }] });

    userMessage = patientReply;
    await sleep(13000); // stay under 5 RPM free tier (patient AI + server = 2 calls per turn)
  }

  // ── Score ──
  const finalAction    = extractAction(symtraPayload || {});
  const finalPrimary   = extractPrimaryCondition(symtraPayload || {});
  const finalDiagnoses = extractDiagnosisList(symtraPayload || {});
  const targetNorm     = normalize(caseObj.target_condition);

  const triagePass    = normalize(finalAction) === normalize(caseObj.expected_triage_tag);
  const conditionPass = [finalPrimary, ...finalDiagnoses]
    .map(normalize)
    .some(d => d.includes(targetNorm) || targetNorm.includes(d));

  return {
    id:                     caseObj.id,
    target_condition:       caseObj.target_condition,
    expected_triage:        caseObj.expected_triage_tag,
    actual_triage:          finalAction,
    actual_primary:         finalPrimary,
    actual_diagnoses:       finalDiagnoses,
    passed:                 triagePass && conditionPass,
    triagePass,
    conditionPass,
    turn_count:             turn,
    logs
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(CASES_PATH)) {
    console.error(`ERROR: Cases file not found: ${CASES_PATH}`);
    process.exit(1);
  }

  const raw   = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  const cases = (raw.cases || raw).slice(0, LIMIT || undefined);

  console.log('\n' + '='.repeat(56));
  console.log('  Symtra Evaluation — AI Patient Simulator');
  console.log('='.repeat(56));
  console.log(`  Cases      : ${cases.length}`);
  console.log(`  API keys   : ${apiKeys.length} (patient AI starts at key ${keyIndex + 1})`);
  console.log(`  Symtra     : ${SYMTRA_URL}`);
  console.log(`  Max turns  : ${MAX_TURNS}`);
  console.log('='.repeat(56) + '\n');

  const results = [];
  let idx = 0;

  for (const c of cases) {
    idx++;
    process.stdout.write(`[${String(idx).padStart(2)}/${cases.length}] ${c.id} (${c.target_condition}) ... `);
    try {
      const result = await runCase(c);
      results.push(result);
      const tag = result.passed ? 'PASS' : 'FAIL';
      console.log(`${tag}  triage=${result.actual_triage || 'N/A'} | condition=${result.actual_primary || 'N/A'} | turns=${result.turn_count}`);
    } catch (err) {
      results.push({ id: c.id, target_condition: c.target_condition, passed: false, error: err.message });
      console.log(`ERROR  ${err.message}`);
    }
    await sleep(15000); // pause between cases
  }

  // ── Summary ──
  const total     = results.length;
  const passed    = results.filter(r => r.passed).length;
  const triage    = results.filter(r => r.triagePass).length;
  const condition = results.filter(r => r.conditionPass).length;
  const errors    = results.filter(r => r.error).length;
  const withTurns = results.filter(r => r.turn_count);
  const avgTurns  = withTurns.length
    ? Number((withTurns.reduce((s, r) => s + r.turn_count, 0) / withTurns.length).toFixed(1))
    : 0;

  const pct = n => Number(((n / total) * 100).toFixed(1));

  const summary = {
    total_cases:                  total,
    passed_cases:                 passed,
    failed_cases:                 total - passed - errors,
    error_cases:                  errors,
    pass_rate_percent:            pct(passed),
    triage_accuracy_percent:      pct(triage),
    diagnosis_accuracy_percent:   pct(condition),
    avg_turns_per_case:           avgTurns
  };

  // ── Write output ──
  const outDir      = path.resolve(__dirname, 'test-results');
  fs.mkdirSync(outDir, { recursive: true });

  const fullPath    = path.join(outDir, 'eval_results.json');
  const summaryPath = path.join(outDir, 'eval_summary.json');

  fs.writeFileSync(fullPath,    JSON.stringify({ summary, results }, null, 2), 'utf8');
  fs.writeFileSync(summaryPath, JSON.stringify(summary,             null, 2), 'utf8');

  console.log('\n' + '='.repeat(56));
  console.log('  EVALUATION SUMMARY');
  console.log('='.repeat(56));
  console.log(`  Total cases          : ${total}`);
  console.log(`  Passed               : ${passed} (${summary.pass_rate_percent}%)`);
  console.log(`  Failed               : ${total - passed - errors}`);
  if (errors > 0) console.log(`  Errors               : ${errors}`);
  console.log('─'.repeat(56));
  console.log(`  Triage accuracy      : ${summary.triage_accuracy_percent}%`);
  console.log(`  Diagnosis accuracy   : ${summary.diagnosis_accuracy_percent}%`);
  console.log(`  Avg turns per case   : ${summary.avg_turns_per_case}`);
  console.log('─'.repeat(56));
  console.log(`  Full results  : ${fullPath}`);
  console.log(`  Summary       : ${summaryPath}`);
  console.log('='.repeat(56) + '\n');
}

main().catch(err => { console.error(err); process.exit(1); });
