const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');
const { google } = require('googleapis');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const CONFIG_PATH = path.join(__dirname, 'config.json');
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  // Override folder IDs from env vars if set (Railway Variables)
  if (process.env.WORK_FOLDER_ID) cfg.workFolderId = process.env.WORK_FOLDER_ID;
  if (process.env.EDU_FOLDER_ID)  cfg.eduFolderId  = process.env.EDU_FOLDER_ID;
  if (process.env.MASTER_NAME)    cfg.masterName   = process.env.MASTER_NAME;
  if (process.env.MASTER_CITY)    cfg.city         = process.env.MASTER_CITY;
  if (process.env.MASTER_PRICE)   cfg.price        = process.env.MASTER_PRICE;
  if (process.env.MASTER_TONE)    cfg.tone         = process.env.MASTER_TONE;
  return cfg;
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

async function getDriveImages(folderId) {
  if (!folderId) return [];
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}'),
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id,name,webViewLink)',
      pageSize: 50,
    });
    return (res.data.files || []).map(f => ({
      id: f.id,
      name: f.name,
      url: `https://drive.google.com/uc?export=view&id=${f.id}`,
      viewUrl: f.webViewLink,
    }));
  } catch (e) {
    console.error('Drive error:', e.message);
    return [];
  }
}

function pickRandom(arr) {
  if (!arr || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildPrompt(type, config, photoUrl) {
  const name = config.masterName || 'мастер';
  const city = config.city ? ` в ${config.city}` : '';
  const price = config.price ? ` Средняя цена: ${config.price}.` : '';
  const toneMap = {
    friendly: 'дружелюбный, как общение с подругой',
    pro: 'профессиональный и уверенный',
    warm: 'тёплый и уютный',
    playful: 'лёгкий и игривый',
  };
  const tone = toneMap[config.tone] || toneMap.friendly;
  const photoNote = photoUrl
    ? `\nК посту прикреплена ссылка на фото работы: ${photoUrl}\nОпиши работу с художественными деталями — технику, объём, эффект, ощущения клиента.`
    : '';

  const map = {
    slots: `Ты — ${name}, мастер по наращиванию ресниц${city}.${price} Напиши живой пост для Instagram/Telegram: объявление о свободных окошках для записи. Тон: ${tone}. Призыв написать в личку. 5–8 предложений, 5–7 эмодзи, хэштеги в конце. От первого лица.`,
    promo: `Ты — ${name}, мастер по наращиванию ресниц${city}.${price} Напиши пост-акцию: придумай конкретное предложение (скидка на первое посещение, бонус в будни и т.п.). Тон: ${tone}. 6–9 предложений, 5–7 эмодзи, хэштеги. От первого лица.`,
    edu: `Ты — ${name}, мастер по наращиванию ресниц${city}. Напиши познавательный пост: выбери одну полезную тему (уход за ресницами, разница техник, почему осыпаются, мифы). Тон: ${tone}. 7–10 предложений, 5–7 эмодзи, хэштеги. От первого лица.`,
    work: `Ты — ${name}, мастер по наращиванию ресниц${city}.${price} Напиши подпись к фото работы для Instagram/Telegram.${photoNote} Тон: ${tone}. 5–7 предложений, 5–7 эмодзи, хэштеги. От первого лица.`,
  };
  return map[type] || map.slots;
}

async function generatePost(type, config, photoUrl) {
  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: buildPrompt(type, config, photoUrl) }],
    max_tokens: 1000,
    temperature: 0.85,
  });
  return completion.choices[0]?.message?.content || '';
}

// ── REST API ──────────────────────────────────────────

app.get('/api/config', (req, res) => {
  const { googleServiceAccount, ...safe } = loadConfig();
  res.json(safe);
});

app.post('/api/config', (req, res) => {
  saveConfig({ ...loadConfig(), ...req.body });
  res.json({ ok: true });
});

app.post('/api/generate', async (req, res) => {
  try {
    const { type } = req.body;
    const config = loadConfig();
    let photoUrl = null;
    if (type === 'work' && config.workFolderId) {
      const img = pickRandom(await getDriveImages(config.workFolderId));
      if (img) photoUrl = img.url;
    } else if (type === 'edu' && config.eduFolderId) {
      const img = pickRandom(await getDriveImages(config.eduFolderId));
      if (img) photoUrl = img.url;
    }
    const text = await generatePost(type, config, photoUrl);
    res.json({ text, photoUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/photos/:folder', async (req, res) => {
  const config = loadConfig();
  const folderId = req.params.folder === 'work' ? config.workFolderId : config.eduFolderId;
  res.json(await getDriveImages(folderId));
});

// ── TELEGRAM BOT ──────────────────────────────────────

if (process.env.TELEGRAM_TOKEN) {
  const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
  const ALLOWED = (process.env.ALLOWED_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = id => !ALLOWED.length || ALLOWED.includes(String(id));

  const menu = {
    reply_markup: {
      keyboard: [
        [{ text: '📅 Свободные окошки' }, { text: '🏷 Акция' }],
        [{ text: '💡 Познавательный' }, { text: '📸 Показ работы' }],
        [{ text: '⚙️ Настройки' }],
      ],
      resize_keyboard: true,
    },
  };

  const typeMap = {
    '📅 Свободные окошки': 'slots',
    '🏷 Акция': 'promo',
    '💡 Познавательный': 'edu',
    '📸 Показ работы': 'work',
  };

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!ok(chatId)) return bot.sendMessage(chatId, 'Нет доступа.');
    const text = msg.text || '';

    if (text === '/start') return bot.sendMessage(chatId, '👋 Привет! Выбери тип поста:', menu);

    if (text === '⚙️ Настройки') {
      const cfg = loadConfig();
      return bot.sendMessage(chatId,
        `⚙️ *Настройки*\n\nИмя: ${cfg.masterName || '—'}\nГород: ${cfg.city || '—'}\nЦена: ${cfg.price || '—'}\nТон: ${cfg.tone || 'friendly'}\n\nКоманды:\n/setname Имя\n/setcity Город\n/setprice Цена\n/settone friendly|pro|warm|playful`,
        { parse_mode: 'Markdown' });
    }

    const cmds = { '/setname': 'masterName', '/setcity': 'city', '/setprice': 'price', '/settone': 'tone' };
    for (const [cmd, key] of Object.entries(cmds)) {
      if (text.startsWith(cmd + ' ')) {
        const cfg = loadConfig();
        cfg[key] = text.slice(cmd.length + 1).trim();
        saveConfig(cfg);
        return bot.sendMessage(chatId, `✅ Обновлено: ${cfg[key]}`);
      }
    }

    const postType = typeMap[text];
    if (postType) {
      await bot.sendMessage(chatId, '⏳ Генерирую...');
      try {
        const config = loadConfig();
        let photoUrl = null;
        if (postType === 'work' && config.workFolderId) {
          const img = pickRandom(await getDriveImages(config.workFolderId));
          if (img) photoUrl = img.url;
        } else if (postType === 'edu' && config.eduFolderId) {
          const img = pickRandom(await getDriveImages(config.eduFolderId));
          if (img) photoUrl = img.url;
        }
        const postText = await generatePost(postType, config, photoUrl);
        await bot.sendMessage(chatId, postText);
        if (photoUrl) await bot.sendMessage(chatId, `🖼 Фото: ${photoUrl}`);
      } catch (e) {
        await bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
      }
    }
  });

  console.log('Telegram bot started');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
