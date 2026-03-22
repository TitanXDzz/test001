/**
 * AI-Powered Profile-based Test Runner for Symtra
 *
 * - AI Tester (OpenRouter / testerai key) acts as a patient
 *   It knows the hidden condition but reveals symptoms slowly
 * - Symtra (localhost:5000/chat) is the system under test
 * - Full conversation logs saved to test-results/results_<timestamp>.json
 * - Aggregate summary saved to test-results/eval_summary.json
 *
 * Usage:
 *   node test_runner.js
 *   node test_runner.js --case=profile_001   (single case)
 *   node test_runner.js --verbose
 *   node test_runner.js --max-turns=12
 */

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const CASES_PATH     = path.join(__dirname, 'profile_based_test_cases_full.json');
const SYMTRA_URL     = 'http://localhost:5000/chat';
const RESULTS_DIR    = path.join(__dirname, 'test-result');
const SUMMARY_PATH   = path.join(RESULTS_DIR, 'eval_summary.json');
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TESTER_MODEL   = 'openai/gpt-4o-mini';

const TESTERAI_KEY = fs.readFileSync(
  path.join(__dirname, '../openrouter-api-keys/testerai.txt'), 'utf8'
).trim();

// ── CLI args ──────────────────────────────────────────────────────────────────
const ARGS        = process.argv.slice(2);
const VERBOSE     = ARGS.includes('--verbose');
const SINGLE_CASE = (ARGS.find(a => a.startsWith('--case=')) || '').split('=')[1];
const MAX_TURNS   = parseInt(
  (ARGS.find(a => a.startsWith('--max-turns=')) || '').split('=')[1] || '12'
);

