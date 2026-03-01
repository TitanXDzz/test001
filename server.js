const express = require('express');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 5000;

// Load API key from environment variable or fallback to file (local dev only)
let apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  try { apiKey = fs.readFileSync('gemini-api-key.txt', 'utf8').trim(); } catch {}
}
if (!apiKey) throw new Error('GEMINI_API_KEY is not set. Add it as an environment variable.');
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const SYSTEM_PROMPT = `คุณคือผู้ช่วยวิเคราะห์อาการทางการแพทย์ บทบาทของคุณคือช่วยให้ผู้ใช้เข้าใจสภาวะที่อาจเกิดขึ้นจากอาการของพวกเขา ให้ตอบเป็นภาษาไทยเสมอ

แนวทางสำคัญ:
1. แสดงกระบวนการคิดอย่างโปร่งใส - อธิบายว่าทำไมถึงคิดเช่นนั้น
2. ถามคำถามติดตามที่เฉพาะเจาะจง 1-2 ข้อต่อครั้งเพื่อรวบรวมข้อมูลเพิ่มเติม
3. เมื่อมีข้อมูลเพียงพอ ให้วินิจฉัยแยกโรคอย่างชัดเจน (รายการโรคที่เป็นไปได้จากมากไปน้อย)
4. สำหรับแต่ละโรคที่เป็นไปได้ ให้อธิบาย:
   - เหตุใดจึงสอดคล้องกับอาการ
   - ลักษณะเด่นที่แยกแยะได้
   - ระดับความรุนแรง (เล็กน้อย / ปานกลาง / รุนแรง)
   - การดำเนินการที่แนะนำ (ดูแลตัวเอง / พบแพทย์ / ฉุกเฉิน)
5. ใส่คำปฏิเสธความรับผิดชอบเสมอว่านี่ไม่ใช่การทดแทนคำแนะนำทางการแพทย์จากผู้เชี่ยวชาญ
6. จัดโครงสร้างการให้เหตุผลอย่างชัดเจนด้วยหัวข้อ:
   การวิเคราะห์: (กระบวนการคิด)
   โรคที่เป็นไปได้: (รายการจัดอันดับ)
   การดำเนินการที่แนะนำ: (สิ่งที่ควรทำต่อไป)
7. ซื่อสัตย์เกี่ยวกับความไม่แน่นอน - หากอาการไม่ชัดเจน ให้บอกและขอข้อมูลเพิ่มเติม
8. อย่าลดความสำคัญของอาการรุนแรง - หากมีสัญญาณอันตราย (เจ็บหน้าอก หายใจลำบาก อาการโรคหลอดเลือดสมอง) ให้ให้ความปลอดภัยเป็นอันดับแรก

เริ่มต้นด้วยการทักทายผู้ใช้อย่างอบอุ่นและถามเกี่ยวกับอาการหลักหรือความกังวลของพวกเขา`;

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

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    hasApiKey: !!apiKey,
    node: process.version,
    env: process.env.NODE_ENV || 'none'
  });
});

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

  const generateWithRetry = async (prompt, retries = 3) => {
    for (let i = 0; i < retries; i++) {
      try {
        return await model.generateContent(prompt);
      } catch (err) {
        const retryMatch = err.message.match(/retry in (\d+(\.\d+)?)s/i);
        const wait = retryMatch ? parseFloat(retryMatch[1]) * 1000 : 5000;
        if (i < retries - 1 && err.message.includes('429')) {
          console.log(`Rate limited. Retrying in ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
        } else throw err;
      }
    }
  };

  try {
    const result = await generateWithRetry(fullPrompt);
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

// Export for Vercel serverless; listen only in local dev
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log('  Medical Symptom Diagnosis Chatbot');
    console.log('='.repeat(50));
    console.log(`  Running at: http://localhost:${PORT}`);
    console.log('  Press Ctrl+C to stop');
    console.log('='.repeat(50) + '\n');
  });
}

module.exports = app;
