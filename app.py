import os
import json
import webbrowser
import threading
from flask import Flask, render_template, request, jsonify
import google.generativeai as genai

app = Flask(__name__)

# Load API key
with open("gemini-api-key.txt", "r") as f:
    api_key = f.read().strip()

genai.configure(api_key=api_key)
model = genai.GenerativeModel("gemini-1.5-flash")

SYSTEM_PROMPT = """You are a medical symptom analysis assistant. Your role is to help users understand potential conditions based on their symptoms.

IMPORTANT GUIDELINES:
1. Always be transparent about your reasoning process - explain WHY you're asking each question
2. Ask one or two focused follow-up questions at a time to gather more information
3. When you have enough information, provide a clear differential diagnosis (list of possible conditions from most to least likely)
4. For each possible condition, explain:
   - Why it matches the symptoms
   - Key distinguishing features
   - Severity level (mild/moderate/serious)
   - Recommended action (self-care / see a doctor / emergency care)
5. Always include a disclaimer that this is not a substitute for professional medical advice
6. Structure your reasoning clearly with sections like "Reasoning:", "Possible Conditions:", "Recommended Action:"
7. Be honest about uncertainty - if symptoms are vague, say so and ask for clarification
8. Never minimize serious symptoms - if there are red flags (chest pain, difficulty breathing, etc.), prioritize safety

Start by warmly greeting the user and asking about their main symptom or concern."""

conversation_history = []


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/chat", methods=["POST"])
def chat():
    global conversation_history
    data = request.get_json()
    user_message = data.get("message", "").strip()

    if not user_message:
        return jsonify({"error": "Empty message"}), 400

    # Build conversation for Gemini
    conversation_history.append({
        "role": "user",
        "parts": [user_message]
    })

    try:
        chat_session = model.start_chat(history=[])

        # Send system prompt + full history as context
        full_prompt = SYSTEM_PROMPT + "\n\n"
        if len(conversation_history) > 1:
            full_prompt += "Previous conversation:\n"
            for msg in conversation_history[:-1]:
                role = "User" if msg["role"] == "user" else "Assistant"
                full_prompt += f"{role}: {msg['parts'][0]}\n"
            full_prompt += "\n"

        full_prompt += f"User's latest message: {user_message}\n\nRespond as the medical assistant:"

        response = chat_session.send_message(full_prompt)
        assistant_message = response.text

        conversation_history.append({
            "role": "model",
            "parts": [assistant_message]
        })

        return jsonify({
            "response": assistant_message,
            "turn": len(conversation_history) // 2
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/reset", methods=["POST"])
def reset():
    global conversation_history
    conversation_history = []
    return jsonify({"status": "reset"})


@app.route("/history", methods=["GET"])
def history():
    return jsonify({"history": conversation_history})


def open_browser():
    import time
    time.sleep(1.2)
    webbrowser.open("http://localhost:5000")


if __name__ == "__main__":
    threading.Thread(target=open_browser, daemon=True).start()
    print("\n" + "="*50)
    print("  Medical Symptom Diagnosis Chatbot")
    print("="*50)
    print("  Running at: http://localhost:5000")
    print("  Press Ctrl+C to stop")
    print("="*50 + "\n")
    app.run(host="0.0.0.0", port=5000, debug=False)
