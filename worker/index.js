// Cloudflare Worker: принимает заявку из мини-приложения и пересылает её
// риелтору сообщением от бота. Секреты (токен бота, chat id) хранятся
// в настройках Worker, в репозитории их нет:
//   BOT_TOKEN   — токен бота от @BotFather
//   MANAGER_ID  — числовой id чата риелтора (куда присылать заявки)
//   ALLOWED_ORIGIN — адрес сайта, например https://jonieao25-create.github.io
//
// Второе дело Worker — отвечать боту (адрес /tg). На /start бот присылает
// кнопки под полем ввода, каждая открывает свой раздел мини-приложения.
//   WEBHOOK_SECRET — придуманный вами пароль (латиница и цифры), по нему
//                    Worker узнаёт, что сообщение пришло именно от Telegram
//   APP_URL        — адрес мини-приложения
//   MANAGER        — ваш ник в Telegram без @ (для кнопки «Связаться»)

const MAX_AGE_SEC = 24 * 60 * 60;

const enc = new TextEncoder();

async function hmac(key, data) {
  const k = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

const toHex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');

// Проверка подписи initData: подтверждает, что запрос пришёл из Telegram
async function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = await hmac(enc.encode('WebAppData'), botToken);
  const calc = toHex(await hmac(secret, check));
  if (calc !== hash) return null;
  const age = Math.floor(Date.now() / 1000) - Number(params.get('auth_date') || 0);
  if (!(age >= 0 && age <= MAX_AGE_SEC)) return null;
  try {
    return JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function reply(env, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(env) },
  });
}

// ---------- бот: кнопки под полем ввода ----------

function tgApi(env, method, body) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const CONTACT_BTN = '📞 Связаться';

// Клавиатура 2×2. Кнопка с web_app открывает мини-приложение
// сразу на нужном разделе (?section=... — id раздела из data.js).
function mainKeyboard(env) {
  const app = (section) => ({ web_app: { url: `${env.APP_URL}?section=${section}` } });
  return {
    keyboard: [
      [{ text: '🏢 Новостройки', ...app('newbuilds') }, { text: '🏡 Коттеджные посёлки', ...app('cottages') }],
      [{ text: '🌊 Квартиры в прибрежье', ...app('coast') }, { text: CONTACT_BTN }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

async function handleBotUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.chat) return;
  const text = msg.text || '';

  if (text === CONTACT_BTN) {
    await tgApi(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: `Напишите мне в Telegram: @${env.MANAGER}\nОтвечу и подберу варианты.`,
      reply_markup: mainKeyboard(env),
    });
    return;
  }

  // /start и любое другое сообщение — приветствие с кнопками
  await tgApi(env, 'sendMessage', {
    chat_id: msg.chat.id,
    text: 'Здравствуйте! Выберите, что вас интересует, кнопкой ниже 👇',
    reply_markup: mainKeyboard(env),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Сообщения от Telegram для бота
    if (url.pathname === '/tg') {
      if (request.method !== 'POST' ||
          request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      try {
        await handleBotUpdate(await request.json(), env);
      } catch (e) {
        // отвечаем 200 в любом случае, иначе Telegram будет слать то же сообщение снова
      }
      return new Response('ok');
    }

    // Один раз подключить бота к Worker: открыть в браузере
    //   https://<адрес worker>/setup?key=<WEBHOOK_SECRET>
    if (url.pathname === '/setup') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
        return new Response('wrong key', { status: 403 });
      }
      const r = await tgApi(env, 'setWebhook', {
        url: `${url.origin}/tg`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message'],
      });
      return new Response(await r.text(), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(env) });
    }
    if (request.method !== 'POST') return reply(env, 405, { ok: false });
    if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN) {
      return reply(env, 403, { ok: false });
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return reply(env, 400, { ok: false });
    }

    const user = await verifyInitData(String(data.initData || ''), env.BOT_TOKEN);
    if (!user) return reply(env, 401, { ok: false });

    const complex = clip(data.complex, 80);
    const room = clip(data.room, 60);
    const name = clip(data.name, 80);
    const phone = clip(data.phone, 30);
    if (!complex) return reply(env, 400, { ok: false });

    const who = user.username
      ? `@${esc(user.username)}`
      : `<a href="tg://user?id=${user.id}">${esc(user.first_name || 'клиент')}</a>`;

    const text = [
      '🏠 <b>Новая заявка</b>',
      `ЖК: <b>${esc(complex)}</b>`,
      room ? `Квартира: ${esc(room)}` : '',
      name ? `Имя: ${esc(name)}` : '',
      phone ? `Телефон: ${esc(phone)}` : 'Телефон: не указан',
      `Telegram: ${who}`,
    ]
      .filter(Boolean)
      .join('\n');

    const tg = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.MANAGER_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    return reply(env, tg.ok ? 200 : 502, { ok: tg.ok });
  },
};
