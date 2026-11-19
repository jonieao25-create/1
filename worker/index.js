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
//
// Третье дело — бот-секретарь (Telegram для бизнеса → Автоматизация чатов).
// Бот отвечает клиентам в ваших личных чатах от вашего имени:
//   • новому клиенту на первое сообщение (в любое время); «новый» — тот,
//     с кем не было переписки последние 20 дней;
//   • любому клиенту с 20:00 до 7:00 по Калининграду;
//   • одному человеку не чаще раза в сутки.
// После ответа бот присылает вам уведомление.
//   REPLIES     — хранилище KV (Cloudflare → Storage → KV), привязанное к Worker
//                 под этим именем: бот помнит, кому уже отвечал
//   BOT_LINK    — ссылка, которую открывает кнопка «Открыть каталог»
//
// Четвёртое дело — статистика заходов (адрес /stat). Приложение сообщает,
// когда человек его открыл, какой раздел и какой ЖК смотрел. Хранится в том же
// KV REPLIES, по одной записи на день (живёт 40 дней). Команда /stats в боте
// присылает сводку, отвечает только риелтору (MANAGER_ID). Его заходы не считаем.

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

// Клавиатура: разделы 2×2 и широкая зелёная «Связаться» внизу.
// Кнопка с web_app открывает мини-приложение сразу на нужном разделе
// (?section=... — id раздела из data.js). style:'success' — зелёная кнопка
// (Telegram даёт только 3 цвета: success — зелёный, primary — синий, danger — красный).
function mainKeyboard(env) {
  const app = (section) => ({ web_app: { url: `${env.APP_URL}?section=${section}` } });
  return {
    keyboard: [
      [{ text: '🏢 Новостройки', ...app('newbuilds') }, { text: '🏡 Коттеджные посёлки', ...app('cottages') }],
      [{ text: '🌊 ЖК на Побережье', ...app('coast') }, { text: '🔑 Вторичка', ...app('resale') }],
      [{ text: CONTACT_BTN, style: 'success' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

async function handleBotUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.chat) return;
  const text = msg.text || '';

  if (/^\/stats\b/.test(text) && msg.from && String(msg.from.id) === String(env.MANAGER_ID)) {
    await tgApi(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: await statsReport(env),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return;
  }

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

// ---------- бот-секретарь ----------

const NIGHT_FROM = 20; // с 20:00
const NIGHT_TO = 7;    // до 7:00
const TZ_OFFSET = 2;   // Калининград: UTC+2 (летнего времени нет)
const DAY_SEC = 24 * 60 * 60;
const NEW_AFTER_SEC = 20 * DAY_SEC; // молчал 20 дней — снова «новый клиент»

const SECRETARY_TEXT =
  'Здравствуйте! Я Евгений, риелтор по новостройкам Калининграда. ' +
  'Сейчас не могу ответить, напишу вам в ближайшее время. ' +
  'А пока можете посмотреть каталог ЖК и коттеджных посёлков 👇';

function isNight() {
  const hour = (new Date().getUTCHours() + TZ_OFFSET) % 24;
  return hour >= NIGHT_FROM || hour < NIGHT_TO;
}

// Подключение принадлежит именно Евгению? Иначе любой мог бы подключить
// этого бота к своему аккаунту и рассылать наш текст от своего имени.
async function isOwnConnection(id, env) {
  const key = `conn:${id}`;
  const saved = await env.REPLIES.get(key);
  if (saved) return saved === '1';
  const r = await tgApi(env, 'getBusinessConnection', { business_connection_id: id });
  const data = await r.json().catch(() => ({}));
  const ok = data.ok && String(data.result.user.id) === String(env.MANAGER_ID);
  await env.REPLIES.put(key, ok ? '1' : '0', { expirationTtl: DAY_SEC });
  return ok;
}

async function handleBusinessMessage(msg, env) {
  if (!env.REPLIES || !msg.chat || !msg.from || msg.from.is_bot) return;
  if (msg.chat.type !== 'private') return;
  if (!(await isOwnConnection(msg.business_connection_id, env))) return;

  const seenKey = `seen:${msg.chat.id}`;
  const lastKey = `last:${msg.chat.id}`;

  // Любое сообщение в чате (клиента или Евгения) продлевает «знакомство» на 20 дней
  const isNew = !(await env.REPLIES.get(seenKey));
  await env.REPLIES.put(seenKey, '1', { expirationTtl: NEW_AFTER_SEC });

  // Пишет сам Евгений: только запоминаем, что с этим человеком общались
  if (String(msg.from.id) === String(env.MANAGER_ID)) return;

  if (!isNew && !isNight()) return;
  if (await env.REPLIES.get(lastKey)) return; // уже отвечали за последние сутки

  const sent = await tgApi(env, 'sendMessage', {
    business_connection_id: msg.business_connection_id,
    chat_id: msg.chat.id,
    text: SECRETARY_TEXT,
    reply_markup: {
      inline_keyboard: [[{ text: '🏠 Открыть каталог', url: env.BOT_LINK }]],
    },
  });
  if (!sent.ok) return;
  await env.REPLIES.put(lastKey, '1', { expirationTtl: DAY_SEC });

  const u = msg.from;
  const name = esc([u.first_name, u.last_name].filter(Boolean).join(' ') || 'клиент');
  const who = u.username ? `${name} (@${esc(u.username)})` : `<a href="tg://user?id=${u.id}">${name}</a>`;
  await tgApi(env, 'sendMessage', {
    chat_id: env.MANAGER_ID,
    text: `🤖 Бот-секретарь ответил: ${who}\n` +
      (isNew ? 'Причина: новый клиент' : 'Причина: нерабочее время (20:00–7:00)'),
    parse_mode: 'HTML',
  });
}

// ---------- статистика заходов ----------

const STAT_TTL = 40 * DAY_SEC;
const MAX_NAMES = 60; // сколько разных ЖК/разделов храним в одном дне

// Дата по Калининграду: 2026-10-29
function kldDate(ms) {
  return new Date(ms + TZ_OFFSET * 3600 * 1000).toISOString().slice(0, 10);
}

function kldTime(ms) {
  return new Date(ms + TZ_OFFSET * 3600 * 1000).toISOString().slice(11, 16);
}

// Запись дня: o — открытий; s/c — разделы и ЖК { id: { n: название, k: сколько } };
// p — люди { id: { n: имя, u: ник, t: время, w: что смотрел последним } }
async function loadDay(env, date) {
  const raw = await env.REPLIES.get(`stats:${date}`);
  try {
    return raw ? JSON.parse(raw) : { o: 0, s: {}, c: {}, p: {} };
  } catch {
    return { o: 0, s: {}, c: {}, p: {} };
  }
}

function bump(map, id, name) {
  if (!map[id] && Object.keys(map).length >= MAX_NAMES) return;
  const it = map[id] || (map[id] = { n: name, k: 0 });
  it.n = name || it.n;
  it.k += 1;
}

async function handleStat(data, user, env) {
  if (!env.REPLIES || String(user.id) === String(env.MANAGER_ID)) return;
  const ev = data.ev;
  const id = clip(data.id, 40).replace(/[^A-Za-z0-9_-]/g, '');
  const name = clip(data.name, 80);
  if (!['open', 'section', 'view'].includes(ev)) return;

  const now = Date.now();
  const date = kldDate(now);
  const day = await loadDay(env, date);

  let what = '';
  if (ev === 'open') day.o += 1;
  if (id && name && (ev === 'open' || ev === 'section')) {
    bump(day.s, id, name);
    what = `раздел «${name}»`;
  }
  if (id && name && ev === 'view') {
    bump(day.c, id, name);
    what = `смотрел(а) «${name}»`;
  }

  const p = day.p[user.id] || (day.p[user.id] = {});
  p.n = clip([user.first_name, user.last_name].filter(Boolean).join(' '), 60);
  p.u = clip(user.username, 40);
  p.t = now;
  if (what) p.w = what;

  await env.REPLIES.put(`stats:${date}`, JSON.stringify(day), { expirationTtl: STAT_TTL });
}

// 1 открытие, 2 открытия, 5 открытий
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

function top(maps, n) {
  const sum = {};
  for (const m of maps) {
    for (const [id, it] of Object.entries(m)) {
      const s = sum[id] || (sum[id] = { n: it.n, k: 0 });
      s.k += it.k;
    }
  }
  return Object.values(sum).sort((a, b) => b.k - a.k).slice(0, n);
}

async function statsReport(env) {
  if (!env.REPLIES) return 'Статистика не подключена: нет хранилища REPLIES.';
  const now = Date.now();
  const days = await Promise.all(
    [...Array(30).keys()].map((i) => loadDay(env, kldDate(now - i * DAY_SEC * 1000))));

  const period = (n) => {
    const part = days.slice(0, n);
    const opens = part.reduce((a, d) => a + d.o, 0);
    const people = new Set(part.flatMap((d) => Object.keys(d.p))).size;
    return `${opens} ${plural(opens, 'открытие', 'открытия', 'открытий')} · ${people} ${plural(people, 'человек', 'человека', 'человек')}`;
  };

  const lines = [
    '📊 <b>Статистика приложения</b>',
    '',
    `Сегодня: ${period(1)}`,
    `За 7 дней: ${period(7)}`,
    `За 30 дней: ${period(30)}`,
  ];

  const complexes = top(days.map((d) => d.c), 5);
  if (complexes.length) {
    lines.push('', '🏆 <b>Чаще смотрели (30 дней):</b>');
    complexes.forEach((it, i) => lines.push(`${i + 1}. ${esc(it.n)} — ${it.k}`));
  }

  const sections = top(days.map((d) => d.s), 10);
  if (sections.length) {
    lines.push('', '📂 Разделы: ' + sections.map((it) => `${esc(it.n)} ${it.k}`).join(' · '));
  }

  // последние посетители за сегодня и вчера
  const seen = {};
  for (const d of days.slice(0, 2)) {
    for (const [id, p] of Object.entries(d.p)) {
      if (!seen[id] || seen[id].t < p.t) seen[id] = { ...p, id };
    }
  }
  const recent = Object.values(seen).sort((a, b) => b.t - a.t).slice(0, 5);
  if (recent.length) {
    lines.push('', '👤 <b>Последние посетители:</b>');
    const today = kldDate(now);
    for (const p of recent) {
      const name = esc(p.n || 'клиент');
      const who = p.u ? `${name} (@${esc(p.u)})` : `<a href="tg://user?id=${p.id}">${name}</a>`;
      const when = (kldDate(p.t) === today ? '' : 'вчера ') + kldTime(p.t);
      lines.push(`• ${who}, ${when}${p.w ? ', ' + esc(p.w) : ''}`);
    }
  }

  if (!days.some((d) => d.o || Object.keys(d.p).length)) {
    lines.push('', 'Пока заходов нет: счёт идёт с момента включения статистики.');
  }
  return lines.join('\n');
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
        const update = await request.json();
        if (update.business_message) await handleBusinessMessage(update.business_message, env);
        else await handleBotUpdate(update, env);
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
        allowed_updates: ['message', 'business_message'],
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

    // Приложение сообщает о заходе (не заявка)
    if (url.pathname === '/stat') {
      try {
        await handleStat(data, user, env);
      } catch (e) {
        // статистика не должна мешать работе приложения
      }
      return reply(env, 200, { ok: true });
    }

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
