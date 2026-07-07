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

// Некоторые PDF (особенно экспортированные из Canva и подобных дизайн-инструментов)
// не содержат корректной Unicode-разметки шрифта — pdf-parse извлекает "кракозябры".
// Эта проверка отличает нормальный текст от нечитаемого набора символов.
function isLikelyGarbled(str) {
  const cleaned = str.replace(/\s/g, '');
  if (cleaned.length < 20) return true;
  const goodChars = (cleaned.match(/[a-zA-Zа-яА-ЯёЁ0-9.,;:!?()@+\-]/g) || []).length;
  const ratio = goodChars / cleaned.length;
  return ratio < 0.6;
}

function buildPrompt(text) {
  const today = new Date();
  const todayStr = today.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

  return `Ты — опытный HR-консультант, специализируешься на упаковке резюме руководителей и специалистов для российского рынка труда (hh.ru). Анализируешь резюме по методологии курса «Как создать сильное резюме»:

МЕТОДОЛОГИЯ ОЦЕНКИ:
1. ATS / поисковая выдача hh.ru: ключевые слова — критически важный фактор. Основной «вес» по ключевым словам приходится на заголовок «Желаемая должность» и названия должностей в опыте. Названия должностей должны быть общепринятыми и стандартными («Директор по продажам», а не «Гуру коммерции»). Ключевые слова должны быть в разделах «Опыт», «Навыки», желательно в русско- и англоязычных вариантах. Переспам ключевых слов — тоже ошибка.
2. Достижения по формуле «Задача + Действие + Результат» (методика STAR: Situation, Task, Action, Result): нужны глаголы действия («увеличил», «разработал», «запустил»), результат должен быть подтверждён цифрами, %, сроками, влиянием на бизнес. Пример сильной формулировки: «Увеличил долю рынка на 15% за 2 года и оборот отдела на 25% (с 500 млн до 625 млн руб.)». Достижения, а не обязанности.
3. Правило первого экрана: самая важная информация — в начале. Блок «Ключевые компетенции» (Summary/УТП кандидата) должен быть на первой странице в крайнем опыте работы: масштаб, ценность, ключевые цифры совокупного опыта.
4. Для руководителей — управленческий масштаб: количество подчинённых, размер бюджета, масштаб проектов, KPI и рост направления, примеры лидерства, стратегический вклад.
5. Читаемость и «воздух»: рекрутер сканирует резюме ~10 секунд. Нужны смысловые блоки с названиями, маркированные списки, пустые строки между блоками, отсутствие «воды».
6. Структура: заголовок и чёткое позиционирование, опыт через результаты, релевантные навыки, образование, рекомендации, цифровой профиль.

Сегодняшняя дата: ${todayStr}. Используй её, чтобы корректно оценивать даты в резюме — не считай ошибкой дату, которая уже прошла или продолжается по сегодняшний день. Ошибкой считай только даты, которые действительно позже сегодняшней.

Проанализируй резюме ниже и верни ТОЛЬКО валидный JSON — без единого слова до или после него, без markdown-обрамления (без \`\`\`), без пояснений. Первый символ ответа — "{", последний — "}".

Формат:
{
  "score": число 0-100 (общая оценка),
  "summary": "1-2 коротких предложения общего вывода",
  "metrics": {
    "ats": число 0-100 (вероятность прохождения ATS-фильтров и поисковой выдачи hh.ru: ключевые слова в заголовке и должностях, стандартные названия, семантика),
    "readability": число 0-100 (читаемость за 10 секунд: структура, смысловые блоки, маркеры, «воздух», первый экран),
    "achievements": число 0-100 (достижения по STAR: глаголы действия, цифры, результаты вместо обязанностей),
    "scale": число 0-100 (управленческий/профессиональный масштаб: команда, бюджеты, KPI, ценность для бизнеса)
  },
  "keywords": {
    "found": ["сильное ключевое слово из резюме 1", "слово 2"],
    "missing": ["важное для этой роли ключевое слово, которого не хватает 1", "слово 2"]
  },
  "strengths": ["сильная сторона 1", "сильная сторона 2"],
  "weaknesses": ["слабое место 1", "слабое место 2"],
  "recommendations": ["конкретная рекомендация 1", "конкретная рекомендация 2"]
}

В keywords.found укажи 3-6 реальных ключевых слов/навыков, которые уже есть в резюме и работают на поисковую выдачу. В keywords.missing — 3-6 ключевых слов, которые стоит добавить исходя из желаемой должности кандидата (определи её из заголовка или последнего опыта).
Дай от 3 до 5 пунктов в strengths / weaknesses / recommendations. Каждый пункт — не длиннее одного короткого предложения (до 15-18 слов).
В рекомендациях опирайся на методологию выше: формула «Задача + Действие + Результат», перенос ключевых слов в заголовок, блок «Ключевые компетенции» на первый экран, метрики масштаба. Ссылайся на реальные формулировки из резюме, а не на общие советы.

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
      if (isLikelyGarbled(text)) {
        return res.status(400).json({
          error: 'Не удалось корректно прочитать текст из этого файла — вероятно, из-за нестандартных шрифтов в PDF (так часто бывает с резюме, сделанными в Canva или похожих конструкторах). Пожалуйста, вставьте текст резюме вручную в поле ниже — так мы точно сможем его проанализировать.'
        });
      }
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
      max_tokens: 3000,
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
