#!/usr/bin/env node
/**
 * run_eval.js — Automated evaluation for the v2 medical chatbot
 *
 * Usage:
 *   node run_eval.js
 *   node run_eval.js --verbose
 *   node run_eval.js --cases ./conversation_test_cases_final.json
 *   node run_eval.js --api http://localhost:5000/chat
 *
 * Metrics reported:
 *   - Diagnosis accuracy    (matched_conditions contains an acceptable condition)
 *   - Triage accuracy       (action matches expected_triage_tag)
 *   - Follow-up relevance   (bot response covers expected topics each turn)
 *   - Pass/fail summary     (per-case + overall)
 *
 * Matches server-version2.js response shape:
 *   { response, action, matched_conditions, reasoning, next_question_purpose, session_ended, turn }
 */

const fs   = require('fs');
const path = require('path');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((arg, i, arr) => {
    if (!arg.startsWith('--')) return [null, null];
    const key  = arg.slice(2);
    const next = arr[i + 1];
    if (!next || next.startsWith('--')) return [key, true];
    return [key, next];
  }).filter(([k]) => k)
);

const CASES_PATH = args.cases   || path.resolve(__dirname, 'conversation_test_cases_final.json');
const BASE_URL   = (args.api    || 'http://localhost:5000').replace(/\/chat$/, '');
const CHAT_URL   = BASE_URL + '/chat';
const RESET_URL  = BASE_URL + '/reset';
const VERBOSE    = !!args.verbose;
const TIMEOUT_MS = Number(args.timeout || 30000);

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includes(haystack, needle) {
  const h = normalize(haystack);
  const n = normalize(needle);
  return n.length > 0 && h.includes(n);
}

function conceptScore(text, concepts) {
  if (!concepts || concepts.length === 0) return { matched: [], missing: [] };
  const matched = [], missing = [];
  for (const c of concepts) {
    (includes(text, c) ? matched : missing).push(c);
  }
  return { matched, missing };
}

// ── Server response field extractors (matched to server-version2.js) ──────────
function getAssistantText(payload) {
  // server sends: response
  return payload.response || payload.message || payload.text || payload.reply || '';
}

function getTriage(payload) {
  // server sends: action  (ASKING / CONTINUE / SEEK_HELP_SOON / SEEK_HELP_IMMEDIATELY / UNKNOWN)
  return payload.action || payload.triage_tag || payload.triage || null;
}

function getPrimaryCondition(payload) {
  // server sends: matched_conditions[0]
  const mc = payload.matched_conditions;
  if (Array.isArray(mc) && mc.length > 0) {
    const first = mc[0];
    return typeof first === 'string' ? first : (first.condition || first.name || JSON.stringify(first));
  }
  return payload.primary_condition || payload.condition || payload.diagnosis || null;
}

function getDiagnosisList(payload) {
  // server sends: matched_conditions
  const mc = payload.matched_conditions;
  if (Array.isArray(mc)) return mc;
  return payload.diagnoses || payload.differential || payload.candidates || [];
}

function diagnosisMatches(acceptableConditions, primaryCondition, diagnosisList, assistantText) {
  const candidates = [
    primaryCondition || '',
    assistantText    || '',
    ...diagnosisList.map(x => (typeof x === 'string' ? x : (x.condition || x.name || JSON.stringify(x))))
  ].join(' || ');

  return acceptableConditions.some(t => includes(candidates, t));
}

