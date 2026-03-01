const express = require('express');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = 5000;

// Load API key
const apiKey = fs.readFileSync('gemini-api-key.txt', 'utf8').trim();
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

const SYSTEM_PROMPT = `You are a medical symptom analysis assistant. Your role is to help users understand potential conditions based on their symptoms.

IMPORTANT GUIDELINES:
1. Always be transparent about your reasoning process - explain WHY you think what you think
2. Ask one or two focused follow-up questions at a time to gather more information
3. When you have enough information, provide a clear differential diagnosis (list of possible conditions from most to least likely)
4. For each possible condition, explain:
   - Why it matches the symptoms
   - Key distinguishing features
   - Severity level (mild/moderate/serious)
   - Recommended action (self-care / see a doctor / emergency care)
5. Always include a disclaimer that this is not a substitute for professional medical advice
6. Structure your reasoning clearly with labeled sections:
   Reasoning: (your thought process)
   Possible Conditions: (ranked list)
   Recommended Action: (what to do next)
7. Be honest about uncertainty - if symptoms are vague, say so and ask for clarification
8. Never minimize serious symptoms - if there are red flags (chest pain, difficulty breathing, stroke signs), prioritize safety first

Start by warmly greeting the user and asking about their main symptom or concern.`;

// Store conversations by session (simple in-memory for localhost)
const sessions = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'static')));
app.set('views', path.join(__dirname, 'templates'));
app.engine('html', (filePath, options, callback) => {
  fs.readFile(filePath, (err, content) => {
    if (err) return callback(err);
    callback(null, content.toString());
  });
});
app.set('view engine', 'html');

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message) return res.status(400).json({ error: 'Empty message' });

  const sid = sessionId || 'default';
  if (!sessions.has(sid)) sessions.set(sid, []);
  const history = sessions.get(sid);

  // Build full prompt with history
  let fullPrompt = SYSTEM_PROMPT + '\n\n';

  if (message === '__INIT__') {
    fullPrompt += 'Greet the user warmly and ask about their main symptom or health concern.';
  } else {
    if (history.length > 0) {
      fullPrompt += 'Previous conversation:\n';
      for (const msg of history) {
        fullPrompt += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.text}\n`;
      }
      fullPrompt += '\n';
    }
    fullPrompt += `User: ${message}\n\nRespond as the medical assistant:`;
    history.push({ role: 'user', text: message });
  }

  try {
    const result = await model.generateContent(fullPrompt);
    const responseText = result.response.text();

    if (message !== '__INIT__') {
      history.push({ role: 'assistant', text: responseText });
    }

    res.json({
      response: responseText,
      turn: Math.ceil(history.length / 2)
    });
  } catch (err) {
    console.error('Gemini error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/reset', (req, res) => {
  const { sessionId } = req.body;
  sessions.delete(sessionId || 'default');
  res.json({ status: 'reset' });
});

// Auto-open browser after server starts
function openBrowser() {
  const { exec } = require('child_process');
  setTimeout(() => {
    exec(`start http://localhost:${PORT}`);
  }, 1000);
}

app.listen(PORT, () => {
  console.log('\n' + '='.repeat(50));
  console.log('  Medical Symptom Diagnosis Chatbot');
  console.log('='.repeat(50));
  console.log(`  Running at: http://localhost:${PORT}`);
  console.log('  Press Ctrl+C to stop');
  console.log('='.repeat(50) + '\n');
  openBrowser();
});
