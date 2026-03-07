import json
import re
import webbrowser
import threading
from flask import Flask, render_template, request, jsonify
import google.generativeai as genai

app = Flask(__name__)

# Load API key
with open("gemini-api-key.txt", "r") as f:
    api_key = f.read().strip()

genai.configure(api_key=api_key)
gemini_model = genai.GenerativeModel("gemini-1.5-flash")

# Load condition list
with open("conditionlist.json", "r") as f:
    conditions = json.load(f)

conditions_text = "\n".join([
    f'  [{i+1}] "{c["condition"]}" | category: {c["category"]} | tag: {c["tag"]} | key_symptoms: {c["key_symptoms"]} | red_flags: {c["red_flags"]}'
    for i, c in enumerate(conditions)
])

# Load red flag list
with open("redflaglist.json", "r") as f:
    red_flag_data = json.load(f)

red_flag_text = "\n".join([
    f'  - [{v.get("triage_tag","SEEK_HELP_IMMEDIATELY")}] {v["description"]}: {", ".join(v.get("trigger_symptoms", []))}'
    + (("\n      Combination triggers: " + "; ".join(" + ".join(c) for c in v["combinations"])) if v.get("combinations") else "")
    for v in red_flag_data.values()
])

# Load schema
with open("schema.json", "r") as f:
    schema_data = json.load(f)

schema_fields_text = "\n".join([
    f'  - {section}.{field}' if isinstance(val, dict) else f'  - {section}'
    for section, val in schema_data.items()
    if section != "metadata"
    for field in (val.keys() if isinstance(val, dict) else [section])
])

SYSTEM_PROMPT = f"""You are a medical symptom diagnosis assistant. You MUST only classify patients into conditions from the list below. Do not invent or suggest any condition not in this list.

=== CONDITION DATABASE ===
{conditions_text}

=== RED FLAG SCREENING (CHECK THIS FIRST — BEFORE ANY OTHER STEP) ===
On every patient message, immediately scan for any of the following emergency conditions.
If ANY red flag matches — by individual symptom, combination trigger, your own judgment, OR if the matched condition carries a SEEK_HELP_IMMEDIATELY tag — you MUST:
  1. Set action = "SEEK_HELP_IMMEDIATELY" immediately
  2. Name the suspected emergency clearly in your message
  3. Instruct the patient to call emergency services (911 or local equivalent) without delay
  Do NOT continue asking questions or building a differential — patient safety comes first.

Known red flag conditions (from redflaglist.json):
{red_flag_text}

=== STRUCTURED INFORMATION COLLECTION (schema.json) ===
Before concluding with a final diagnosis, ensure you have collected the following fields.
If critical fields are missing, ask focused follow-up questions to fill them in.
Do NOT finalize a diagnosis without at minimum: chief_complaint.symptom, patient_info.age, chief_complaint.severity, chief_complaint.duration_days, and symptoms[].onset_type.

Required fields to collect:
{schema_fields_text}

=== DIAGNOSIS RULES (follow exactly) ===

STEP 1 — Gather symptoms by asking focused questions (1-2 per turn). Collect schema fields progressively.
STEP 2 — When multiple conditions are possible, ask a question that DIFFERENTIATES them (ask about a symptom present in one but not the others).
STEP 3 — Once confident, apply the rule based on the tag of the HIGHEST-urgency matched condition:

  tag = CONTINUE:
    → List all matched conditions ranked by probability (High/Medium/Low).
    → Tell the patient they can monitor at home but should see a doctor if symptoms worsen.
    → Set action = "CONTINUE"

  tag = SEEK_HELP_SOON:
    → List all matched conditions ranked by probability.
    → Tell the patient to seek medical attention within 24-48 hours.
    → Set action = "SEEK_HELP_SOON"

  tag = SEEK_HELP_IMMEDIATELY:
    → List the suspected conditions.
    → Tell the patient to seek EMERGENCY medical help IMMEDIATELY.
    → Set action = "SEEK_HELP_IMMEDIATELY"  ← this ends the session

  No condition matches:
    → Tell the patient their symptoms don't match the database.
    → Tell them to seek immediate medical help.
    → Set action = "UNKNOWN"  ← this also ends the session

=== TRANSPARENCY RULES ===
- Always explain WHY each condition matches (which specific symptoms point to it).
- Always show your reasoning step by step.
- Be honest about uncertainty — if symptoms are ambiguous, say so.
- Never minimize red flag symptoms (breathing difficulty, chest pain, severe bleeding, confusion, etc.).

=== STRICT JSON RESPONSE FORMAT ===
Your ENTIRE response must be a single valid JSON object. No text before or after it. No markdown.

{{
  "message": "Your full response to the patient. Use \\n for newlines.",
  "action": "ASKING",
  "matched_conditions": [
    {{
      "name": "exact condition name from the database",
      "probability": "High",
      "reason": "specific symptoms that match this condition"
    }}
  ],
  "reasoning": "Your step-by-step diagnostic thinking — which symptoms you considered and why",
  "next_question_purpose": "If action is ASKING — what symptom are you trying to clarify and which conditions does it differentiate"
}}

Valid action values:
  "ASKING"                — still gathering information
  "CONTINUE"              — diagnosis complete, tag is CONTINUE
  "SEEK_HELP_SOON"        — diagnosis complete, tag is SEEK_HELP_SOON
  "SEEK_HELP_IMMEDIATELY" — diagnosis complete, tag is SEEK_HELP_IMMEDIATELY (SESSION ENDS)
  "UNKNOWN"               — no condition matched (SESSION ENDS)
"""