// ── HTTP calls ────────────────────────────────────────────────────────────────
async function callChat(message, sessionId) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(CHAT_URL, {
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

// ── Single test-case runner ───────────────────────────────────────────────────
async function runCase(tc) {
  const sessionId = `eval-${tc.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await resetSession(sessionId);

  const logs        = [];
  let lastPayload   = null;
  let turnCount     = 0;
  let followupPass  = true;
  const followupFailures = [];

  for (const turn of tc.turns) {
    turnCount++;
    const payload     = await callChat(turn.user, sessionId);
    lastPayload       = payload;
    const botText     = getAssistantText(payload);

    logs.push({ turn: turnCount, user: turn.user, assistant: botText, raw: payload });

    const expected = turn.expected_bot_should_ask_about || [];
    if (expected.length > 0) {
      const score = conceptScore(botText, expected);
      if (score.matched.length === 0) {
        followupPass = false;
        followupFailures.push({ turn: turnCount, expected_any_of: expected, got: botText });
      }
    }

    // Stop sending turns if the session has ended on server side
    if (payload.session_ended) break;
  }

  const botText    = getAssistantText(lastPayload || {});
  const triage     = getTriage(lastPayload || {});
  const primary    = getPrimaryCondition(lastPayload || {});
  const diagList   = getDiagnosisList(lastPayload || {});
  const expected   = tc.expected_final;

  const triagePass    = normalize(triage) === normalize(expected.expected_triage_tag);
  const conditionPass = diagnosisMatches(
    expected.acceptable_conditions || [expected.primary_condition],
    primary, diagList, botText
  );
  const turnPass      = turnCount <= (tc.max_turns_expected || Infinity);
  const redFlagPass   = expected.red_flag_expected
    ? normalize(expected.expected_triage_tag) === 'seek_help_immediately' && triagePass
    : true;

  const passed = triagePass && conditionPass && followupPass && turnPass && redFlagPass;

  return {
    id:                    tc.id,
    category:              tc.category,
    target_condition:      tc.target_condition,
    passed,
    triagePass,
    conditionPass,
    followupPass,
    turnPass,
    redFlagPass,
    expected_triage:       expected.expected_triage_tag,
    actual_triage:         triage,
    expected_condition:    expected.primary_condition,
    acceptable_conditions: expected.acceptable_conditions,
    actual_primary:        primary,
    actual_diagnoses:      diagList,
    turn_count:            turnCount,
    max_turns_expected:    tc.max_turns_expected,
    followupFailures,
    logs
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(CASES_PATH)) {
    console.error(`ERROR: Test cases file not found: ${CASES_PATH}`);
    process.exit(1);
  }

  const cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  console.log(`Running ${cases.length} test case(s) against ${CHAT_URL}\n`);

  const results = [];
  let idx = 0;

  for (const tc of cases) {
    idx++;
    process.stdout.write(`[${idx}/${cases.length}] ${tc.id} ... `);
    try {
      const r = await runCase(tc);
      results.push(r);

      const tag = r.passed ? 'PASS' : 'FAIL';
      const details = [
        `triage=${r.actual_triage || 'N/A'}`,
        `condition=${r.actual_primary || 'N/A'}`,
        `turns=${r.turn_count}`
      ].join(' | ');
      console.log(`${tag}  ${details}`);

      if (VERBOSE && !r.passed) {
        if (!r.triagePass)   console.log(`  ✗ triage:    expected=${r.expected_triage}  actual=${r.actual_triage}`);
        if (!r.conditionPass) console.log(`  ✗ condition: expected one of [${(r.acceptable_conditions||[]).join(', ')}]  actual=${r.actual_primary}`);
        if (!r.followupPass)  r.followupFailures.forEach(f =>
          console.log(`  ✗ followup turn ${f.turn}: expected any of [${f.expected_any_of.join(', ')}]`));
      }
    } catch (err) {
      results.push({ id: tc.id, target_condition: tc.target_condition, passed: false, error: err.message });
      console.log(`ERROR  ${err.message}`);
    }
    await sleep(150);
  }

  // ── Summary ──
  const total      = results.length;
  const passed     = results.filter(r => r.passed).length;
  const triage     = results.filter(r => r.triagePass).length;
  const condition  = results.filter(r => r.conditionPass).length;
  const followup   = results.filter(r => r.followupPass).length;
  const turns      = results.filter(r => r.turnPass).length;
  const errors     = results.filter(r => r.error).length;

  const pct = n => Number(((n / total) * 100).toFixed(1));

  const summary = {
    total_cases:                        total,
    passed_cases:                       passed,
    failed_cases:                       total - passed,
    error_cases:                        errors,
    pass_rate_percent:                  pct(passed),
    diagnosis_accuracy_percent:         pct(condition),
    triage_accuracy_percent:            pct(triage),
    followup_question_relevance_percent: pct(followup),
    turn_limit_respected_percent:       pct(turns)
  };

  // ── Per-category breakdown ──
  const byCategory = {};
  for (const r of results) {
    const cat = r.category || 'Unknown';
    if (!byCategory[cat]) byCategory[cat] = { total: 0, passed: 0 };
    byCategory[cat].total++;
    if (r.passed) byCategory[cat].passed++;
  }
  const category_breakdown = Object.fromEntries(
    Object.entries(byCategory).map(([cat, v]) => [cat, { ...v, pass_rate_percent: pct(v.passed / v.total * total) }])
  );

  // ── Write output ──
  const outDir = path.resolve(__dirname, 'test-results');
  fs.mkdirSync(outDir, { recursive: true });

  const fullPath    = path.join(outDir, 'eval_results.json');
  const summaryPath = path.join(outDir, 'eval_summary.json');

  fs.writeFileSync(fullPath,    JSON.stringify({ summary, category_breakdown, results }, null, 2), 'utf8');
  fs.writeFileSync(summaryPath, JSON.stringify({ summary, category_breakdown },           null, 2), 'utf8');

  console.log('\n═══════════════════════════════════════');
  console.log('  EVALUATION SUMMARY');
  console.log('═══════════════════════════════════════');
  console.log(`  Total cases       : ${total}`);
  console.log(`  Passed            : ${passed} (${summary.pass_rate_percent}%)`);
  console.log(`  Failed            : ${total - passed}`);
  if (errors > 0) console.log(`  Errors            : ${errors}`);
  console.log('───────────────────────────────────────');
  console.log(`  Diagnosis accuracy      : ${summary.diagnosis_accuracy_percent}%`);
  console.log(`  Triage accuracy         : ${summary.triage_accuracy_percent}%`);
  console.log(`  Follow-up relevance     : ${summary.followup_question_relevance_percent}%`);
  console.log(`  Turn limit respected    : ${summary.turn_limit_respected_percent}%`);
  console.log('───────────────────────────────────────');
  if (Object.keys(byCategory).length > 1) {
    console.log('  By category:');
    for (const [cat, v] of Object.entries(byCategory)) {
      console.log(`    ${cat.padEnd(20)} ${v.passed}/${v.total}`);
    }
    console.log('───────────────────────────────────────');
  }
  console.log(`  Full results : ${fullPath}`);
  console.log(`  Summary      : ${summaryPath}`);
  console.log('═══════════════════════════════════════\n');
}

main().catch(err => { console.error(err); process.exit(1); });