// ── OpenRouter call (AI Tester) ───────────────────────────────────────────────
async function callTesterAI(messages) {
  const res = await fetch(OPENROUTER_URL, {
    method : 'POST',
    headers: {
      'Authorization': `Bearer ${TESTERAI_KEY}`,
      'Content-Type' : 'application/json',
      'HTTP-Referer' : 'http://localhost:5000',
    },
    body: JSON.stringify({ model: TESTER_MODEL, messages, temperature: 0.75 }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`TesterAI error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// ── Symtra call ───────────────────────────────────────────────────────────────
async function callSymtra(message, sessionId) {
  const res = await fetch(SYMTRA_URL, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify({ message, sessionId }),
  });

  if (!res.ok) throw new Error(`Symtra error ${res.status}: ${res.statusText}`);
  return res.json();
}

// ── Build tester system prompt ────────────────────────────────────────────────
function buildSystemPrompt(caseObj) {
  const p   = caseObj.patient_profile;
  const fmt = (arr, fallback = 'None') =>
    arr && arr.length ? arr.join(', ') : fallback;

  const pregnancy =
    p.pregnancy_status === null ? 'Not applicable' :
    p.pregnancy_status          ? 'Yes' : 'No';

  return `You are roleplaying as a patient talking to a medical chatbot called Symtra.

YOUR PROFILE (answer from this when asked):
- Age: ${p.age}
- Biological sex: ${p.biological_sex}
- Pregnant: ${pregnancy}
- Medical history: ${fmt(p.medical_history)}
- Current medications: ${fmt(p.medications)}
- Allergies: ${fmt(p.allergies)}
- Relevant background: ${fmt(p.risk_factors)}

YOUR HIDDEN CONDITION: ${caseObj.target_condition}
(You KNOW this but must NEVER say it. Reveal symptoms gradually.)

RULES — follow these strictly:
1. Only answer what Symtra specifically asks. Do not volunteer extra information.
2. Reveal symptoms naturally and slowly — like a real patient who doesn't know medical terms.
3. Never name your condition or use clinical language for it.
4. Keep replies short: 1–3 sentences max.
5. Be consistent with your profile throughout.
6. If asked about symptoms you don't have, say so honestly.
7. Speak like a normal person, not a doctor.`;
}

// ── Extract helpers ───────────────────────────────────────────────────────────
const extractText       = p => p.response || p.message || p.text || '';
const extractAction     = p => p.action || 'ASKING';
const extractConditions = p =>
  (p.matched_conditions || [])
    .map(c => (typeof c === 'string' ? c : c.name))
    .filter(Boolean);

// ── Run a single test case ────────────────────────────────────────────────────
async function runCase(caseObj) {
  const sessionId    = `eval-${caseObj.id}-${Date.now()}`;
  const systemPrompt = buildSystemPrompt(caseObj);
  const testerHistory = [{ role: 'system', content: systemPrompt }];
  const logs = [];

  // Step 1: AI tester opens with chief complaint
  testerHistory.push({
    role   : 'user',
    content: 'Start the conversation. Describe your main complaint briefly (1–2 sentences). Do NOT mention your full history yet — just the most noticeable symptom bothering you.',
  });

  const opening = await callTesterAI(testerHistory);
  testerHistory.push({ role: 'assistant', content: opening });

  if (VERBOSE) console.log(`\n  [Patient opens]: ${opening}`);

  let userMessage = opening;
  let lastPayload = null;
  let turn        = 0;

  // Step 2: conversation loop
  while (turn < MAX_TURNS) {
    turn++;

    const payload    = await callSymtra(userMessage, sessionId);
    lastPayload      = payload;
    const symtraText = extractText(payload);
    const action     = extractAction(payload);
    const conditions = extractConditions(payload);

    logs.push({
      turn,
      patient           : userMessage,
      symtra            : symtraText,
      action,
      matched_conditions: conditions,
    });

    if (VERBOSE) {
      console.log(
        `  [Turn ${turn}] Symtra [${action}]: ` +
        `${symtraText.slice(0, 120)}${symtraText.length > 120 ? '...' : ''}`
      );
    }

    const isFinal      = ['CONTINUE', 'SEEK_HELP_SOON', 'SEEK_HELP_IMMEDIATELY', 'UNKNOWN'].includes(action);
    const sessionEnded = Boolean(payload.session_ended);
    if (isFinal || sessionEnded) break;

    // AI tester replies to Symtra's question
    testerHistory.push({
      role   : 'user',
      content: `Symtra just said:\n"${symtraText}"\n\nReply as the patient. Answer ONLY what was asked. Keep it short and natural (1–3 sentences).`,
    });

    const patientReply = await callTesterAI(testerHistory);
    testerHistory.push({ role: 'assistant', content: patientReply });

    if (VERBOSE) console.log(`  [Patient]: ${patientReply}`);

    userMessage = patientReply;
  }

  // ── Score ─────────────────────────────────────────────────────────────────
  const finalAction     = extractAction(lastPayload || {});
  const finalConditions = extractConditions(lastPayload || {});

  const triagePass = finalAction === caseObj.expected_triage_tag;

  const target       = caseObj.target_condition.toLowerCase();
  const conditionPass = finalConditions.some(c => {
    const n = c.toLowerCase();
    return n.includes(target) || target.includes(n);
  });

  return {
    id                : caseObj.id,
    target_condition  : caseObj.target_condition,
    expected_triage   : caseObj.expected_triage_tag,
    actual_triage     : finalAction,
    matched_conditions: finalConditions,
    triage_pass       : triagePass,
    condition_pass    : conditionPass,
    passed            : triagePass && conditionPass,
    turn_count        : turn,
    conversation      : logs,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const raw      = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  const allCases = raw.cases || raw;
  const cases    = SINGLE_CASE
    ? allCases.filter(c => c.id === SINGLE_CASE)
    : allCases;

  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const timestamp   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const resultsPath = path.join(RESULTS_DIR, `results_${timestamp}.json`);

  const results = [];

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Symtra Evaluation — ${cases.length} case(s)`);
  console.log(`${'═'.repeat(60)}\n`);

  for (const c of cases) {
    process.stdout.write(`[${c.id}] ${c.target_condition.padEnd(35)} `);

    try {
      const result = await runCase(c);
      results.push(result);

      const tag =
        result.passed      ? 'PASS   ' :
        result.triage_pass ? 'PARTIAL' : 'FAIL   ';

      console.log(`${tag} | triage=${result.actual_triage.padEnd(22)} | turns=${result.turn_count}`);
    } catch (err) {
      results.push({
        id              : c.id,
        target_condition: c.target_condition,
        error           : err.message,
        passed          : false,
        triage_pass     : false,
        condition_pass  : false,
      });
      console.log(`ERROR   | ${err.message}`);
    }
  }

  // ── Save detailed results ────────────────────────────────────────────────
  fs.writeFileSync(resultsPath, JSON.stringify({ timestamp, results }, null, 2), 'utf8');

  // ── Build summary ────────────────────────────────────────────────────────
  const total        = results.length;
  const passed       = results.filter(r => r.passed).length;
  const triagePassed = results.filter(r => r.triage_pass).length;
  const condPassed   = results.filter(r => r.condition_pass).length;
  const errors       = results.filter(r => r.error).length;

  const byTag = {};
  for (const r of results) {
    const tag = r.expected_triage || 'UNKNOWN';
    if (!byTag[tag]) byTag[tag] = { total: 0, triage_correct: 0, fully_passed: 0 };
    byTag[tag].total++;
    if (r.triage_pass) byTag[tag].triage_correct++;
    if (r.passed)      byTag[tag].fully_passed++;
  }

  const failedCases = results
    .filter(r => !r.passed && !r.error)
    .map(r => ({
      id             : r.id,
      condition      : r.target_condition,
      expected_triage: r.expected_triage,
      actual_triage  : r.actual_triage,
      matched        : r.matched_conditions,
    }));

  const summary = {
    generated_at      : new Date().toISOString(),
    results_file      : path.basename(resultsPath),
    total_cases       : total,
    passed,
    failed            : total - passed - errors,
    errors,
    pass_rate         : `${((passed       / total) * 100).toFixed(1)}%`,
    triage_accuracy   : `${((triagePassed  / total) * 100).toFixed(1)}%`,
    condition_accuracy: `${((condPassed    / total) * 100).toFixed(1)}%`,
    by_triage_tag     : byTag,
    failed_cases      : failedCases,
  };

  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');

  // ── Print summary ─────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  EVALUATION SUMMARY');
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Total cases       : ${total}`);
  console.log(`  Fully passed      : ${passed}  (${summary.pass_rate})`);
  console.log(`  Triage accuracy   : ${triagePassed}/${total}  (${summary.triage_accuracy})`);
  console.log(`  Condition accuracy: ${condPassed}/${total}  (${summary.condition_accuracy})`);
  console.log(`  Errors            : ${errors}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Results → ${resultsPath}`);
  console.log(`  Summary → ${SUMMARY_PATH}`);
  console.log(`${'═'.repeat(60)}\n`);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
