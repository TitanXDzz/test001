#!/usr/bin/env node
/**
 * Symtra conversation test runner
 *
 * Usage examples:
 *   node test_runner.js --cases ./conversation_test_cases_final.json --api http://localhost:5000/api/chat
 *
 * Expected API contract (customize in callChatbot if your API differs):
 * Request JSON:
 *   {
 *     "message": "user text",
 *     "sessionId": "optional-session-id"
 *   }
 *
 * Response JSON should contain at least one assistant text field, and ideally a triage/diagnosis object.
 * Supported response keys (best-effort):
 *   text / response / message / reply
 *   triage / triage_tag / tag
 *   primary_condition / condition / diagnosis / suspected_condition
 *   diagnoses / differential / candidates
 */

const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(
  process.argv.slice(2).map((arg, i, arr) => {
    if (!arg.startsWith('--')) return [null, null];
    const key = arg.slice(2);
    const next = arr[i + 1];
    if (!next || next.startsWith('--')) return [key, 'true'];
    return [key, next];
  }).filter(([k]) => k)
);

const CASES_PATH = args.cases || './conversation_test_cases_final.json';
const API_URL = args.api || 'http://localhost:5000/api/chat';
const VERBOSE = args.verbose === 'true' || args.verbose === true;
const TIMEOUT_MS = Number(args.timeout || 30000);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesConcept(text, concept) {
  const t = normalizeText(text);
  const c = normalizeText(concept);
  if (!c) return false;
  return t.includes(c);
}

function conceptMatchScore(text, concepts) {
  if (!concepts || concepts.length === 0) return { matched: [], missing: [] };
  const matched = [];
  const missing = [];
  for (const concept of concepts) {
    if (includesConcept(text, concept)) matched.push(concept);
    else missing.push(concept);
  }
  return { matched, missing };
}

function extractAssistantText(payload) {
  return payload.text || payload.response || payload.message || payload.reply || '';
}

function extractTriage(payload) {
  return payload.triage_tag || payload.tag || payload.triage || payload?.triage_result?.tag || null;
}

function extractPrimaryCondition(payload) {
  return payload.primary_condition
    || payload.condition
    || payload.diagnosis
    || payload.suspected_condition
    || payload?.triage_result?.primary_condition
    || payload?.triage_result?.condition
    || null;
}

function extractDiagnosisList(payload) {
  return payload.diagnoses || payload.differential || payload.candidates || payload?.triage_result?.differential_diagnoses || [];
}

function diagnosisIncludes(targets, primaryCondition, diagnosisList, assistantText) {
  const haystacks = [
    primaryCondition || '',
    assistantText || '',
    ...(Array.isArray(diagnosisList)
      ? diagnosisList.map(x => typeof x === 'string' ? x : (x.condition || x.name || JSON.stringify(x)))
      : [])
  ].join(' || ');

  return targets.some(t => includesConcept(haystacks, t));
}

async function callChatbot(message, sessionId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId }),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function createSessionId(caseId) {
  return `symtra-test-${caseId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runCase(testCase) {
  const sessionId = createSessionId(testCase.id);
  const logs = [];
  let lastPayload = null;
  let turnCount = 0;
  let askPass = true;
  let askFailures = [];

  for (const turn of testCase.turns) {
    turnCount += 1;
    const payload = await callChatbot(turn.user, sessionId);
    lastPayload = payload;

    const assistantText = extractAssistantText(payload);
    logs.push({
      turn: turnCount,
      user: turn.user,
      assistant: assistantText,
      raw: payload
    });

    const expectedConcepts = turn.expected_bot_should_ask_about || [];
    if (expectedConcepts.length > 0) {
      const score = conceptMatchScore(assistantText, expectedConcepts);
      // require at least one expected concept to appear; full exact concept coverage is too strict
      if (score.matched.length === 0) {
        askPass = false;
        askFailures.push({
          turn: turnCount,
          expected_any_of: expectedConcepts,
          assistant: assistantText
        });
      }
    }
  }

  const assistantText = extractAssistantText(lastPayload || {});
  const triage = extractTriage(lastPayload || {});
  const primaryCondition = extractPrimaryCondition(lastPayload || {});
  const diagnosisList = extractDiagnosisList(lastPayload || {});

  const expected = testCase.expected_final;
  const triagePass = normalizeText(triage) === normalizeText(expected.expected_triage_tag);

  const conditionPass = diagnosisIncludes(
    expected.acceptable_conditions || [expected.primary_condition],
    primaryCondition,
    diagnosisList,
    assistantText
  );

  const turnPass = turnCount <= (testCase.max_turns_expected || Infinity);

  const redFlagPass = expected.red_flag_expected
    ? normalizeText(expected.expected_triage_tag) === 'seek_help_immediately' && triagePass
    : true;

  const passed = triagePass && conditionPass && askPass && turnPass && redFlagPass;

  return {
    id: testCase.id,
    target_condition: testCase.target_condition,
    passed,
    triagePass,
    conditionPass,
    askPass,
    turnPass,
    redFlagPass,
    expected_triage: expected.expected_triage_tag,
    actual_triage: triage,
    expected_condition: expected.primary_condition,
    acceptable_conditions: expected.acceptable_conditions,
    actual_primary_condition: primaryCondition,
    turn_count: turnCount,
    max_turns_expected: testCase.max_turns_expected,
    askFailures,
    logs
  };
}

async function main() {
  const cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  const results = [];

  for (const testCase of cases) {
    try {
      const result = await runCase(testCase);
      results.push(result);
      const status = result.passed ? 'PASS' : 'FAIL';
      console.log(`[${status}] ${result.id} | triage=${result.actual_triage || 'N/A'} | condition=${result.actual_primary_condition || 'N/A'}`);
      if (VERBOSE && !result.passed) {
        console.log(JSON.stringify(result, null, 2));
      }
      await sleep(100); // slight pacing
    } catch (err) {
      results.push({
        id: testCase.id,
        target_condition: testCase.target_condition,
        passed: false,
        error: err.message
      });
      console.log(`[ERROR] ${testCase.id} | ${err.message}`);
    }
  }

  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const triagePassed = results.filter(r => r.triagePass).length;
  const conditionPassed = results.filter(r => r.conditionPass).length;
  const askPassed = results.filter(r => r.askPass).length;
  const turnPassed = results.filter(r => r.turnPass).length;

  const summary = {
    total_cases: total,
    passed_cases: passed,
    failed_cases: total - passed,
    pass_rate_percent: Number(((passed / total) * 100).toFixed(2)),
    triage_accuracy_percent: Number(((triagePassed / total) * 100).toFixed(2)),
    condition_accuracy_percent: Number(((conditionPassed / total) * 100).toFixed(2)),
    followup_question_relevance_percent: Number(((askPassed / total) * 100).toFixed(2)),
    turn_limit_respected_percent: Number(((turnPassed / total) * 100).toFixed(2))
  };

  const outDir = path.resolve('./test-results');
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, 'conversation_test_results.json'), JSON.stringify({ summary, results }, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'conversation_test_results_summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nSaved detailed results to ${path.join(outDir, 'conversation_test_results.json')}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
