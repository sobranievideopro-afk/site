require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// В ALLOWED_ORIGIN укажите домен вашего сайта на Тильде, например https://your-site.tilda.ws
// Можно перечислить несколько через запятую.
const allowedOrigins = (process.env.ALLOWED_ORIGIN || '*')
  .split(',')
  .map(s => s.trim());

app.use(cors({
  origin: function (origin, callback) {
    console.log('Incoming request Origin:', origin);
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log('Blocked. Allowed origins are:', allowedOrigins);
      callback(new Error('Not allowed by CORS'));
    }
  }
}));
app.use(express.json({ limit: '1mb' }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function notifyTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // уведомления не настроены — просто пропускаем
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
  } catch (e) {
    console.error('Telegram notify failed:', e.message);
  }
}

async function extractText(file) {
  const name = file.originalname.toLowerCase();
  if (name.endsWith('.pdf')) {
    const data = await pdfParse(file.buffer);
    return data.text;
  }
  if (name.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }
  // .txt и всё остальное — читаем как обычный текст
  return file.buffer.toString('utf-8');
}

function buildPrompt(text) {
  return `Ты — опытный HR-консультант, специализируешься на упаковке резюме руководителей и специалистов для российского рынка труда.

Проанализируй резюме ниже и верни ТОЛЬКО валидный JSON — без единого слова до или после него, без markdown-обрамления (без \`\`\`), без пояснений о том, что ты делаешь. Первый символ твоего ответа должен быть "{", последний — "}".

Формат:
{
  "score": число от 0 до 100,
  "summary": "1-2 коротких предложения общего вывода по резюме",
  "strengths": ["сильная сторона 1", "сильная сторона 2"],
  "weaknesses": ["слабое место 1", "слабое место 2"],
  "recommendations": ["конкретная рекомендация 1", "конкретная рекомендация 2"]
}

Дай от 3 до 5 пунктов в каждом массиве strengths / weaknesses / recommendations.
Каждый пункт — не длиннее одного короткого предложения (до 15-18 слов), это важно, чтобы ответ не обрывался.
Будь конкретным и практичным: ссылайся на реальные формулировки и паттерны из текста резюме (например, отсутствие цифр в достижениях, шаблонные фразы вроде "ответственный за", отсутствие структуры), а не на общие советы в духе "добавьте больше деталей".

Резюме кандидата:
"""
${text}
"""`;
}

app.post('/analyze', upload.single('resume'), async (req, res) => {
  try {
    const name = (req.body && req.body.name || '').trim();
    const phone = (req.body && req.body.phone || '').trim();

    if (!name || !phone) {
      return res.status(400).json({ error: 'Укажите имя и телефон перед анализом резюме.' });
    }
    if (phone.replace(/\D/g, '').length < 10) {
      return res.status(400).json({ error: 'Похоже, номер телефона указан некорректно.' });
    }

    let text = '';
    if (req.file) {
      text = await extractText(req.file);
    } else if (req.body && req.body.text) {
      text = req.body.text;
    }
    text = (text || '').trim();

    if (text.length < 50) {
      return res.status(400).json({
        error: 'Слишком мало текста для анализа. Проверьте файл или вставьте текст резюме вручную.'
      });
    }
    if (text.length > 20000) {
      text = text.slice(0, 20000);
    }

    // Лид получен — логируем и уведомляем, ещё до вызова модели,
    // чтобы контакт сохранился, даже если анализ по какой-то причине упадёт
    console.log(`[LEAD] ${new Date().toISOString()} — ${name}, ${phone}`);
    notifyTelegram(`🆕 Новая заявка на анализ резюме\nИмя: ${name}\nТелефон: ${phone}`);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: buildPrompt(text) }]
    });

    if (message.stop_reason === 'max_tokens') {
      console.warn('Warning: response was cut off by max_tokens limit');
    }

    const raw = message.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();

    // Модель иногда добавляет пояснения или ```json``` вокруг ответа —
    // вырезаем именно JSON-объект между первой { и последней }
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    const cleaned = firstBrace !== -1 && lastBrace !== -1
      ? raw.slice(firstBrace, lastBrace + 1)
      : raw.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('JSON parse error. Raw response was:\n', raw);
      return res.status(502).json({ error: 'Не удалось разобрать ответ модели. Попробуйте ещё раз.' });
    }

    res.json(Object.assign({}, parsed, { name: name }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка на сервере при анализе резюме. Попробуйте ещё раз позже.' });
  }
});

app.get('/', (req, res) => {
  res.send('Resume analyzer API is running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
