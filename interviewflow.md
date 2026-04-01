# Interview Flow Specification (Thai Herb Safe Mode)

## Purpose

Define the exact questioning flow to ensure:

* All required schema fields are collected
* Red flags are detected early
* Triage and herbal safety decisions are valid and complete

---

## 1. Schema Completion Requirement (CRITICAL)

**ALL FIELDS IN THE SCHEMA MUST BE FILLED BEFORE CONCLUSION**

The system MUST NOT finalize or recommend anything unless:

### Patient Info (REQUIRED)

* age
* biological_sex
* pregnancy_status

### Medical Safety (REQUIRED)

* medications
* allergies
* medical_history

### Symptoms (REQUIRED)

* at least one symptom
* severity OR duration
* onset_type (if possible)
* progression (if possible)

### Red Flag Evaluation (REQUIRED)

* must be performed at least once

---

### Enforcement Rule

If ANY required field is missing:
→ DO NOT conclude
→ Continue asking questions

### Exception

If a red flag is detected:
→ IMMEDIATELY escalate
→ Skip remaining fields

---

## 2. Interview Stages (Strict Order)

---

### Stage 1 — Intake

Goal: Identify main complaint

Collect:

* chief complaint (main symptom)

---

### Stage 2 — Symptom Clarification

Goal: Define symptom details

Collect:

* severity (0–10)
* duration (days)
* onset_type (sudden / gradual / unknown)
* progression (improving / stable / worsening)

#### Severity Clarification Prompts (MANDATORY WHEN RELEVANT)

* “How severe is it on a scale from 0 to 10?”
* “Would you describe it as mild, moderate, or severe?”
* “Is it bad enough to affect your normal activities?”

Rules:

* Required for pain, breathing issues, headaches, abdominal symptoms
* If unclear → ask follow-up

---

#### Ambiguity Resolution Prompts (MANDATORY WHEN INPUT IS UNCLEAR)

Use when:

* user gives vague answers
* user uses non-specific words
* information is incomplete or inconsistent

Examples:

**General clarification**

* “Could you describe that in more detail?”
* “Can you explain what you mean by that?”

**Location clarification**

* “Where exactly is the pain located?”
* “Is it on one side or both sides?”

**Severity clarification (if vague)**

* “When you say it's bad, how severe is it from 0 to 10?”

**Time clarification**

* “When did this start?”
* “Has it been constant or does it come and go?”

**Symptom meaning clarification**

* “What does the discomfort feel like? Is it sharp, dull, or burning?”

Rules:

* Must trigger when input is unclear
* Must NOT proceed with assumptions
* Must resolve ambiguity before moving forward

---

### Stage 3 — Early Red Flag Screening

Goal: Detect emergencies immediately

* Ask red-flag questions based on symptom type

Examples:

* Chest pain → radiation, sweating, shortness of breath
* Fever/headache → confusion, stiff neck, vomiting
* Abdominal pain → severe pain, worsening, vomiting

Rule:

* If red flag detected → STOP and escalate

---

### Stage 4 — Patient Profile Collection (MANDATORY)

Goal: Collect demographic data

Collect:

* age
* biological_sex
* pregnancy_status

---

### Stage 5 — Medical Safety Collection (MANDATORY)

Goal: Ensure safe recommendations

Collect:

* medications
* allergies
* medical_history

---

### Stage 6 — Secondary Red Flag Check

Goal: Detect risk after full context

Re-check using:

* symptoms
* medications
* medical history
* pregnancy status

Rule:

* If new red flag → escalate immediately

---

### Stage 7 — Final Verification

Goal: Confirm correctness

* Summarize:

  * symptoms
  * severity / duration
  * patient profile
  * medications / allergies / history

* Ask confirmation if needed

---

### Stage 8 — Triage Decision

Condition:

* ONLY allowed if ALL required fields are filled

Output:

* primary condition
* confidence
* triage tag

---

## 3. Contradiction Detection Logic (MANDATORY)

The system MUST detect inconsistencies between:

* previous answers
* new answers

### Core Rule

Whenever new information is received:
→ Compare with previously collected data
→ Check for contradictions

---

### Common Contradiction Examples

**Severity contradiction**

* Earlier: “mild pain”
* Later: “9/10 severe pain”

**Symptom contradiction**

* Earlier: “no fever”
* Later: “high fever”

**Medication contradiction**

* Earlier: “no medications”
* Later: mentions medication

**Functional contradiction**

* “severe pain”
* but “can do everything normally”

**Timeline contradiction**

* “started today”
* later “been for 5 days”

---

### Required Behavior When Contradiction Detected

1. DO NOT proceed
2. DO NOT conclude
3. Ask clarification question

---

### Contradiction Resolution Prompts

Examples:

* “Earlier you mentioned X, but now you said Y. Could you clarify which is correct?”
* “Just to confirm, do you have a fever or not?”
* “You mentioned the pain is mild earlier, but now it sounds severe. Can you clarify?”

---

### Resolution Rule

* Must resolve contradiction BEFORE continuing
* Must NOT ignore conflicting information
* Must update stored data after clarification

---

## 4. Stop Rules

### Immediate termination

* Red flag detected at any stage

### DO NOT conclude if missing:

* age
* biological_sex
* pregnancy_status
* medications
* allergies
* medical_history

### Exception

* Emergency → skip remaining questions and escalate

---

## 5. Questioning Rules

* Ask ONE question per turn
* Do NOT repeat answered questions
* Always prioritize:

  1. red flag detection
  2. contradiction resolution
  3. ambiguity resolution
  4. missing required fields
  5. symptom clarification

---

## 6. Question Priority Logic

When selecting the next question:

1. If red flag not evaluated → ask red flag question
2. Else if contradiction exists → resolve contradiction
3. Else if ambiguity exists → resolve ambiguity
4. Else if symptom incomplete → ask symptom clarification
5. Else if patient profile missing → ask profile question
6. Else if medical safety data missing → ask medications/allergies/history
7. Else → proceed to verification or triage

---

## 7. Completion Condition

Conversation is complete ONLY if:

* ALL required schema fields are filled
* red flag evaluation completed
* no unresolved ambiguity
* no unresolved contradictions

Otherwise:
→ continue asking questions

---

## 8. Key Constraints

* Do NOT skip mandatory stages
* Do NOT conclude early
* Do NOT assume unclear input
* MUST resolve ambiguity before proceeding
* MUST resolve contradictions before proceeding
* MUST track missing fields internally
* MUST enforce full schema completion before conclusion

---

## Summary

The system must:

* strictly follow stage order
* detect and resolve contradictions
* resolve ambiguity before progressing
* collect complete patient + safety data
* perform both early and late red flag checks
* ensure ALL schema fields are filled before conclusion

Failure to follow this = incorrect behavior
