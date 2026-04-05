# Task 1.3 — Adaptive / Uncertainty-Based Question Selection (Symtra)

## Objective

Upgrade Symtra from fixed questioning to **adaptive questioning**, where the system selects the most informative next question based on current diagnostic uncertainty.

The system must:

* Reduce uncertainty efficiently
* Avoid redundant questions
* Maintain safety and schema completeness
* Stop early when sufficient confidence is reached

---

## Core Principle

At every step, the system must choose:

> **The question that best distinguishes between the top competing diagnoses**

---

## 1. Priority Control Flow (STRICT ORDER)

The adaptive system MUST follow this priority stack:

1. Red flag detection (highest priority)
2. Contradiction resolution
3. Ambiguity resolution
4. Adaptive question selection (this task)
5. Missing required schema fields
6. Stop condition evaluation

Adaptive questioning MUST NOT override:

* safety (red flags)
* required schema completion

---

## 2. Adaptive Questioning Loop

Each turn follows:

```
loop:
  check red flags
  if detected → escalate immediately

  check contradictions
  if exists → resolve contradiction

  check ambiguity
  if exists → clarify

  compute top diagnoses
  rank candidate questions
  select best next question

  check missing required fields
  if missing → ask required field question

  check stop condition
  if met → finalize
```

---

## 3. Top Diagnosis Selection

From current matched conditions:

* Sort by probability / score
* Select top 2–4 diagnoses

Example:

```
["Common cold", "Mild influenza", "COVID-19 suspected"]
```

These are the **competing hypotheses**

---

## 4. Question Bank (REQUIRED)

Create a mapping of:

* condition  → target symptom → candidate questions

Example:

```json
{
  "Common cold": [
    { "question": "Do you have a fever?", "symptom": "fever" },
    { "question": "Do you have body aches?", "symptom": "body aches" }
  ],
  "Mild influenza": [
    { "question": "Do you have body aches?", "symptom": "body aches" },
    { "question": "How high is your fever?", "symptom": "fever severity" }
  ],
  "COVID-19 suspected": [
    { "question": "Have you lost your sense of smell?", "symptom": "loss of smell" },
    { "question": "Do you feel short of breath?", "symptom": "shortness of breath" }
  ]
}
```

---

## 5. Candidate Question Pool

Build candidate questions from:

* top diagnoses
* unasked questions only
* symptoms not yet confirmed

---

## 6. Question Ranking Algorithm

Each candidate question is scored.

### Create Scoring Rules
Example{
Add points:

* +3 → distinguishes between top diagnoses
* +2 → affects triage severity (red flag relevance)
* +2 → symptom not yet known
* +1 → improves confidence significantly

Subtract points:

* −5 → already asked
* −3 → answer already known
* −2 → redundant / similar to previous question
}
---

### Selection Rule

Choose:

```
highest scoring valid question
```

---

## 7. Redundancy Avoidance

Maintain memory:

```
asked_questions = []
known_symptoms = {}
```

Rules:

* Do NOT ask same question twice
* Do NOT ask if answer already known
* Do NOT ask paraphrased duplicates

---

## 8. Contradiction Detection Integration

Before asking new question:

* Compare new data with existing data
* If contradiction exists → resolve FIRST

Example:

* “no fever” → later “high fever”

System must:

* pause
* ask clarification
* update stored data



## 9. Early Stop Logic

System should stop when:

### Condition A — Emergency

* red flag detected → immediate escalation

### Condition B — High Confidence

* required fields complete AND
* confidence = high

### Condition C — Dominant Diagnosis

* required fields complete AND
* top diagnosis significantly higher than others

---

## 10. Completion Conditions

Conversation is complete ONLY if:

* required schema fields are filled OR emergency triggered
* no unresolved contradictions
* no unresolved ambiguity

---

## 11. Integration With Existing System

This logic must:

* plug into existing diagnostic engine
* use current condition scoring
* NOT degrade current performance
* maintain natural conversation tone

---

## 12. Implementation Deliverables

Claude must implement:

1. Question ranking algorithm
2. Question bank structure
3. Adaptive questioning loop
4. Stop-condition logic
5. Redundancy avoidance system
6. Integration with current system

---

## Summary

The system must:

* ask the most informative next question
* reduce uncertainty efficiently
* avoid redundant or irrelevant questions
* stop early when safe and confident
* maintain safety and schema completeness

Failure to follow this logic = incorrect implementation