# In-memory session store (per-session)
sessions = {}


def get_session(session_id):
    if session_id not in sessions:
        sessions[session_id] = {"history": [], "ended": False}
    return sessions[session_id]


@app.route("/")
def index():
    return render_template("index-version2.html")


@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json()
    user_message = data.get("message", "").strip()
    session_id = data.get("sessionId", "default")

    if not user_message:
        return jsonify({"error": "Empty message"}), 400

    session = get_session(session_id)

    if session["ended"]:
        return jsonify({"error": "Session has ended. Please start a new session."}), 400

    is_init = (user_message == "__INIT__")

    if not is_init:
        session["history"].append({"role": "user", "text": user_message})

    try:
        chat_session = gemini_model.start_chat(history=[])

        full_prompt = SYSTEM_PROMPT + "\n\n"

        if is_init:
            full_prompt += (
                "The patient just opened the app. "
                "Greet them warmly, explain you'll help assess their symptoms, "
                "and ask what their main symptom or health concern is today. "
                "Set action to \"ASKING\", matched_conditions to [], reasoning to \"\"."
            )
        else:
            history = session["history"]
            if len(history) > 1:
                full_prompt += "=== Conversation history ===\n"
                for msg in history[:-1]:
                    role = "Patient" if msg["role"] == "user" else "Assistant"
                    full_prompt += f"{role}: {msg['text']}\n"
                full_prompt += "\n"
            full_prompt += f"Patient's latest message: {user_message}\n\nYour JSON response:"

        result = gemini_model.generate_content(full_prompt)
        raw = result.text.strip()

        # Strip markdown code fences if present
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.MULTILINE)
        raw = re.sub(r"\s*```\s*$", "", raw, flags=re.MULTILINE)
        raw = raw.strip()

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = {
                "message": raw,
                "action": "ASKING",
                "matched_conditions": [],
                "reasoning": "",
                "next_question_purpose": ""
            }

        assistant_message = parsed.get("message", raw)
        action = parsed.get("action", "ASKING")
        matched_conditions = parsed.get("matched_conditions", [])
        reasoning = parsed.get("reasoning", "")
        next_question_purpose = parsed.get("next_question_purpose", "")

        if not is_init:
            session["history"].append({"role": "assistant", "text": assistant_message})

        if action in ("SEEK_HELP_IMMEDIATELY", "UNKNOWN"):
            session["ended"] = True

        return jsonify({
            "response": assistant_message,
            "action": action,
            "matched_conditions": matched_conditions,
            "reasoning": reasoning,
            "next_question_purpose": next_question_purpose,
            "session_ended": session["ended"],
            "turn": len([m for m in session["history"] if m["role"] == "user"])
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/reset", methods=["POST"])
def reset():
    data = request.get_json() or {}
    session_id = data.get("sessionId", "default")
    if session_id in sessions:
        del sessions[session_id]
    return jsonify({"status": "reset"})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "conditions_loaded": len(conditions),
        "red_flags_loaded": len(red_flag_data),
        "schema_loaded": True
    })


def open_browser():
    import time
    time.sleep(1.5)
    webbrowser.open("http://localhost:5000")


if __name__ == "__main__":
    threading.Thread(target=open_browser, daemon=True).start()
    print("\n" + "=" * 54)
    print("   Medical Symptom Diagnosis Chatbot  [v2]")
    print("=" * 54)
    print(f"   Conditions loaded:  {len(conditions)}")
    print(f"   Red flags loaded:   {len(red_flag_data)}")
    print(f"   Schema loaded:      yes")
    print("   Running at: http://localhost:5000")
    print("   Browser opening automatically...")
    print("   Press Ctrl+C to stop")
    print("=" * 54 + "\n")
    app.run(host="0.0.0.0", port=5000, debug=False)
