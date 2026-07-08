// BluePay Gateway Worker - final single-file version
// Features: Telegram bot, Telegram Mini App, Merchant API, D1 auto migrations,
// payment links, withdrawals, API docs, Blupal webhook, seller webhooks.

let SCHEMA_READY = false;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    try {
      if (request.method === "OPTIONS") return json({ ok: true });

      if (url.pathname === "/health") {
        await ensureSchema(env);
        return json({ ok: true, service: "BluePay Gateway", time: nowIso(), schema_version: SCHEMA_VERSION });
      }

      if (url.pathname === "/install") return installDatabase(request, env);

      if (url.pathname === "/setup") {
        await ensureSchema(env);
        return setupTelegram(request, env);
      }

      if (url.pathname === "/docs") return docsPage(env);
      if (url.pathname === "/" || url.pathname === "/return") return returnPage(env);
      if (url.pathname === "/app") return miniAppPage(env);

      if (url.pathname === "/api/app/me") { await ensureSchema(env); return appMe(request, env); }
      if (url.pathname === "/api/app/register") { await ensureSchema(env); return appRegister(request, env); }
      if (url.pathname === "/api/app/create-link") { await ensureSchema(env); return appCreateLink(request, env); }
      if (url.pathname === "/api/app/api-reset") { await ensureSchema(env); return appApiReset(request, env); }
      if (url.pathname === "/api/app/save-webhook") { await ensureSchema(env); return appSaveWebhook(request, env); }
      if (url.pathname === "/api/app/withdraw") { await ensureSchema(env); return appWithdraw(request, env); }
      if (url.pathname === "/api/app/withdrawals") { await ensureSchema(env); return appWithdrawals(request, env); }

      if (url.pathname === "/api/v1/payment/create") { await ensureSchema(env); return apiV1CreatePayment(request, env); }
      if (url.pathname === "/api/v1/payment/verify") { await ensureSchema(env); return apiV1VerifyPayment(request, env); }

      if (url.pathname.startsWith("/pay/")) { await ensureSchema(env); return publicPaymentPage(request, env); }
      if (url.pathname === "/api/payment/create") { await ensureSchema(env); return apiCreatePaymentInvoice(request, env); }
      if (url.pathname === "/api/payment/status") { await ensureSchema(env); return publicPaymentStatus(request, env); }

      if (url.pathname === "/telegram") { await ensureSchema(env); return telegramWebhook(request, env, ctx); }
      if (url.pathname.startsWith("/blupal-webhook/")) { await ensureSchema(env); return blupalWebhook(request, env, ctx); }

      return json({ ok: false, error: "not_found" }, 404);
    } catch (err) {
      console.error("Worker Error:", err);
      return json({ ok: false, error: "server_error", message: String(err?.message || err) }, 500);
    }
  },
};

const BLUPAL_BASE_URL = "https://blupal.net/api";
const SCHEMA_VERSION = "2026-07-09-v11-miniapp-fast-sync";

/* =========================
   Database
========================= */

const BASE_TABLES = [
  `CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS sellers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL UNIQUE,
    username TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    balance_rial INTEGER NOT NULL DEFAULT 0,
    total_sales_rial INTEGER NOT NULL DEFAULT 0,
    total_fee_rial INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS payment_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    seller_id INTEGER NOT NULL,
    amount_rial INTEGER NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at TEXT NOT NULL,
    updated_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER UNIQUE,
    link_id INTEGER NOT NULL DEFAULT 0,
    seller_id INTEGER NOT NULL,
    amount_rial INTEGER NOT NULL,
    final_amount_rial INTEGER,
    fee_rial INTEGER NOT NULL DEFAULT 0,
    net_rial INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PENDING',
    payment_link TEXT,
    card_number TEXT,
    customer_ip TEXT,
    created_at TEXT NOT NULL,
    paid_at TEXT,
    verified_by TEXT,
    webhook_payload TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount_rial INTEGER NOT NULL,
    balance_after_rial INTEGER NOT NULL,
    reference_type TEXT,
    reference_id TEXT,
    description TEXT,
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER NOT NULL,
    amount_rial INTEGER NOT NULL,
    card_number TEXT NOT NULL,
    card_holder TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL,
    settled_at TEXT,
    rejected_at TEXT,
    admin_id TEXT,
    admin_note TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS bot_states (
    telegram_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    data TEXT,
    expires_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER,
    event TEXT,
    payload TEXT,
    created_at TEXT NOT NULL
  )`,
];

const MIGRATIONS = [
  `ALTER TABLE sellers ADD COLUMN api_key TEXT`,
  `ALTER TABLE sellers ADD COLUMN api_secret TEXT`,
  `ALTER TABLE sellers ADD COLUMN api_enabled INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE sellers ADD COLUMN default_webhook_url TEXT`,
  `ALTER TABLE sellers ADD COLUMN default_callback_url TEXT`,

  `ALTER TABLE payments ADD COLUMN public_payment_id TEXT`,
  `ALTER TABLE payments ADD COLUMN order_id TEXT`,
  `ALTER TABLE payments ADD COLUMN customer_name TEXT`,
  `ALTER TABLE payments ADD COLUMN customer_mobile TEXT`,
  `ALTER TABLE payments ADD COLUMN callback_url TEXT`,
  `ALTER TABLE payments ADD COLUMN webhook_url TEXT`,
  `ALTER TABLE payments ADD COLUMN api_created INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE payments ADD COLUMN seller_webhook_sent INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE payments ADD COLUMN seller_webhook_attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE payments ADD COLUMN seller_webhook_last_error TEXT`,
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_sellers_telegram_id ON sellers(telegram_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sellers_api_key ON sellers(api_key)`,
  `CREATE INDEX IF NOT EXISTS idx_payment_links_token ON payment_links(token)`,
  `CREATE INDEX IF NOT EXISTS idx_payment_links_seller ON payment_links(seller_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_public_payment_id ON payments(public_payment_id)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_seller ON payments(seller_id)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(seller_id, order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_seller ON ledger(seller_id)`,
  `CREATE INDEX IF NOT EXISTS idx_withdrawals_seller ON withdrawals(seller_id)`,
  `CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status)`,
];

async function ensureSchema(env) {
  needDB(env);
  if (SCHEMA_READY) return;

  try {
    const row = await env.DB.prepare(`SELECT value FROM app_meta WHERE key=?`).bind("schema_version").first();
    if (row?.value === SCHEMA_VERSION) {
      SCHEMA_READY = true;
      return;
    }
  } catch (_) {}

  for (const sql of BASE_TABLES) await env.DB.prepare(sql).run();
  for (const sql of MIGRATIONS) { try { await env.DB.prepare(sql).run(); } catch (_) {} }
  for (const sql of INDEXES) { try { await env.DB.prepare(sql).run(); } catch (_) {} }

  await env.DB.prepare(
    `INSERT INTO app_meta (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).bind("schema_version", SCHEMA_VERSION, nowIso()).run();

  SCHEMA_READY = true;
}

async function installDatabase(request, env) {
  need(env, ["ADMIN_SECRET"]);
  needDB(env);
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== env.ADMIN_SECRET) return json({ ok: false, error: "forbidden" }, 403);
  SCHEMA_READY = false;
  await ensureSchema(env);
  return json({ ok: true, message: "Database installed successfully", database_name: "bluepay_gateway_db", binding_name: "DB", schema_version: SCHEMA_VERSION });
}

/* =========================
   Helpers
========================= */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-API-Key,Authorization",
    },
  });
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function need(env, keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) throw new Error("Missing env vars: " + missing.join(", "));
}

function needDB(env) {
  if (!env.DB) throw new Error("D1 binding با نام DB تنظیم نشده است");
}

function nowIso() { return new Date().toISOString(); }
function baseUrl(env) { return String(env.PUBLIC_URL || "https://bluepal.hazhanhasani4268.workers.dev").replace(/\/+$/, ""); }
function botUsername(env) { return String(env.BOT_USERNAME || "Bluepaymentrbot").replace(/^@+/, "").trim(); }
function adminIds(env) { return String(env.ADMIN_CHAT_IDS || env.ADMIN_CHAT_ID || "").split(",").map((x) => x.trim()).filter(Boolean); }
function isAdmin(env, telegramId) { return adminIds(env).includes(String(telegramId)); }

function esc(v = "") {
  return String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function fmt(n) { return Number(n || 0).toLocaleString("en-US"); }
function rialToToman(rial) { return Math.floor(Number(rial || 0) / 10); }
function tomanToRial(toman) { return Number(toman || 0) * 10; }

function normalizeDigits(input = "") {
  const fa = "۰۱۲۳۴۵۶۷۸۹";
  const ar = "٠١٢٣٤٥٦٧٨٩";
  return String(input).replace(/[۰-۹]/g, (d) => fa.indexOf(d)).replace(/[٠-٩]/g, (d) => ar.indexOf(d));
}

function extractNumber(text = "") {
  const match = normalizeDigits(text).match(/[0-9][0-9,\s.]*/);
  if (!match) return null;
  const raw = match[0].replace(/[^\d]/g, "");
  return raw ? Number(raw) : null;
}

function parseAmountToman(text = "") {
  const n = extractNumber(text);
  if (!n || !Number.isFinite(n)) return null;
  const t = normalizeDigits(text).toLowerCase();
  const isRial = t.includes("ریال") || t.includes("rial") || t.includes("irr");
  return isRial ? Math.floor(n / 10) : n;
}

function randomToken(len = 32) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

function shortToken(len = 14) { return randomToken(len); }
function generateApiKey() { return "bp_live_" + randomToken(36); }
function generateApiSecret() { return "bps_" + randomToken(48); }
function generatePaymentId() { return "pay_" + randomToken(22); }

function statusFa(status) {
  const map = { ACTIVE: "فعال", DISABLED: "غیرفعال", PENDING: "در انتظار پرداخت", PAID: "پرداخت شده", EXPIRED: "منقضی شده", CANCELED: "لغو شده", SETTLED: "تسویه شده", REJECTED: "رد شده" };
  return map[status] || status || "نامشخص";
}

function getFeeRial(env, amountRial) {
  const percent = Number(env.FEE_PERCENT || 3);
  const fixed = Number(env.FEE_FIXED_RIAL || 0);
  return Math.max(0, Math.floor((Number(amountRial) * percent) / 100) + fixed);
}

function minWithdrawRial(env) { return tomanToRial(Number(env.MIN_WITHDRAW_TOMAN || 50000)); }

function isValidUrl(value, allowEmpty = true) {
  if (!value && allowEmpty) return true;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch (_) { return false; }
}

/* =========================
   Telegram API
========================= */

async function tg(env, method, payload) {
  need(env, ["BOT_TOKEN"]);
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) console.error("Telegram API Error:", method, data);
  return data;
}

async function sendMessage(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
}

async function answerCallback(env, id, text = "") {
  return tg(env, "answerCallbackQuery", { callback_query_id: id, text, show_alert: false });
}

/* =========================
   Setup Telegram
========================= */

async function setupTelegram(request, env) {
  need(env, ["BOT_TOKEN", "TELEGRAM_SECRET", "ADMIN_SECRET", "BLUPAL_WEBHOOK_SECRET"]);
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== env.ADMIN_SECRET) return json({ ok: false, error: "forbidden" }, 403);

  const base = baseUrl(env);
  const webhook = await tg(env, "setWebhook", {
    url: `${base}/telegram`,
    secret_token: env.TELEGRAM_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });

  const commands = await tg(env, "setMyCommands", {
    commands: [
      { command: "start", description: "شروع و منوی اصلی" },
      { command: "cancel", description: "لغو عملیات فعلی" },
      { command: "help", description: "راهنما" },
    ],
  });

  const menuButton = await tg(env, "setChatMenuButton", {
    menu_button: { type: "web_app", text: "درگاه من", web_app: { url: `${base}/app` } },
  });

  return json({
    ok: true,
    telegram_webhook: webhook,
    telegram_commands: commands,
    telegram_menu_button: menuButton,
    telegram_webhook_url: `${base}/telegram`,
    mini_app_url: `${base}/app`,
    docs_url: `${base}/docs`,
    blupal_webhook_url: `${base}/blupal-webhook/${env.BLUPAL_WEBHOOK_SECRET}`,
    return_url: `${base}/return`,
    schema_version: SCHEMA_VERSION,
  });
}

/* =========================
   Telegram Webhook
========================= */

async function telegramWebhook(request, env, ctx) {
  need(env, ["TELEGRAM_SECRET"]);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_SECRET) return json({ ok: false, error: "unauthorized" }, 401);
  const update = await request.json().catch(() => null);
  if (!update) return json({ ok: false, error: "bad_json" }, 400);
  ctx.waitUntil(processUpdate(update, env));
  return json({ ok: true });
}

async function processUpdate(update, env) {
  if (update.callback_query) return handleCallback(update.callback_query, env);
  if (update.message) return handleMessage(update.message, env);
}

/* =========================
   Bot State
========================= */

async function setState(env, telegramId, state, data = {}, ttlSeconds = 900) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  await env.DB.prepare(
    `INSERT INTO bot_states (telegram_id, state, data, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET state=excluded.state, data=excluded.data, expires_at=excluded.expires_at`
  ).bind(String(telegramId), state, JSON.stringify(data), expires).run();
}

async function getState(env, telegramId) {
  const row = await env.DB.prepare(`SELECT * FROM bot_states WHERE telegram_id=?`).bind(String(telegramId)).first();
  if (!row) return null;
  if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) { await clearState(env, telegramId); return null; }
  let data = {};
  try { data = JSON.parse(row.data || "{}"); } catch (_) {}
  return { state: row.state, data };
}

async function clearState(env, telegramId) {
  await env.DB.prepare(`DELETE FROM bot_states WHERE telegram_id=?`).bind(String(telegramId)).run();
}

/* =========================
   Seller DB
========================= */

async function getSellerByTelegram(env, telegramId) {
  return env.DB.prepare(`SELECT * FROM sellers WHERE telegram_id=?`).bind(String(telegramId)).first();
}

async function getSellerById(env, sellerId) {
  return env.DB.prepare(`SELECT * FROM sellers WHERE id=?`).bind(Number(sellerId)).first();
}

async function getSellerByApiKey(env, apiKey) {
  if (!apiKey) return null;
  return env.DB.prepare(`SELECT * FROM sellers WHERE api_key=? AND api_enabled=1 AND status='ACTIVE'`).bind(String(apiKey)).first();
}

async function createSeller(env, user, title) {
  const createdAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO sellers (telegram_id, username, title, status, balance_rial, api_key, api_secret, api_enabled, created_at)
     VALUES (?, ?, ?, 'ACTIVE', 0, ?, ?, 1, ?)`
  ).bind(String(user.id), user.username || null, title, generateApiKey(), generateApiSecret(), createdAt).run();
  return getSellerByTelegram(env, user.id);
}

async function ensureSellerApi(env, seller) {
  if (seller.api_key && seller.api_secret) return seller;
  const apiKey = generateApiKey();
  const apiSecret = generateApiSecret();
  await env.DB.prepare(`UPDATE sellers SET api_key=?, api_secret=?, api_enabled=1, updated_at=? WHERE id=?`).bind(apiKey, apiSecret, nowIso(), seller.id).run();
  return getSellerById(env, seller.id);
}

async function resetSellerApi(env, sellerId) {
  const apiKey = generateApiKey();
  const apiSecret = generateApiSecret();
  await env.DB.prepare(`UPDATE sellers SET api_key=?, api_secret=?, api_enabled=1, updated_at=? WHERE id=?`).bind(apiKey, apiSecret, nowIso(), sellerId).run();
  return getSellerById(env, sellerId);
}

async function addLedger(env, sellerId, type, amountRial, balanceAfter, refType, refId, description) {
  await env.DB.prepare(
    `INSERT INTO ledger (seller_id, type, amount_rial, balance_after_rial, reference_type, reference_id, description, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(Number(sellerId), type, Number(amountRial), Number(balanceAfter), refType || null, refId || null, description || null, nowIso()).run();
}

/* =========================
   Keyboards
========================= */

function appUrl(env) { return `${baseUrl(env)}/app`; }

function guestKeyboard(env) {
  return { reply_markup: { inline_keyboard: [
    [{ text: "💎 ورود به مینی‌اپ", web_app: { url: appUrl(env) } }],
    [{ text: "🛍 ثبت‌نام فروشنده", callback_data: "seller_register" }],
    [{ text: "📘 راهنما", callback_data: "help" }],
  ] } };
}

function sellerKeyboard(env) {
  return { reply_markup: { inline_keyboard: [
    [{ text: "💎 ورود به مینی‌اپ", web_app: { url: appUrl(env) } }],
    [{ text: "💳 ساخت لینک پرداخت", callback_data: "seller_create_link" }],
    [{ text: "🔑 API فروشگاهی", callback_data: "seller_api_panel" }, { text: "📊 موجودی من", callback_data: "seller_balance" }],
    [{ text: "💸 درخواست برداشت", callback_data: "seller_withdraw" }, { text: "📄 تراکنش‌ها", callback_data: "seller_transactions" }],
    [{ text: "👤 پروفایل", callback_data: "seller_profile" }, { text: "📘 راهنما", callback_data: "help" }],
  ] } };
}

function apiPanelKeyboard() {
  return { reply_markup: { inline_keyboard: [
    [{ text: "🔄 ساخت API Key جدید", callback_data: "seller_api_reset" }],
    [{ text: "🌐 تنظیم Webhook پیش‌فرض", callback_data: "seller_set_webhook" }],
    [{ text: "↩️ برگشت", callback_data: "home" }],
  ] } };
}

function adminKeyboard() {
  return { reply_markup: { inline_keyboard: [
    [{ text: "💸 درخواست‌های برداشت", callback_data: "admin_withdrawals" }],
    [{ text: "📊 آمار کلی", callback_data: "admin_stats" }],
  ] } };
}

function withdrawalAdminKeyboard(id) {
  return { reply_markup: { inline_keyboard: [[
    { text: "✅ تسویه شد", callback_data: `admin_settle:${id}` },
    { text: "❌ رد درخواست", callback_data: `admin_reject:${id}` },
  ]] } };
}

/* =========================
   Bot Messages
========================= */

async function sendHome(env, chatId, user) {
  const seller = await getSellerByTelegram(env, user.id);
  const title = esc(env.BOT_TITLE || "BluePay | درگاه واسط");

  if (!seller) {
    await sendMessage(env, chatId, `<b>💙 ${title}</b>\n\nسلام 👋\n\nاین ربات یک درگاه واسط برای فروشندگان خدماتی است.\n\n<b>امکانات فروشنده:</b>\n• ساخت لینک پرداخت اختصاصی\n• دریافت API Key فروشگاهی\n• اتصال سایت، ربات یا اپ به API پرداخت\n• افزایش موجودی پس از پرداخت موفق\n• درخواست برداشت موجودی\n\nبرای شروع، ثبت‌نام فروشنده را بزن.`, guestKeyboard(env));
    if (isAdmin(env, user.id)) return sendMessage(env, chatId, "مدیریت ادمین:", adminKeyboard());
    return;
  }

  await sendMessage(env, chatId, `<b>💙 ${title}</b>\n\nخوش آمدی، <b>${esc(seller.title)}</b>\n\n<b>موجودی قابل برداشت:</b>\n<code>${fmt(rialToToman(seller.balance_rial))}</code> تومان\n\nاز منوی زیر استفاده کن.`, sellerKeyboard(env));
  if (isAdmin(env, user.id)) return sendMessage(env, chatId, "مدیریت ادمین:", adminKeyboard());
}

async function sendHelp(env, chatId) {
  return sendMessage(env, chatId, `<b>📘 راهنمای درگاه واسط</b>\n\n<b>فروشنده:</b> ثبت‌نام می‌کند، لینک پرداخت می‌سازد یا API Key می‌گیرد.\n\n<b>API فروشگاهی:</b> با API می‌توانی سایت، ربات یا اپ خودت را به درگاه وصل کنی.\n\n<b>ساخت سفارش API:</b>\n<code>POST /api/v1/payment/create</code>\n\n<b>بررسی سفارش:</b>\n<code>GET /api/v1/payment/verify</code>\n\n<b>مستندات:</b>\n${baseUrl(env)}/docs\n\n<b>کارمزد فعلی:</b>\n${esc(env.FEE_PERCENT || "3")} درصد`);
}

async function sendSellerApiPanel(env, chatId, telegramId) {
  let seller = await getSellerByTelegram(env, telegramId);
  if (!seller) return sendMessage(env, chatId, "ابتدا باید فروشنده ثبت‌نام کنی.", guestKeyboard(env));
  seller = await ensureSellerApi(env, seller);
  return sendMessage(env, chatId, `<b>🔑 API فروشگاهی شما</b>\n\n<b>API Key:</b>\n<code>${esc(seller.api_key)}</code>\n\n<b>API Secret:</b>\n<code>${esc(seller.api_secret)}</code>\n\n<b>Endpoint ساخت پرداخت:</b>\n<code>${baseUrl(env)}/api/v1/payment/create</code>\n\n<b>Endpoint بررسی پرداخت:</b>\n<code>${baseUrl(env)}/api/v1/payment/verify</code>\n\n<b>Webhook پیش‌فرض:</b>\n${seller.default_webhook_url ? esc(seller.default_webhook_url) : "-"}\n\n<b>مستندات:</b>\n${baseUrl(env)}/docs\n\n⚠️ API Key و API Secret را محرمانه نگه دار.`, apiPanelKeyboard());
}

/* =========================
   Message Handler
========================= */

async function handleMessage(message, env) {
  const chatId = message.chat?.id;
  const user = message.from;
  const text = String(message.text || "").trim();
  if (!chatId || !user || !text) return;

  if (text.startsWith("/cancel")) { await clearState(env, user.id); return sendMessage(env, chatId, "عملیات فعلی لغو شد."); }
  if (text.startsWith("/start")) { await clearState(env, user.id); return sendHome(env, chatId, user); }
  if (text.startsWith("/help")) return sendHelp(env, chatId);

  const state = await getState(env, user.id);
  if (state) return processStateMessage(env, chatId, user, text, state);
  return sendHome(env, chatId, user);
}

async function processStateMessage(env, chatId, user, text, state) {
  if (state.state === "await_seller_title") {
    const title = text.slice(0, 60).trim();
    if (title.length < 2) return sendMessage(env, chatId, "نام فروشگاه یا سرویس خیلی کوتاه است. دوباره وارد کن.");
    let seller = await getSellerByTelegram(env, user.id);
    if (!seller) seller = await createSeller(env, user, title);
    await clearState(env, user.id);
    return sendMessage(env, chatId, `✅ ثبت‌نام فروشنده انجام شد.\n\n<b>نام فروشنده:</b>\n${esc(seller.title)}\n\nاکنون می‌توانی لینک پرداخت بسازی یا API Key فروشگاهی بگیری.`, sellerKeyboard(env));
  }

  if (state.state === "await_link_amount") {
    const amountToman = parseAmountToman(text);
    if (!amountToman || amountToman < 10000) return sendMessage(env, chatId, "حداقل مبلغ لینک پرداخت 10,000 تومان است. دوباره مبلغ را بفرست.");
    await setState(env, user.id, "await_link_description", { amountToman }, 900);
    return sendMessage(env, chatId, `توضیحات لینک پرداخت را بفرست.\n\nمثال:\n<code>خرید سرویس یک‌ماهه</code>`);
  }

  if (state.state === "await_link_description") {
    const seller = await getSellerByTelegram(env, user.id);
    if (!seller) { await clearState(env, user.id); return sendMessage(env, chatId, "ابتدا باید فروشنده ثبت‌نام کنی.", guestKeyboard(env)); }
    const token = shortToken(14);
    const amountRial = tomanToRial(state.data.amountToman);
    const description = text.slice(0, 250);
    await env.DB.prepare(`INSERT INTO payment_links (token, seller_id, amount_rial, description, status, created_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?)`).bind(token, seller.id, amountRial, description, nowIso()).run();
    await clearState(env, user.id);
    const link = `${baseUrl(env)}/pay/${token}`;
    return sendMessage(env, chatId, `✅ لینک پرداخت ساخته شد.\n\n<b>مبلغ:</b>\n<code>${fmt(state.data.amountToman)}</code> تومان\n\n<b>توضیحات:</b>\n${esc(description)}\n\n<b>لینک پرداخت مشتری:</b>\n${link}`, sellerKeyboard(env));
  }

  if (state.state === "await_seller_webhook_url") {
    const seller = await getSellerByTelegram(env, user.id);
    if (!seller) { await clearState(env, user.id); return sendMessage(env, chatId, "فروشنده پیدا نشد."); }
    const webhookUrl = text.trim();
    if (!isValidUrl(webhookUrl, false)) return sendMessage(env, chatId, "آدرس Webhook معتبر نیست. باید با http یا https شروع شود.");
    await env.DB.prepare(`UPDATE sellers SET default_webhook_url=?, updated_at=? WHERE id=?`).bind(webhookUrl, nowIso(), seller.id).run();
    await clearState(env, user.id);
    return sendMessage(env, chatId, `✅ Webhook پیش‌فرض ذخیره شد:\n\n${esc(webhookUrl)}`, sellerKeyboard(env));
  }

  if (state.state === "await_withdraw_amount") {
    const seller = await getSellerByTelegram(env, user.id);
    if (!seller) { await clearState(env, user.id); return sendMessage(env, chatId, "فروشنده پیدا نشد."); }
    const amountToman = parseAmountToman(text);
    const amountRial = tomanToRial(amountToman || 0);
    if (!amountToman || amountRial < minWithdrawRial(env)) return sendMessage(env, chatId, `حداقل برداشت ${fmt(rialToToman(minWithdrawRial(env)))} تومان است.`);
    if (amountRial > Number(seller.balance_rial)) return sendMessage(env, chatId, `موجودی کافی نیست.\n\n<b>موجودی فعلی:</b>\n<code>${fmt(rialToToman(seller.balance_rial))}</code> تومان`);
    await setState(env, user.id, "await_withdraw_card", { amountRial }, 900);
    return sendMessage(env, chatId, "شماره کارت مقصد برداشت را وارد کن:");
  }

  if (state.state === "await_withdraw_card") {
    const card = normalizeDigits(text).replace(/[^\d]/g, "");
    if (card.length !== 16) return sendMessage(env, chatId, "شماره کارت باید 16 رقم باشد. دوباره وارد کن.");
    await setState(env, user.id, "await_withdraw_holder", { amountRial: state.data.amountRial, cardNumber: card }, 900);
    return sendMessage(env, chatId, "نام صاحب کارت را وارد کن:");
  }

  if (state.state === "await_withdraw_holder") {
    const seller = await getSellerByTelegram(env, user.id);
    if (!seller) { await clearState(env, user.id); return sendMessage(env, chatId, "فروشنده پیدا نشد."); }
    const amountRial = Number(state.data.amountRial);
    const cardNumber = state.data.cardNumber;
    const cardHolder = text.slice(0, 80);
    return createWithdrawal(env, seller, amountRial, cardNumber, cardHolder, "درخواست برداشت فروشنده", async (withdrawalId, newBalance) => {
      await clearState(env, user.id);
      await sendMessage(env, chatId, `✅ درخواست برداشت ثبت شد.\n\n<b>مبلغ:</b>\n<code>${fmt(rialToToman(amountRial))}</code> تومان\n\n<b>شماره کارت:</b>\n<code>${esc(cardNumber)}</code>\n\n<b>صاحب کارت:</b>\n${esc(cardHolder)}\n\nدرخواست برای ادمین ارسال شد.`, sellerKeyboard(env));
      await notifyWithdrawalToAdmins(env, seller, amountRial, cardNumber, cardHolder, newBalance, withdrawalId, "درخواست برداشت جدید");
    });
  }
}

/* =========================
   Callback Handler
========================= */

async function handleCallback(callback, env) {
  const data = String(callback.data || "");
  const chatId = callback.message?.chat?.id;
  const user = callback.from;
  if (!chatId || !user) return;
  await answerCallback(env, callback.id);

  if (data === "home") return sendHome(env, chatId, user);
  if (data === "help") return sendHelp(env, chatId);

  if (data === "seller_register") {
    const exists = await getSellerByTelegram(env, user.id);
    if (exists) return sendMessage(env, chatId, "شما قبلاً ثبت‌نام کرده‌اید.", sellerKeyboard(env));
    await setState(env, user.id, "await_seller_title", {}, 900);
    return sendMessage(env, chatId, "نام فروشگاه یا نام سرویس خودت را وارد کن:");
  }

  if (data === "seller_create_link") {
    const seller = await getSellerByTelegram(env, user.id);
    if (!seller) return sendMessage(env, chatId, "ابتدا ثبت‌نام فروشنده را انجام بده.", guestKeyboard(env));
    await setState(env, user.id, "await_link_amount", {}, 900);
    return sendMessage(env, chatId, `مبلغ لینک پرداخت را به تومان وارد کن.\n\nمثال:\n<code>500000</code>`);
  }

  if (data === "seller_api_panel") return sendSellerApiPanel(env, chatId, user.id);

  if (data === "seller_api_reset") {
    const seller = await getSellerByTelegram(env, user.id);
    if (!seller) return sendMessage(env, chatId, "ابتدا ثبت‌نام فروشنده را انجام بده.", guestKeyboard(env));
    const updated = await resetSellerApi(env, seller.id);
    return sendMessage(env, chatId, `✅ API Key جدید ساخته شد.\n\n<b>API Key:</b>\n<code>${esc(updated.api_key)}</code>\n\n<b>API Secret:</b>\n<code>${esc(updated.api_secret)}</code>\n\n⚠️ کلید قبلی از این لحظه غیرفعال شد.`, apiPanelKeyboard());
  }

  if (data === "seller_set_webhook") {
    const seller = await getSellerByTelegram(env, user.id);
    if (!seller) return sendMessage(env, chatId, "ابتدا ثبت‌نام فروشنده را انجام بده.", guestKeyboard(env));
    await setState(env, user.id, "await_seller_webhook_url", {}, 900);
    return sendMessage(env, chatId, `آدرس Webhook فروشگاهت را بفرست.\n\nمثال:\n<code>https://example.com/api/payment/webhook</code>`);
  }

  if (data === "seller_balance") return sendSellerBalance(env, chatId, user.id);
  if (data === "seller_transactions") return sendSellerTransactions(env, chatId, user.id);
  if (data === "seller_profile") return sendSellerProfile(env, chatId, user.id);

  if (data === "seller_withdraw") {
    const seller = await getSellerByTelegram(env, user.id);
    if (!seller) return sendMessage(env, chatId, "ابتدا فروشنده ثبت‌نام کن.", guestKeyboard(env));
    if (Number(seller.balance_rial) < minWithdrawRial(env)) return sendMessage(env, chatId, `موجودی شما برای برداشت کافی نیست.\n\n<b>موجودی:</b>\n<code>${fmt(rialToToman(seller.balance_rial))}</code> تومان\n\n<b>حداقل برداشت:</b>\n<code>${fmt(rialToToman(minWithdrawRial(env)))}</code> تومان`);
    await setState(env, user.id, "await_withdraw_amount", {}, 900);
    return sendMessage(env, chatId, `مبلغ برداشت را به تومان وارد کن.\n\n<b>موجودی قابل برداشت:</b>\n<code>${fmt(rialToToman(seller.balance_rial))}</code> تومان`);
  }

  if (data === "admin_withdrawals") { if (!isAdmin(env, user.id)) return sendMessage(env, chatId, "دسترسی ندارید."); return sendPendingWithdrawals(env, chatId); }
  if (data === "admin_stats") { if (!isAdmin(env, user.id)) return sendMessage(env, chatId, "دسترسی ندارید."); return sendAdminStats(env, chatId); }
  if (data.startsWith("admin_settle:")) { if (!isAdmin(env, user.id)) return sendMessage(env, chatId, "دسترسی ندارید."); return settleWithdrawal(env, chatId, user.id, Number(data.split(":")[1])); }
  if (data.startsWith("admin_reject:")) { if (!isAdmin(env, user.id)) return sendMessage(env, chatId, "دسترسی ندارید."); return rejectWithdrawal(env, chatId, user.id, Number(data.split(":")[1])); }
}

/* =========================
   Seller Info / Admin
========================= */

async function sendSellerBalance(env, chatId, telegramId) {
  const seller = await getSellerByTelegram(env, telegramId);
  if (!seller) return sendMessage(env, chatId, "ابتدا ثبت‌نام کن.", guestKeyboard(env));
  const pendingWithdrawals = await env.DB.prepare(`SELECT COALESCE(SUM(amount_rial),0) AS total FROM withdrawals WHERE seller_id=? AND status='PENDING'`).bind(seller.id).first();
  return sendMessage(env, chatId, `<b>📊 موجودی فروشنده</b>\n\n<b>نام:</b>\n${esc(seller.title)}\n\n<b>موجودی قابل برداشت:</b>\n<code>${fmt(rialToToman(seller.balance_rial))}</code> تومان\n\n<b>درخواست برداشت در انتظار:</b>\n<code>${fmt(rialToToman(pendingWithdrawals.total))}</code> تومان\n\n<b>کل فروش موفق:</b>\n<code>${fmt(rialToToman(seller.total_sales_rial))}</code> تومان\n\n<b>کل کارمزد کسرشده:</b>\n<code>${fmt(rialToToman(seller.total_fee_rial))}</code> تومان`, sellerKeyboard(env));
}

async function sendSellerProfile(env, chatId, telegramId) {
  const seller = await getSellerByTelegram(env, telegramId);
  if (!seller) return sendMessage(env, chatId, "ابتدا ثبت‌نام کن.", guestKeyboard(env));
  return sendMessage(env, chatId, `<b>👤 پروفایل فروشنده</b>\n\n<b>نام فروشنده:</b>\n${esc(seller.title)}\n\n<b>وضعیت:</b>\n${statusFa(seller.status)}\n\n<b>آیدی فروشنده:</b>\n<code>${seller.id}</code>\n\n<b>آیدی تلگرام:</b>\n<code>${seller.telegram_id}</code>\n\n<b>یوزرنیم:</b>\n${seller.username ? "@" + esc(seller.username) : "-"}\n\n<b>تاریخ عضویت:</b>\n${seller.created_at}`, sellerKeyboard(env));
}

async function sendSellerTransactions(env, chatId, telegramId) {
  const seller = await getSellerByTelegram(env, telegramId);
  if (!seller) return sendMessage(env, chatId, "ابتدا ثبت‌نام کن.", guestKeyboard(env));
  const rows = await env.DB.prepare(`SELECT * FROM ledger WHERE seller_id=? ORDER BY id DESC LIMIT 10`).bind(seller.id).all();
  const items = rows.results || [];
  if (!items.length) return sendMessage(env, chatId, "هنوز تراکنشی ثبت نشده است.", sellerKeyboard(env));
  const lines = items.map((x) => `${Number(x.amount_rial) >= 0 ? "+" : "-"} ${fmt(rialToToman(Math.abs(x.amount_rial)))} تومان | ${x.type} | موجودی: ${fmt(rialToToman(x.balance_after_rial))}`).join("\n");
  return sendMessage(env, chatId, `<b>📄 آخرین تراکنش‌ها</b>\n\n<code>${esc(lines)}</code>`, sellerKeyboard(env));
}

async function sendPendingWithdrawals(env, chatId) {
  const rows = await env.DB.prepare(`SELECT w.*, s.title, s.telegram_id, s.username FROM withdrawals w JOIN sellers s ON s.id=w.seller_id WHERE w.status='PENDING' ORDER BY w.id DESC LIMIT 10`).all();
  const items = rows.results || [];
  if (!items.length) return sendMessage(env, chatId, "درخواست برداشت در انتظار وجود ندارد.", adminKeyboard());
  for (const w of items) {
    await sendMessage(env, chatId, `💸 <b>درخواست برداشت</b>\n\n<b>شناسه:</b>\n<code>${w.id}</code>\n\n<b>فروشنده:</b>\n${esc(w.title)}\n\n<b>آیدی تلگرام:</b>\n<code>${w.telegram_id}</code>\n\n<b>مبلغ:</b>\n<code>${fmt(rialToToman(w.amount_rial))}</code> تومان\n\n<b>کارت:</b>\n<code>${esc(w.card_number)}</code>\n\n<b>صاحب کارت:</b>\n${esc(w.card_holder || "-")}\n\n<b>تاریخ:</b>\n${w.created_at}`, withdrawalAdminKeyboard(w.id));
  }
}

async function sendAdminStats(env, chatId) {
  const sellers = await env.DB.prepare(`SELECT COUNT(*) AS c FROM sellers`).first();
  const paid = await env.DB.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_rial),0) AS sales, COALESCE(SUM(fee_rial),0) AS fees FROM payments WHERE status='PAID'`).first();
  const pendingW = await env.DB.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(amount_rial),0) AS amount FROM withdrawals WHERE status='PENDING'`).first();
  return sendMessage(env, chatId, `<b>📊 آمار کلی</b>\n\n<b>تعداد فروشنده‌ها:</b>\n<code>${fmt(sellers.c)}</code>\n\n<b>پرداخت‌های موفق:</b>\n<code>${fmt(paid.c)}</code>\n\n<b>مجموع فروش:</b>\n<code>${fmt(rialToToman(paid.sales))}</code> تومان\n\n<b>درآمد کارمزد:</b>\n<code>${fmt(rialToToman(paid.fees))}</code> تومان\n\n<b>برداشت‌های در انتظار:</b>\n<code>${fmt(pendingW.c)}</code>\n\n<b>مبلغ برداشت‌های در انتظار:</b>\n<code>${fmt(rialToToman(pendingW.amount))}</code> تومان`, adminKeyboard());
}

async function settleWithdrawal(env, chatId, adminId, withdrawalId) {
  const w = await env.DB.prepare(`SELECT w.*, s.telegram_id, s.title FROM withdrawals w JOIN sellers s ON s.id=w.seller_id WHERE w.id=?`).bind(withdrawalId).first();
  if (!w) return sendMessage(env, chatId, "درخواست برداشت پیدا نشد.");
  if (w.status !== "PENDING") return sendMessage(env, chatId, "این درخواست قبلاً تعیین تکلیف شده است.");
  const now = nowIso();
  await env.DB.prepare(`UPDATE withdrawals SET status='SETTLED', settled_at=?, admin_id=? WHERE id=? AND status='PENDING'`).bind(now, String(adminId), withdrawalId).run();
  await sendMessage(env, w.telegram_id, `✅ <b>درخواست برداشت شما تسویه شد</b>\n\n<b>مبلغ:</b>\n<code>${fmt(rialToToman(w.amount_rial))}</code> تومان\n\n<b>شماره کارت:</b>\n<code>${esc(w.card_number)}</code>\n\n<b>زمان:</b>\n${now}`);
  return sendMessage(env, chatId, "✅ برداشت تسویه شد.");
}

async function rejectWithdrawal(env, chatId, adminId, withdrawalId) {
  const w = await env.DB.prepare(`SELECT w.*, s.telegram_id, s.title, s.balance_rial FROM withdrawals w JOIN sellers s ON s.id=w.seller_id WHERE w.id=?`).bind(withdrawalId).first();
  if (!w) return sendMessage(env, chatId, "درخواست برداشت پیدا نشد.");
  if (w.status !== "PENDING") return sendMessage(env, chatId, "این درخواست قبلاً تعیین تکلیف شده است.");
  const now = nowIso();
  const newBalance = Number(w.balance_rial) + Number(w.amount_rial);
  await env.DB.prepare(`UPDATE withdrawals SET status='REJECTED', rejected_at=?, admin_id=? WHERE id=? AND status='PENDING'`).bind(now, String(adminId), withdrawalId).run();
  await env.DB.prepare(`UPDATE sellers SET balance_rial=?, updated_at=? WHERE id=?`).bind(newBalance, now, w.seller_id).run();
  await addLedger(env, w.seller_id, "WITHDRAW_REJECT", Number(w.amount_rial), newBalance, "withdrawal", String(withdrawalId), "رد درخواست برداشت و برگشت مبلغ به موجودی");
  await sendMessage(env, w.telegram_id, `❌ <b>درخواست برداشت شما رد شد</b>\n\n<b>مبلغ برگشت‌خورده به موجودی:</b>\n<code>${fmt(rialToToman(w.amount_rial))}</code> تومان\n\n<b>موجودی فعلی:</b>\n<code>${fmt(rialToToman(newBalance))}</code> تومان`);
  return sendMessage(env, chatId, "❌ برداشت رد شد و مبلغ به موجودی فروشنده برگشت.");
}

async function createWithdrawal(env, seller, amountRial, cardNumber, cardHolder, ledgerDescription, afterCreate) {
  if (amountRial > Number(seller.balance_rial)) throw new Error("موجودی کافی نیست");
  if (String(cardNumber).length !== 16) throw new Error("شماره کارت باید 16 رقم باشد");
  if (String(cardHolder || "").trim().length < 2) throw new Error("نام صاحب کارت را وارد کن");
  const now = nowIso();
  const newBalance = Number(seller.balance_rial) - Number(amountRial);
  await env.DB.prepare(`UPDATE sellers SET balance_rial=?, updated_at=? WHERE id=?`).bind(newBalance, now, seller.id).run();
  const result = await env.DB.prepare(`INSERT INTO withdrawals (seller_id, amount_rial, card_number, card_holder, status, created_at) VALUES (?, ?, ?, ?, 'PENDING', ?)`).bind(seller.id, amountRial, cardNumber, cardHolder, now).run();
  const withdrawalId = result.meta.last_row_id;
  await addLedger(env, seller.id, "WITHDRAW_HOLD", -amountRial, newBalance, "withdrawal", String(withdrawalId), ledgerDescription);
  if (afterCreate) await afterCreate(withdrawalId, newBalance, now);
  return { withdrawalId, newBalance, createdAt: now };
}

async function notifyWithdrawalToAdmins(env, seller, amountRial, cardNumber, cardHolder, newBalance, withdrawalId, title = "درخواست برداشت جدید") {
  return notifyAdmins(env, `💸 <b>${esc(title)}</b>\n\n<b>فروشنده:</b>\n${esc(seller.title)}\n\n<b>آیدی تلگرام:</b>\n<code>${seller.telegram_id}</code>\n\n<b>مبلغ:</b>\n<code>${fmt(rialToToman(amountRial))}</code> تومان\n\n<b>شماره کارت:</b>\n<code>${esc(cardNumber)}</code>\n\n<b>صاحب کارت:</b>\n${esc(cardHolder)}\n\n<b>موجودی بعد از رزرو:</b>\n<code>${fmt(rialToToman(newBalance))}</code> تومان`, withdrawalAdminKeyboard(withdrawalId));
}

/* =========================
   Mini App
========================= */

function miniAppPage(env) {
  const title = esc(env.BOT_TITLE || "BluePay | درگاه واسط");
  const minWithdrawValue = Number(rialToToman(minWithdrawRial(env)));
  const minWithdrawLabel = fmt(minWithdrawValue);

  return html(`<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0">
<title>${title}</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
*{box-sizing:border-box}
html,body{margin:0;max-width:100%;overflow-x:hidden}
body{font-family:Tahoma,Arial,sans-serif;background:#f4f8ff;color:#0f172a;min-height:100vh}
.app{max-width:520px;margin:0 auto;padding:14px 14px 38px}
.hero{background:linear-gradient(135deg,#2563eb,#38bdf8);color:#fff;border-radius:26px;padding:22px;box-shadow:0 20px 50px rgba(37,99,235,.22);margin-bottom:14px}
.hero h1{margin:0 0 8px;font-size:21px}.hero p{margin:0;line-height:1.9;font-size:13px;opacity:.95}
.card{background:#fff;border:1px solid rgba(15,23,42,.06);border-radius:22px;padding:16px;box-shadow:0 12px 32px rgba(15,23,42,.06);margin-bottom:14px}
.title{font-size:16px;font-weight:bold;margin-bottom:12px;color:#1e293b}
input,textarea{width:100%;border:1px solid #dbeafe;background:#f8fafc;border-radius:15px;padding:14px;font-size:15px;outline:none;margin-bottom:10px;font-family:Tahoma,Arial,sans-serif}
textarea{min-height:82px;resize:vertical}.ltr{direction:ltr;text-align:center;unicode-bidi:isolate}
button,.btn{width:100%;border:none;text-decoration:none;background:#2563eb;color:#fff;padding:14px;border-radius:15px;font-size:15px;font-weight:bold;cursor:pointer;margin-top:8px;display:block;text-align:center}
.secondary{background:#f1f5f9;color:#334155}.danger{background:#fef2f2;color:#b91c1c}
.status{display:none;padding:12px;border-radius:15px;margin-bottom:12px;font-size:14px;line-height:1.8;white-space:pre-wrap}
.status.show{display:block}.status.info{background:#eff6ff;color:#1d4ed8}.status.ok{background:#ecfdf5;color:#047857}.status.err{background:#fef2f2;color:#b91c1c}
.box{background:#f8fbff;border:1px solid #dbeafe;border-radius:16px;padding:12px;line-height:2;font-size:14px;word-break:break-word;overflow-wrap:anywhere}
.muted{color:#64748b;font-size:13px;line-height:1.9}.small{font-size:12px;color:#64748b;margin-top:8px;line-height:1.8}
.tabs{display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-bottom:12px}.tabs button{margin:0;padding:11px;font-size:13px;background:#eff6ff;color:#1d4ed8}
.loading{animation:pulse 1.2s infinite}@keyframes pulse{0%{opacity:.55}50%{opacity:1}100%{opacity:.55}}
</style>
</head>
<body>
<div class="app">
  <div class="hero"><h1>💙 ${title}</h1><p>پنل سریع فروشنده برای لینک پرداخت، API فروشگاهی و برداشت وجه.</p></div>
  <div id="status" class="status show info loading">در حال آماده‌سازی پنل...</div>
  <div id="content"><div class="card"><div class="title">لطفاً صبر کنید...</div><div class="muted">اگر صفحه باز نشد، یک‌بار از داخل خود ربات دوباره گزینه «درگاه من» را بزنید.</div></div></div>
</div>
<script>
(function(){
  var MIN_WITHDRAW_TOMAN = ${minWithdrawValue};
  var MIN_WITHDRAW_LABEL = ${JSON.stringify(minWithdrawLabel)};
  var tg = null;
  var initData = "";
  var currentSeller = null;

  window.onerror = function(message, source, lineno, colno){
    showError("خطای اجرای مینی‌اپ: " + message + "\nLine: " + lineno);
    return false;
  };

  function el(id){ return document.getElementById(id); }
  function escapeHtml(v){
    return String(v || "")
      .replace(/&/g,"&amp;")
      .replace(/</g,"&lt;")
      .replace(/>/g,"&gt;")
      .replace(/\"/g,"&quot;");
  }
  function fmt(n){ return Number(n || 0).toLocaleString("en-US"); }
  function onlyDigits(v){
    return String(v || "")
      .replace(/[۰-۹]/g,function(d){ return "۰۱۲۳۴۵۶۷۸۹".indexOf(d); })
      .replace(/[٠-٩]/g,function(d){ return "٠١٢٣٤٥٦٧٨٩".indexOf(d); })
      .replace(/[^0-9]/g,"");
  }
  function setStatus(text,type){
    var box = el("status");
    if(!box) return;
    box.className = "status show " + (type || "info");
    box.textContent = text;
  }
  function showError(text){ setStatus(text,"err"); }
  function clearStatus(){
    var box = el("status");
    if(!box) return;
    box.className = "status";
    box.textContent = "";
  }
  function requestTimeout(ms){
    return new Promise(function(_, reject){ setTimeout(function(){ reject(new Error("اتصال کند است؛ دوباره تلاش کن")); }, ms); });
  }
  async function api(path, body){
    var payload = Object.assign({ initData: initData }, body || {});
    var req = fetch(path, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(payload) })
      .then(function(res){ return res.text().then(function(txt){
        var data = {};
        try { data = JSON.parse(txt || "{}"); } catch(e) { throw new Error("پاسخ سرور JSON نیست"); }
        if(!res.ok || !data.ok) throw new Error(data.message || data.error || "خطا در ارتباط با سرور");
        return data;
      }); });
    return Promise.race([req, requestTimeout(15000)]);
  }
  function tabs(){
    return '<div class="tabs">' +
      '<button onclick="BluePayApp.renderPanel()">پرداخت</button>' +
      '<button onclick="BluePayApp.renderApiPanel()">API</button>' +
      '<button onclick="BluePayApp.renderWithdrawPanel()">برداشت</button>' +
    '</div>';
  }
  function renderRegister(){
    clearStatus();
    el("content").innerHTML = '<div class="card"><div class="title">🛍 ثبت‌نام فروشنده</div><div class="muted">برای ساخت لینک پرداخت و دریافت API Key، نام فروشگاه یا سرویس خودت را وارد کن.</div><br><input id="sellerTitle" placeholder="مثلاً BlueVPN یا خدمات طراحی"><button onclick="BluePayApp.registerSeller()">ثبت‌نام فروشنده</button></div>';
  }
  async function registerSeller(){
    var title = el("sellerTitle").value.trim();
    if(title.length < 2){ showError("نام فروشنده خیلی کوتاه است."); return; }
    setStatus("در حال ثبت‌نام...","info");
    try{
      var data = await api("/api/app/register", { title:title });
      currentSeller = data.seller;
      setStatus("ثبت‌نام با موفقیت انجام شد.","ok");
      renderPanel();
    }catch(e){ showError(e.message); }
  }
  function sellerOrStop(){
    if(!currentSeller){ showError("اطلاعات فروشنده هنوز بارگذاری نشده است."); return null; }
    return currentSeller;
  }
  function renderPanel(){
    var seller = sellerOrStop(); if(!seller) return;
    clearStatus();
    el("content").innerHTML = tabs() +
      '<div class="card"><div class="title">📊 موجودی من</div><div class="box"><b>فروشنده:</b> '+escapeHtml(seller.title)+'<br><b>موجودی قابل برداشت:</b> '+fmt(seller.balance_toman)+' تومان<br><b>کل فروش موفق:</b> '+fmt(seller.total_sales_toman)+' تومان<br><b>کل کارمزد:</b> '+fmt(seller.total_fee_toman)+' تومان</div></div>' +
      '<div class="card"><div class="title">💳 ساخت لینک پرداخت</div><input id="amount" class="ltr" inputmode="numeric" placeholder="مبلغ به تومان؛ مثلاً 500000"><textarea id="description" placeholder="توضیحات پرداخت؛ مثلاً خرید سرویس یک‌ماهه"></textarea><button onclick="BluePayApp.createLink()">ساخت لینک پرداخت</button></div><div id="result"></div>';
  }
  function renderApiPanel(){
    var seller = sellerOrStop(); if(!seller) return;
    clearStatus();
    el("content").innerHTML = tabs() +
      '<div class="card"><div class="title">🔑 API فروشگاهی</div><div class="box"><b>API Key:</b><br><span id="apiKey">'+escapeHtml(seller.api_key || "-")+'</span><br><br><b>API Secret:</b><br><span id="apiSecret">'+escapeHtml(seller.api_secret || "-")+'</span><br><br><b>Webhook پیش‌فرض:</b><br><span>'+escapeHtml(seller.default_webhook_url || "-")+'</span></div><button onclick="BluePayApp.copyText(\'apiKey\')">کپی API Key</button><button onclick="BluePayApp.copyText(\'apiSecret\')">کپی API Secret</button><a class="btn secondary" href="/docs">مشاهده مستندات API</a><button class="danger" onclick="BluePayApp.resetApi()">ساخت API Key جدید</button></div>' +
      '<div class="card"><div class="title">🌐 تنظیم Webhook پیش‌فرض</div><input id="webhookUrl" class="ltr" placeholder="https://example.com/payment/webhook" value="'+escapeHtml(seller.default_webhook_url || "")+'"><button onclick="BluePayApp.saveWebhook()">ذخیره Webhook</button></div>';
  }
  function renderWithdrawPanel(){
    var seller = sellerOrStop(); if(!seller) return;
    clearStatus();
    el("content").innerHTML = tabs() +
      '<div class="card"><div class="title">💸 برداشت وجه</div><div class="box"><b>موجودی قابل برداشت:</b> '+fmt(seller.balance_toman)+' تومان<br><b>حداقل برداشت:</b> '+MIN_WITHDRAW_LABEL+' تومان</div><br><input id="withdrawAmount" class="ltr" inputmode="numeric" placeholder="مبلغ برداشت به تومان"><input id="withdrawCard" class="ltr" inputmode="numeric" placeholder="شماره کارت 16 رقمی"><input id="withdrawHolder" placeholder="نام صاحب کارت"><button onclick="BluePayApp.submitWithdraw()">ثبت درخواست برداشت</button><div class="small">مبلغ تا زمان تسویه از موجودی شما رزرو می‌شود.</div></div>' +
      '<div class="card"><div class="title">📄 آخرین برداشت‌ها</div><div id="withdrawalsList" class="muted">در حال بارگذاری...</div></div>';
    loadWithdrawals();
  }
  async function createLink(){
    var amountToman = Number(onlyDigits(el("amount").value));
    var description = el("description").value.trim();
    if(!amountToman || amountToman < 10000){ showError("حداقل مبلغ 10,000 تومان است."); return; }
    if(!description){ showError("توضیحات پرداخت را وارد کن."); return; }
    setStatus("در حال ساخت لینک پرداخت...","info");
    try{
      var data = await api("/api/app/create-link", { amountToman:amountToman, description:description });
      clearStatus();
      el("result").innerHTML = '<div class="card"><div class="title">✅ لینک پرداخت ساخته شد</div><div class="box ltr" id="payLink">'+escapeHtml(data.link)+'</div><button onclick="BluePayApp.copyText(\'payLink\')">کپی لینک</button><a class="btn secondary" href="'+escapeHtml(data.link)+'">باز کردن لینک پرداخت</a></div>';
    }catch(e){ showError(e.message); }
  }
  async function resetApi(){
    if(!confirm("API Key قبلی غیرفعال می‌شود. ادامه می‌دهی؟")) return;
    setStatus("در حال ساخت کلید جدید...","info");
    try{ var data = await api("/api/app/api-reset", {}); currentSeller = data.seller; setStatus("کلید جدید ساخته شد.","ok"); renderApiPanel(); }catch(e){ showError(e.message); }
  }
  async function saveWebhook(){
    var webhook_url = el("webhookUrl").value.trim();
    setStatus("در حال ذخیره Webhook...","info");
    try{ var data = await api("/api/app/save-webhook", { webhook_url:webhook_url }); currentSeller = data.seller; setStatus("Webhook ذخیره شد.","ok"); renderApiPanel(); }catch(e){ showError(e.message); }
  }
  async function submitWithdraw(){
    var amountToman = Number(onlyDigits(el("withdrawAmount").value));
    var card_number = onlyDigits(el("withdrawCard").value);
    var card_holder = el("withdrawHolder").value.trim();
    if(!amountToman || amountToman < MIN_WITHDRAW_TOMAN){ showError("حداقل برداشت " + MIN_WITHDRAW_LABEL + " تومان است."); return; }
    if(card_number.length !== 16){ showError("شماره کارت باید 16 رقم باشد."); return; }
    if(card_holder.length < 2){ showError("نام صاحب کارت را وارد کن."); return; }
    if(!confirm("درخواست برداشت ثبت شود؟")) return;
    setStatus("در حال ثبت درخواست برداشت...","info");
    try{ var data = await api("/api/app/withdraw", { amountToman:amountToman, card_number:card_number, card_holder:card_holder }); currentSeller = data.seller; setStatus("درخواست برداشت با موفقیت ثبت شد.","ok"); renderWithdrawPanel(); }catch(e){ showError(e.message); }
  }
  async function loadWithdrawals(){
    try{
      var data = await api("/api/app/withdrawals", {});
      var list = el("withdrawalsList");
      if(!list) return;
      if(!data.withdrawals || !data.withdrawals.length){ list.innerHTML = "هنوز درخواست برداشتی ثبت نشده است."; return; }
      var html = "";
      for(var i=0;i<data.withdrawals.length;i++){
        var w = data.withdrawals[i];
        html += '<div class="box" style="margin-bottom:10px"><b>مبلغ:</b> '+fmt(w.amount_toman)+' تومان<br><b>وضعیت:</b> '+escapeHtml(w.status_fa)+'<br><b>کارت:</b> <span class="ltr">'+escapeHtml(w.card_number)+'</span><br><b>تاریخ:</b> <span class="ltr">'+escapeHtml(w.created_at)+'</span></div>';
      }
      list.innerHTML = html;
    }catch(e){ var list = el("withdrawalsList"); if(list) list.innerHTML = "خطا در دریافت لیست برداشت‌ها: " + escapeHtml(e.message); }
  }
  async function copyText(id){
    var node = el(id); if(!node) return;
    var text = node.textContent;
    try{ await navigator.clipboard.writeText(text); setStatus("کپی شد.","ok"); }catch(e){ setStatus("کپی در این مرورگر پشتیبانی نشد.","err"); }
  }
  async function loadMe(){
    try{
      tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
      initData = tg && tg.initData ? tg.initData : "";
      if(tg){ try{ tg.ready(); tg.expand(); if(tg.MainButton) tg.MainButton.hide(); }catch(_){} }
      if(!initData){
        showError("این صفحه باید از داخل مینی‌اپ تلگرام باز شود.\nاز داخل ربات روی دکمه «درگاه من» بزن.");
        el("content").innerHTML = '<div class="card"><div class="title">راهنما</div><div class="muted">اگر صفحه را با مرورگر عادی باز کرده‌ای، به ربات برگرد و دکمه مینی‌اپ را بزن.</div></div>';
        return;
      }
      setStatus("در حال دریافت اطلاعات فروشنده...","info");
      var data = await api("/api/app/me", {});
      if(!data.seller){ renderRegister(); return; }
      currentSeller = data.seller;
      renderPanel();
    }catch(e){
      showError("خطا در بارگذاری مینی‌اپ: " + e.message);
      el("content").innerHTML = '<div class="card"><div class="title">بارگذاری ناموفق</div><div class="muted">یک بار صفحه را ببند و دوباره از داخل ربات باز کن. اگر ادامه داشت، /setup و /install را دوباره اجرا کن.</div></div>';
    }
  }
  window.BluePayApp = { renderPanel:renderPanel, renderApiPanel:renderApiPanel, renderWithdrawPanel:renderWithdrawPanel, registerSeller:registerSeller, createLink:createLink, resetApi:resetApi, saveWebhook:saveWebhook, submitWithdraw:submitWithdraw, copyText:copyText };
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", loadMe); else loadMe();
})();
</script>
</body>
</html>`);
}

async function appMe(request, env) {
  need(env, ["BOT_TOKEN"]);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const body = await request.json().catch(() => null);
  const auth = await verifyTelegramWebAppInitData(String(body?.initData || ""), env);
  if (!auth.ok || !auth.user?.id) return json({ ok: false, error: "telegram_auth_failed", message: auth.error }, 401);
  let seller = await getSellerByTelegram(env, auth.user.id);
  if (!seller) return json({ ok: true, seller: null });
  seller = await ensureSellerApi(env, seller);
  return json({ ok: true, seller: sellerToApp(seller) });
}

function sellerToApp(seller) {
  return {
    id: seller.id,
    title: seller.title,
    status: seller.status,
    balance_toman: rialToToman(seller.balance_rial),
    total_sales_toman: rialToToman(seller.total_sales_rial),
    total_fee_toman: rialToToman(seller.total_fee_rial),
    api_key: seller.api_key,
    api_secret: seller.api_secret,
    default_webhook_url: seller.default_webhook_url || "",
    default_callback_url: seller.default_callback_url || "",
  };
}

async function appRegister(request, env) {
  need(env, ["BOT_TOKEN"]);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const body = await request.json().catch(() => null);
  const auth = await verifyTelegramWebAppInitData(String(body?.initData || ""), env);
  if (!auth.ok || !auth.user?.id) return json({ ok: false, error: "telegram_auth_failed", message: auth.error }, 401);
  const title = String(body?.title || "").trim().slice(0, 60);
  if (title.length < 2) return json({ ok: false, error: "invalid_title", message: "نام فروشنده معتبر نیست" }, 400);
  let seller = await getSellerByTelegram(env, auth.user.id);
  if (!seller) seller = await createSeller(env, auth.user, title);
  seller = await ensureSellerApi(env, seller);
  return json({ ok: true, seller: sellerToApp(seller) });
}

async function appCreateLink(request, env) {
  need(env, ["BOT_TOKEN"]);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const body = await request.json().catch(() => null);
  const auth = await verifyTelegramWebAppInitData(String(body?.initData || ""), env);
  if (!auth.ok || !auth.user?.id) return json({ ok: false, error: "telegram_auth_failed", message: auth.error }, 401);
  const seller = await getSellerByTelegram(env, auth.user.id);
  if (!seller) return json({ ok: false, error: "seller_not_found", message: "ابتدا ثبت‌نام فروشنده را انجام بده" }, 403);
  if (seller.status !== "ACTIVE") return json({ ok: false, error: "seller_disabled", message: "حساب فروشنده فعال نیست" }, 403);
  const amountToman = Number(body?.amountToman);
  const description = String(body?.description || "").trim().slice(0, 250);
  if (!amountToman || amountToman < 10000) return json({ ok: false, error: "amount_too_low", message: "حداقل مبلغ 10,000 تومان است" }, 400);
  if (!description) return json({ ok: false, error: "description_required", message: "توضیحات پرداخت را وارد کن" }, 400);
  const token = shortToken(14);
  await env.DB.prepare(`INSERT INTO payment_links (token, seller_id, amount_rial, description, status, created_at) VALUES (?, ?, ?, ?, 'ACTIVE', ?)`).bind(token, seller.id, tomanToRial(amountToman), description, nowIso()).run();
  const link = `${baseUrl(env)}/pay/${token}`;
  await sendMessage(env, seller.telegram_id, `✅ <b>لینک پرداخت از مینی‌اپ ساخته شد</b>\n\n<b>مبلغ:</b>\n<code>${fmt(amountToman)}</code> تومان\n\n<b>توضیحات:</b>\n${esc(description)}\n\n<b>لینک:</b>\n${link}`);
  return json({ ok: true, link, token });
}

async function appApiReset(request, env) {
  need(env, ["BOT_TOKEN"]);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const body = await request.json().catch(() => null);
  const auth = await verifyTelegramWebAppInitData(String(body?.initData || ""), env);
  if (!auth.ok || !auth.user?.id) return json({ ok: false, error: "telegram_auth_failed", message: auth.error }, 401);
  const seller = await getSellerByTelegram(env, auth.user.id);
  if (!seller) return json({ ok: false, error: "seller_not_found", message: "فروشنده پیدا نشد" }, 404);
  const updated = await resetSellerApi(env, seller.id);
  return json({ ok: true, seller: sellerToApp(updated) });
}

async function appSaveWebhook(request, env) {
  need(env, ["BOT_TOKEN"]);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const body = await request.json().catch(() => null);
  const auth = await verifyTelegramWebAppInitData(String(body?.initData || ""), env);
  if (!auth.ok || !auth.user?.id) return json({ ok: false, error: "telegram_auth_failed", message: auth.error }, 401);
  const seller = await getSellerByTelegram(env, auth.user.id);
  if (!seller) return json({ ok: false, error: "seller_not_found", message: "فروشنده پیدا نشد" }, 404);
  const webhookUrl = String(body?.webhook_url || "").trim();
  if (webhookUrl && !isValidUrl(webhookUrl, false)) return json({ ok: false, error: "invalid_webhook", message: "آدرس Webhook معتبر نیست" }, 400);
  await env.DB.prepare(`UPDATE sellers SET default_webhook_url=?, updated_at=? WHERE id=?`).bind(webhookUrl || null, nowIso(), seller.id).run();
  const updated = await getSellerById(env, seller.id);
  return json({ ok: true, seller: sellerToApp(updated) });
}

async function appWithdraw(request, env) {
  need(env, ["BOT_TOKEN"]);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const body = await request.json().catch(() => null);
  const auth = await verifyTelegramWebAppInitData(String(body?.initData || ""), env);
  if (!auth.ok || !auth.user?.id) return json({ ok: false, error: "telegram_auth_failed", message: auth.error }, 401);
  const seller = await getSellerByTelegram(env, auth.user.id);
  if (!seller) return json({ ok: false, error: "seller_not_found", message: "فروشنده پیدا نشد" }, 404);
  const amountToman = Number(body?.amountToman || 0);
  const amountRial = tomanToRial(amountToman);
  const cardNumber = normalizeDigits(String(body?.card_number || "")).replace(/[^\d]/g, "");
  const cardHolder = String(body?.card_holder || "").trim().slice(0, 80);
  if (!amountToman || amountRial < minWithdrawRial(env)) return json({ ok: false, error: "amount_too_low", message: `حداقل برداشت ${fmt(rialToToman(minWithdrawRial(env)))} تومان است` }, 400);
  if (amountRial > Number(seller.balance_rial)) return json({ ok: false, error: "insufficient_balance", message: "موجودی کافی نیست" }, 400);
  if (cardNumber.length !== 16) return json({ ok: false, error: "invalid_card", message: "شماره کارت باید 16 رقم باشد" }, 400);
  if (cardHolder.length < 2) return json({ ok: false, error: "invalid_card_holder", message: "نام صاحب کارت را وارد کن" }, 400);
  const result = await createWithdrawal(env, seller, amountRial, cardNumber, cardHolder, "درخواست برداشت از مینی‌اپ", async (withdrawalId, newBalance) => {
    await sendMessage(env, seller.telegram_id, `✅ <b>درخواست برداشت از مینی‌اپ ثبت شد</b>\n\n<b>مبلغ:</b>\n<code>${fmt(rialToToman(amountRial))}</code> تومان\n\n<b>شماره کارت:</b>\n<code>${esc(cardNumber)}</code>\n\n<b>صاحب کارت:</b>\n${esc(cardHolder)}\n\n<b>موجودی فعلی:</b>\n<code>${fmt(rialToToman(newBalance))}</code> تومان`);
    await notifyWithdrawalToAdmins(env, seller, amountRial, cardNumber, cardHolder, newBalance, withdrawalId, "درخواست برداشت جدید از مینی‌اپ");
  });
  const updatedSeller = await getSellerById(env, seller.id);
  return json({ ok: true, message: "درخواست برداشت ثبت شد", withdrawal: { id: result.withdrawalId, amount_toman: rialToToman(amountRial), card_number: cardNumber, card_holder: cardHolder, status: "PENDING", created_at: result.createdAt }, seller: sellerToApp(updatedSeller) });
}

async function appWithdrawals(request, env) {
  need(env, ["BOT_TOKEN"]);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const body = await request.json().catch(() => null);
  const auth = await verifyTelegramWebAppInitData(String(body?.initData || ""), env);
  if (!auth.ok || !auth.user?.id) return json({ ok: false, error: "telegram_auth_failed", message: auth.error }, 401);
  const seller = await getSellerByTelegram(env, auth.user.id);
  if (!seller) return json({ ok: false, error: "seller_not_found", message: "فروشنده پیدا نشد" }, 404);
  const rows = await env.DB.prepare(`SELECT * FROM withdrawals WHERE seller_id=? ORDER BY id DESC LIMIT 10`).bind(seller.id).all();
  return json({ ok: true, withdrawals: (rows.results || []).map((w) => ({ id: w.id, amount_toman: rialToToman(w.amount_rial), card_number: w.card_number, card_holder: w.card_holder || "", status: w.status, status_fa: statusFa(w.status), created_at: w.created_at, settled_at: w.settled_at || null, rejected_at: w.rejected_at || null })) });
}

/* =========================
   Public API V1
========================= */

async function readApiKey(request) {
  const h = request.headers.get("X-API-Key");
  if (h) return h.trim();
  const auth = request.headers.get("Authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return "";
}

async function apiV1CreatePayment(request, env) {
  need(env, ["BLUPAL_API_KEY"]);
  if (request.method !== "POST") return apiError("method_not_allowed", "Method not allowed", 405);
  const seller = await getSellerByApiKey(env, await readApiKey(request));
  if (!seller) return apiError("unauthorized", "Invalid API key", 401);
  const body = await request.json().catch(() => null);
  if (!body) return apiError("bad_json", "Invalid JSON body", 400);

  const amount = Number(body.amount);
  const currency = String(body.currency || "IRT").toUpperCase();
  const orderId = String(body.order_id || "").trim().slice(0, 120);
  const description = String(body.description || "").trim().slice(0, 250);
  const customerName = String(body.customer_name || "").trim().slice(0, 120);
  const customerMobile = String(body.customer_mobile || "").trim().slice(0, 30);
  const callbackUrl = String(body.callback_url || seller.default_callback_url || "").trim();
  const webhookUrl = String(body.webhook_url || seller.default_webhook_url || "").trim();

  if (!amount || !Number.isFinite(amount)) return apiError("amount_required", "amount is required", 400);
  const amountRial = currency === "IRR" ? amount : tomanToRial(amount);
  if (amountRial < 100000) return apiError("amount_too_low", "Minimum amount is 10000 IRT or 100000 IRR", 400);
  if (!orderId) return apiError("order_id_required", "order_id is required", 400);
  if (!description) return apiError("description_required", "description is required", 400);
  if (callbackUrl && !isValidUrl(callbackUrl, false)) return apiError("invalid_callback_url", "callback_url is invalid", 400);
  if (webhookUrl && !isValidUrl(webhookUrl, false)) return apiError("invalid_webhook_url", "webhook_url is invalid", 400);

  const existing = await env.DB.prepare(`SELECT * FROM payments WHERE seller_id=? AND order_id=? ORDER BY id DESC LIMIT 1`).bind(seller.id, orderId).first();
  if (existing) return json(paymentApiResponse(env, existing, true));

  const publicPaymentId = generatePaymentId();
  const fee = getFeeRial(env, amountRial);
  const net = Math.max(0, amountRial - fee);
  const created = await createBlupalInvoice(env, amountRial);

  await env.DB.prepare(
    `INSERT INTO payments
     (public_payment_id, invoice_id, link_id, seller_id, order_id, amount_rial, final_amount_rial, fee_rial, net_rial, status, payment_link, card_number, customer_ip, customer_name, customer_mobile, callback_url, webhook_url, api_created, created_at)
     VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).bind(publicPaymentId, created.invoice_id, seller.id, orderId, Number(created.amount), Number(created.final_amount), fee, net, created.status || "PENDING", created.payment_link || null, created.card_number || null, request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || null, customerName || null, customerMobile || null, callbackUrl || null, webhookUrl || null, nowIso()).run();

  await sendMessage(env, seller.telegram_id, `🧾 <b>سفارش API جدید ساخته شد</b>\n\n<b>Order ID:</b>\n<code>${esc(orderId)}</code>\n\n<b>Payment ID:</b>\n<code>${esc(publicPaymentId)}</code>\n\n<b>مبلغ:</b>\n<code>${fmt(rialToToman(amountRial))}</code> تومان\n\n<b>توضیحات:</b>\n${esc(description)}`);

  return json({ success: true, payment_id: publicPaymentId, order_id: orderId, amount: rialToToman(amountRial), amount_rial: amountRial, fee: rialToToman(fee), fee_rial: fee, seller_amount: rialToToman(net), seller_amount_rial: net, status: created.status || "PENDING", payment_url: `${baseUrl(env)}/pay/${publicPaymentId}`, direct_payment_url: created.payment_link });
}

async function apiV1VerifyPayment(request, env) {
  if (request.method !== "GET" && request.method !== "POST") return apiError("method_not_allowed", "Method not allowed", 405);
  const seller = await getSellerByApiKey(env, await readApiKey(request));
  if (!seller) return apiError("unauthorized", "Invalid API key", 401);
  const url = new URL(request.url);
  let paymentId = url.searchParams.get("payment_id");
  let orderId = url.searchParams.get("order_id");
  if (request.method === "POST") {
    const body = await request.json().catch(() => null);
    paymentId = paymentId || body?.payment_id;
    orderId = orderId || body?.order_id;
  }
  paymentId = String(paymentId || "").trim();
  orderId = String(orderId || "").trim();
  if (!paymentId && !orderId) return apiError("identifier_required", "payment_id or order_id is required", 400);

  const payment = paymentId
    ? await env.DB.prepare(`SELECT * FROM payments WHERE seller_id=? AND public_payment_id=?`).bind(seller.id, paymentId).first()
    : await env.DB.prepare(`SELECT * FROM payments WHERE seller_id=? AND order_id=? ORDER BY id DESC LIMIT 1`).bind(seller.id, orderId).first();

  if (!payment) return apiError("not_found", "Payment not found", 404);

  let freshPayment = payment;
  if (freshPayment.status !== "PAID" && freshPayment.invoice_id && env.SYNC_ON_VERIFY !== "false") {
    freshPayment = await syncPaymentFromBlupal(env, freshPayment).catch(() => freshPayment);
  }

  return json(paymentApiResponse(env, freshPayment, false));
}

function paymentApiResponse(env, payment, duplicated) {
  return { success: true, duplicated: !!duplicated, payment_id: payment.public_payment_id, order_id: payment.order_id, status: payment.status, amount: rialToToman(payment.amount_rial), amount_rial: payment.amount_rial, final_amount_rial: payment.final_amount_rial, fee: rialToToman(payment.fee_rial), fee_rial: payment.fee_rial, seller_amount: rialToToman(payment.net_rial), seller_amount_rial: payment.net_rial, paid_at: payment.paid_at || null, payment_url: `${baseUrl(env)}/pay/${payment.public_payment_id}` };
}

function apiError(error, message, status = 400) { return json({ success: false, error, message }, status); }

/* =========================
   Docs
========================= */

function docsPage(env) {
  const base = baseUrl(env);
  const bot = botUsername(env);
  const fee = env.FEE_PERCENT || "3";
  return html(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>مستندات API پرداخت BluePay</title><style>*{box-sizing:border-box}html,body{max-width:100%;overflow-x:hidden}body{margin:0;font-family:Tahoma,Arial,sans-serif;background:#f8fafc;color:#0f172a;line-height:2}.wrap{width:100%;max-width:1060px;margin:0 auto;padding:14px}.hero{background:linear-gradient(135deg,#2563eb,#38bdf8);color:#fff;border-radius:26px;padding:28px 22px;margin-bottom:18px;box-shadow:0 20px 50px rgba(37,99,235,.20)}.hero h1{margin:0 0 10px;font-size:25px}.hero p{margin:0;opacity:.95;font-size:14px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:24px;padding:20px;margin-bottom:16px;box-shadow:0 12px 35px rgba(15,23,42,.05)}h2{margin-top:0;font-size:21px;color:#1e293b}h3{margin-bottom:8px;color:#334155}p,li{font-size:15px}pre{direction:ltr;text-align:left;background:#0f172a;color:#e2e8f0;border-radius:16px;padding:15px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;line-height:1.7;font-size:13px}.ltr{direction:ltr;unicode-bidi:isolate;text-align:left}.urlbox{direction:ltr;unicode-bidi:isolate;display:block;width:100%;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:12px;border-radius:14px;font-size:13px;line-height:1.7;text-align:left;word-break:break-all;overflow-wrap:anywhere}.inline{direction:ltr;unicode-bidi:isolate;display:inline-block;background:#eff6ff;color:#1d4ed8;padding:2px 8px;border-radius:8px}.table-wrap{width:100%;overflow-x:auto;border:1px solid #e2e8f0;border-radius:16px}.table{width:100%;min-width:620px;border-collapse:collapse}.table th,.table td{padding:12px;border-bottom:1px solid #e2e8f0;text-align:right;vertical-align:top}.table th{background:#f1f5f9;color:#334155}.table tr:last-child td{border-bottom:none}.badge{display:inline-block;background:#ecfdf5;color:#047857;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:bold}.warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:18px;padding:14px;margin:14px 0}.info{background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;border-radius:18px;padding:14px;margin:14px 0}ul,ol{padding-right:22px}a{color:#2563eb;text-decoration:none;font-weight:bold}.footer{text-align:center;color:#64748b;font-size:13px;padding:24px 0}@media(max-width:600px){.wrap{padding:10px}.hero{padding:24px 18px}.hero h1{font-size:22px}.card{padding:18px}h2{font-size:19px}pre{font-size:12px;padding:13px}.urlbox{font-size:12px}}</style></head><body><div class="wrap"><div class="hero"><h1>مستندات API پرداخت BluePay</h1><p>اتصال سایت، ربات، اپلیکیشن یا پنل فروشگاهی به درگاه واسط BluePay. پس از پرداخت موفق، موجودی فروشنده شارژ می‌شود و Webhook ارسال می‌گردد.</p></div><div class="card"><h2>خلاصه فرآیند پرداخت</h2><ol><li>فروشنده داخل ربات ثبت‌نام می‌کند.</li><li>از بخش API فروشگاهی، API Key و API Secret دریافت می‌کند.</li><li>سایت یا ربات فروشنده با API، سفارش پرداخت می‌سازد.</li><li>مشتری به لینک پرداخت منتقل می‌شود.</li><li>بعد از پرداخت موفق، BluePay پرداخت را تأیید می‌کند.</li><li>موجودی فروشنده افزایش پیدا می‌کند.</li><li>Webhook به سایت فروشنده ارسال می‌شود.</li></ol><div class="info">آدرس پایه API:<span class="urlbox">${base}</span></div></div><div class="card"><h2>دریافت API Key و API Secret</h2><p>فروشنده باید وارد ربات شود و از بخش <b>API فروشگاهی</b> کلیدهای خود را دریافت کند.</p><p>ربات: <a class="ltr" href="https://t.me/${bot}">@${bot}</a></p><div class="table-wrap"><table class="table"><tr><th>کلید</th><th>کاربرد</th></tr><tr><td><span class="inline">API Key</span></td><td>برای احراز هویت درخواست‌های API استفاده می‌شود.</td></tr><tr><td><span class="inline">API Secret</span></td><td>برای اعتبارسنجی امضای Webhook استفاده می‌شود و نباید در فرانت‌اند قرار بگیرد.</td></tr></table></div><div class="warn">API Key و API Secret را در اختیار مشتری، مرورگر یا افراد دیگر قرار ندهید.</div></div><div class="card"><h2>احراز هویت API</h2><pre>X-API-Key: YOUR_SELLER_API_KEY</pre><p>روش Bearer Token هم پشتیبانی می‌شود:</p><pre>Authorization: Bearer YOUR_SELLER_API_KEY</pre></div><div class="card"><h2>واحد پول و مبلغ</h2><div class="table-wrap"><table class="table"><tr><th>currency</th><th>توضیح</th></tr><tr><td><span class="inline">IRT</span></td><td>مبلغ به تومان ارسال می‌شود. مقدار پیش‌فرض همین است.</td></tr><tr><td><span class="inline">IRR</span></td><td>مبلغ به ریال ارسال می‌شود.</td></tr></table></div><p>حداقل مبلغ پرداخت: <b>۱۰,۰۰۰ تومان</b></p><p>کارمزد فعلی سیستم: <b>${fee}%</b></p></div><div class="card"><h2>ساخت سفارش پرداخت</h2><pre>POST ${base}/api/v1/payment/create
Content-Type: application/json
X-API-Key: YOUR_SELLER_API_KEY</pre><h3>Body</h3><pre>{
  "amount": 500000,
  "currency": "IRT",
  "order_id": "ORDER-1025",
  "description": "خرید سرویس یک‌ماهه",
  "customer_name": "Ali Ahmadi",
  "customer_mobile": "09120000000",
  "callback_url": "https://shop.com/payment/callback",
  "webhook_url": "https://shop.com/api/payment/webhook"
}</pre><h3>پارامترها</h3><div class="table-wrap"><table class="table"><tr><th>نام</th><th>اجباری؟</th><th>توضیح</th></tr><tr><td><span class="inline">amount</span></td><td>بله</td><td>مبلغ سفارش.</td></tr><tr><td><span class="inline">currency</span></td><td>خیر</td><td>IRT یا IRR.</td></tr><tr><td><span class="inline">order_id</span></td><td>بله</td><td>شناسه سفارش در سیستم فروشنده.</td></tr><tr><td><span class="inline">description</span></td><td>بله</td><td>توضیح پرداخت.</td></tr><tr><td><span class="inline">callback_url</span></td><td>خیر</td><td>آدرس برگشت مشتری بعد از پرداخت.</td></tr><tr><td><span class="inline">webhook_url</span></td><td>خیر</td><td>آدرس دریافت Webhook.</td></tr></table></div><h3>Response موفق</h3><pre>{
  "success": true,
  "payment_id": "pay_ABCD1234",
  "order_id": "ORDER-1025",
  "amount": 500000,
  "amount_rial": 5000000,
  "fee": 15000,
  "seller_amount": 485000,
  "status": "PENDING",
  "payment_url": "${base}/pay/pay_ABCD1234"
}</pre></div><div class="card"><h2>بررسی وضعیت پرداخت</h2><pre>GET ${base}/api/v1/payment/verify?payment_id=pay_ABCD1234
X-API-Key: YOUR_SELLER_API_KEY</pre><pre>GET ${base}/api/v1/payment/verify?order_id=ORDER-1025
X-API-Key: YOUR_SELLER_API_KEY</pre></div><div class="card"><h2>Webhook پرداخت موفق</h2><pre>POST https://shop.com/api/payment/webhook
Content-Type: application/json
X-BluePay-Event: payment.completed
X-BluePay-Signature: HMAC_SHA256_SIGNATURE</pre><h3>Payload</h3><pre>{
  "event": "payment.completed",
  "payment_id": "pay_ABCD1234",
  "order_id": "ORDER-1025",
  "status": "PAID",
  "amount": 500000,
  "amount_rial": 5000000,
  "fee": 15000,
  "seller_amount": 485000,
  "paid_at": "2026-07-08T20:30:00.000Z"
}</pre><div class="warn">برای فعال‌سازی سفارش، فقط به برگشت کاربر از صفحه پرداخت اعتماد نکنید. فعال‌سازی باید با Webhook یا Verify API انجام شود.</div></div><div class="card"><h2>اعتبارسنجی امضای Webhook</h2><pre>signature = HMAC_SHA256(raw_request_body, API_SECRET)</pre><h3>نمونه PHP</h3><pre>&lt;?php
$apiSecret = "YOUR_API_SECRET";
$rawBody = file_get_contents("php://input");
$receivedSignature = $_SERVER["HTTP_X_BLUEPAY_SIGNATURE"] ?? "";
$calculatedSignature = hash_hmac("sha256", $rawBody, $apiSecret);
if (!hash_equals($calculatedSignature, $receivedSignature)) {
  http_response_code(401);
  exit("Invalid signature");
}
$data = json_decode($rawBody, true);
if ($data["event"] === "payment.completed" && $data["status"] === "PAID") {
  // activateOrder($data["order_id"], $data["payment_id"]);
}
http_response_code(200);
echo "OK";
?&gt;</pre></div><div class="card"><h2>نمونه اتصال با PHP</h2><pre>&lt;?php
$apiKey = "YOUR_SELLER_API_KEY";
$payload = [
  "amount" =&gt; 500000,
  "currency" =&gt; "IRT",
  "order_id" =&gt; "ORDER-" . time(),
  "description" =&gt; "خرید سرویس یک‌ماهه",
  "webhook_url" =&gt; "https://shop.com/api/payment/webhook"
];
$ch = curl_init("${base}/api/v1/payment/create");
curl_setopt($ch, CURLOPT_HTTPHEADER, ["Content-Type: application/json", "X-API-Key: " . $apiKey]);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$response = curl_exec($ch);
$data = json_decode($response, true);
if (!empty($data["success"])) {
  header("Location: " . $data["payment_url"]);
  exit;
}
echo "Error";
?&gt;</pre></div><div class="card"><h2>کدهای خطا</h2><div class="table-wrap"><table class="table"><tr><th>Error</th><th>توضیح</th></tr><tr><td><span class="inline">unauthorized</span></td><td>API Key اشتباه است یا فروشنده فعال نیست.</td></tr><tr><td><span class="inline">amount_required</span></td><td>مبلغ ارسال نشده یا معتبر نیست.</td></tr><tr><td><span class="inline">amount_too_low</span></td><td>مبلغ کمتر از حداقل مجاز است.</td></tr><tr><td><span class="inline">order_id_required</span></td><td>شناسه سفارش ارسال نشده است.</td></tr><tr><td><span class="inline">not_found</span></td><td>پرداخت یا سفارش پیدا نشد.</td></tr></table></div></div><div class="card"><h2>آدرس‌های مهم</h2><p>ساخت پرداخت:</p><span class="urlbox">${base}/api/v1/payment/create</span><p>بررسی پرداخت:</p><span class="urlbox">${base}/api/v1/payment/verify</span><p>مستندات:</p><span class="urlbox">${base}/docs</span><p>ربات:</p><span class="urlbox">https://t.me/${bot}</span></div><div class="footer">BluePay API Documentation — Powered by BluePay Gateway</div></div></body></html>`);
}

/* =========================
   Public Payment Page
========================= */

async function publicPaymentPage(request, env) {
  const url = new URL(request.url);
  const token = decodeURIComponent(url.pathname.split("/").filter(Boolean)[1] || "");

  const apiPayment = await env.DB.prepare(
    `SELECT p.*, s.title, s.username, s.status AS seller_status
     FROM payments p JOIN sellers s ON s.id=p.seller_id
     WHERE p.public_payment_id=?`
  ).bind(token).first();

  if (apiPayment) {
    let freshPayment = apiPayment;
    if (freshPayment.status !== "PAID" && freshPayment.invoice_id && env.SYNC_ON_PUBLIC_PAYMENT !== "false") {
      freshPayment = await syncPaymentFromBlupal(env, freshPayment).catch(() => freshPayment);
    }
    return apiPaymentPage(env, freshPayment);
  }

  const link = await env.DB.prepare(
    `SELECT pl.*, s.title, s.username, s.status AS seller_status
     FROM payment_links pl JOIN sellers s ON s.id=pl.seller_id
     WHERE pl.token=?`
  ).bind(token).first();

  if (!link || link.status !== "ACTIVE" || link.seller_status !== "ACTIVE") return html(errorHtml("لینک پرداخت معتبر نیست یا غیرفعال شده است."), 404);

  const sellerTelegram = link.username ? `https://t.me/${link.username}` : "";
  return html(paymentPageHtml({
    sellerTitle: link.title,
    amountToman: rialToToman(link.amount_rial),
    description: link.description || "-",
    sellerTelegram,
    payButtonAction: `createInvoice()`,
    extraScript: `
      const token = ${JSON.stringify(token)};
      async function createInvoice() {
        setStatus("در حال ساخت فاکتور و انتقال به صفحه پرداخت...", "info");
        try {
          const res = await fetch("/api/payment/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.message || data.error || "خطا در ساخت فاکتور");
          location.href = data.payment_link;
        } catch (e) { setStatus("خطا: " + e.message, "err"); }
      }
    `,
  }));
}

function apiPaymentPage(env, payment) {
  if (payment.status === "PAID") return html(successPaymentHtml(env, payment));
  if (!payment.payment_link) return html(errorHtml("لینک پرداخت موجود نیست."), 404);
  const sellerTelegram = payment.username ? `https://t.me/${payment.username}` : "";
  return html(paymentPageHtml({
    sellerTitle: payment.title,
    amountToman: rialToToman(payment.amount_rial),
    description: payment.order_id || "سفارش پرداخت",
    sellerTelegram,
    payButtonAction: `location.href=${JSON.stringify(payment.payment_link)}`,
    extraScript: "",
  }));
}

function paymentPageHtml({ sellerTitle, amountToman, description, sellerTelegram, payButtonAction, extraScript }) {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>پرداخت به ${esc(sellerTitle)}</title><style>*{box-sizing:border-box}body{margin:0;font-family:Tahoma,Arial,sans-serif;min-height:100vh;background:linear-gradient(135deg,#eaf4ff,#fff);display:flex;align-items:center;justify-content:center;padding:24px;color:#0f172a}.card{width:100%;max-width:440px;background:#fff;border-radius:28px;padding:28px;box-shadow:0 24px 70px rgba(37,99,235,.15);text-align:center}.logo{width:76px;height:76px;border-radius:24px;background:linear-gradient(135deg,#2563eb,#38bdf8);color:#fff;font-size:34px;font-weight:bold;display:flex;align-items:center;justify-content:center;margin:0 auto 18px}h1{font-size:22px;margin:0 0 10px}.desc{color:#64748b;line-height:2;font-size:14px;margin-bottom:22px}.box{background:#f8fbff;border:1px solid #dbeafe;border-radius:20px;padding:18px;margin:18px 0;text-align:right}.row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px dashed #e2e8f0;font-size:14px}.row:last-child{border-bottom:none}.label{color:#64748b}.value{font-weight:bold;direction:ltr;text-align:left}button,.btn{width:100%;display:block;border:none;text-decoration:none;background:#2563eb;color:#fff;padding:15px;border-radius:16px;font-size:16px;font-weight:bold;margin-top:12px;cursor:pointer}.secondary{background:#f1f5f9;color:#334155}.status{display:none;margin-top:14px;padding:12px;border-radius:14px;font-size:14px;line-height:1.8}.status.show{display:block}.status.info{background:#eff6ff;color:#1d4ed8}.status.err{background:#fef2f2;color:#b91c1c}.note{margin-top:18px;color:#94a3b8;font-size:12px;line-height:1.8}</style></head><body><div class="card"><div class="logo">B</div><h1>پرداخت امن</h1><div class="desc">پرداخت به فروشنده خدماتی از طریق درگاه واسط</div><div class="box"><div class="row"><span class="label">فروشنده</span><span class="value">${esc(sellerTitle)}</span></div><div class="row"><span class="label">مبلغ</span><span class="value">${fmt(amountToman)} تومان</span></div><div class="row"><span class="label">توضیحات</span><span class="value">${esc(description || "-")}</span></div></div><button onclick="${payButtonAction}">پرداخت</button>${sellerTelegram ? `<a class="btn secondary" href="${sellerTelegram}">ارتباط با فروشنده</a>` : ""}<div id="status" class="status"></div><div class="note">پس از پرداخت موفق، سفارش به‌صورت خودکار پردازش می‌شود.</div></div><script>function setStatus(text,type){const el=document.getElementById("status");el.className="status show "+(type||"info");el.textContent=text}${extraScript || ""}</script></body></html>`;
}

function successPaymentHtml(env, payment) {
  const callback = payment.callback_url || "";
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>پرداخت موفق</title><style>body{margin:0;font-family:Tahoma,Arial;background:linear-gradient(135deg,#ecfdf5,#fff);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;color:#0f172a}.card{background:white;border-radius:28px;padding:32px;max-width:430px;width:100%;text-align:center;box-shadow:0 24px 70px rgba(16,185,129,.15)}.logo{width:76px;height:76px;border-radius:50%;background:#10b981;color:white;display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:bold;margin:0 auto 18px}h1{font-size:22px;margin:0 0 12px}p{color:#64748b;line-height:2}a{display:block;text-decoration:none;background:#10b981;color:#fff;padding:15px;border-radius:16px;margin-top:12px;font-weight:bold}.secondary{background:#f1f5f9;color:#334155}</style></head><body><div class="card"><div class="logo">✓</div><h1>پرداخت موفق</h1><p>پرداخت شما با موفقیت ثبت شده است.</p>${callback ? `<a href="${esc(callback)}">بازگشت به فروشگاه</a>` : ""}<a class="secondary" href="https://t.me/${botUsername(env)}">بازگشت به ربات</a></div></body></html>`;
}

function errorHtml(message) {
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>خطا</title><style>body{margin:0;font-family:Tahoma,Arial;background:#f8fafc;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;color:#0f172a}.card{background:white;border-radius:24px;padding:28px;max-width:420px;text-align:center;box-shadow:0 18px 60px rgba(15,23,42,.08)}h1{font-size:22px}p{color:#64748b;line-height:2}</style></head><body><div class="card"><h1>خطا</h1><p>${esc(message)}</p></div></body></html>`;
}

function returnPage(env) {
  const username = botUsername(env);
  return html(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>بازگشت از پرداخت</title><style>body{margin:0;font-family:Tahoma,Arial;background:linear-gradient(135deg,#eaf4ff,#fff);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;color:#0f172a}.card{background:white;border-radius:28px;padding:32px;max-width:430px;width:100%;text-align:center;box-shadow:0 24px 70px rgba(37,99,235,.15)}.logo{width:76px;height:76px;border-radius:50%;background:linear-gradient(135deg,#2563eb,#38bdf8);color:white;display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:bold;margin:0 auto 18px}h1{font-size:22px;margin:0 0 12px}p{color:#64748b;line-height:2}a{display:block;text-decoration:none;background:#2563eb;color:#fff;padding:15px;border-radius:16px;margin-top:12px;font-weight:bold}.secondary{background:#f1f5f9;color:#334155}.note{font-size:13px;color:#94a3b8;margin-top:16px;line-height:1.8}</style></head><body><div class="card"><div class="logo">✓</div><h1>بازگشت از پرداخت</h1><p>درخواست شما ثبت شد. وضعیت پرداخت به‌صورت خودکار بررسی می‌شود.</p><a href="tg://resolve?domain=${username}">بازگشت به ربات تلگرام</a><a class="secondary" href="https://t.me/${username}">باز کردن ربات از طریق لینک</a><div class="note">@${esc(username)}</div></div></body></html>`);
}

/* =========================
   Manual Payment Invoice / Blupal
========================= */

async function apiCreatePaymentInvoice(request, env) {
  need(env, ["BLUPAL_API_KEY"]);
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const body = await request.json().catch(() => null);
  if (!body?.token) return json({ ok: false, error: "token_required" }, 400);

  const link = await env.DB.prepare(
    `SELECT pl.*, s.title, s.telegram_id, s.username, s.status AS seller_status
     FROM payment_links pl JOIN sellers s ON s.id=pl.seller_id
     WHERE pl.token=?`
  ).bind(String(body.token)).first();

  if (!link || link.status !== "ACTIVE" || link.seller_status !== "ACTIVE") return json({ ok: false, error: "invalid_link", message: "لینک پرداخت معتبر نیست" }, 404);

  const publicPaymentId = generatePaymentId();
  const created = await createBlupalInvoice(env, Number(link.amount_rial));
  const fee = getFeeRial(env, link.amount_rial);
  const net = Math.max(0, Number(link.amount_rial) - fee);
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || null;

  await env.DB.prepare(
    `INSERT INTO payments (public_payment_id, invoice_id, link_id, seller_id, amount_rial, final_amount_rial, fee_rial, net_rial, status, payment_link, card_number, customer_ip, api_created, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).bind(publicPaymentId, created.invoice_id, link.id, link.seller_id, Number(created.amount), Number(created.final_amount), fee, net, created.status || "PENDING", created.payment_link || null, created.card_number || null, ip, nowIso()).run();

  await sendMessage(env, link.telegram_id, `🧾 <b>فاکتور جدید برای مشتری ساخته شد</b>\n\n<b>مبلغ:</b>\n<code>${fmt(rialToToman(link.amount_rial))}</code> تومان\n\n<b>توضیحات:</b>\n${esc(link.description || "-")}\n\n<b>شماره فاکتور:</b>\n<code>${created.invoice_id}</code>`);
  return json({ ok: true, invoice_id: created.invoice_id, payment_link: created.payment_link, final_amount: created.final_amount });
}

async function createBlupalInvoice(env, amountRial) {
  need(env, ["BLUPAL_API_KEY"]);
  const body = { amount: Number(amountRial) };
  if (env.DEFAULT_CARD_NUMBER) body.card_number = env.DEFAULT_CARD_NUMBER;
  const res = await fetch(`${BLUPAL_BASE_URL}/v1/invoices/create`, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": env.BLUPAL_API_KEY }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.message || data?.error || "خطا در ساخت فاکتور بلوپال");
  return data;
}

async function getBlupalInvoice(env, invoiceId) {
  need(env, ["BLUPAL_API_KEY"]);
  const res = await fetch(`${BLUPAL_BASE_URL}/v1/invoices/${invoiceId}`, { method: "GET", headers: { "X-API-Key": env.BLUPAL_API_KEY } });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.message || data?.error || "خطا در بررسی فاکتور بلوپال");
  return data;
}


async function publicPaymentStatus(request, env) {
  const url = new URL(request.url);
  const paymentId = url.searchParams.get("payment_id") || url.searchParams.get("id");
  if (!paymentId) return json({ ok: false, error: "payment_id_required" }, 400);

  let payment = await env.DB.prepare(`SELECT * FROM payments WHERE public_payment_id=?`).bind(String(paymentId)).first();
  if (!payment) return json({ ok: false, error: "not_found" }, 404);

  if (payment.status !== "PAID" && payment.invoice_id && env.SYNC_ON_PUBLIC_STATUS !== "false") {
    payment = await syncPaymentFromBlupal(env, payment).catch(() => payment);
  }

  return json({
    ok: true,
    payment_id: payment.public_payment_id,
    order_id: payment.order_id || null,
    status: payment.status,
    paid_at: payment.paid_at || null,
    amount_toman: rialToToman(payment.amount_rial),
  });
}

async function syncPaymentFromBlupal(env, payment) {
  if (!payment || !payment.invoice_id || payment.status === "PAID") return payment;

  const remote = await getBlupalInvoice(env, payment.invoice_id);
  const remoteStatus = String(remote.status || "").toUpperCase();

  if (remoteStatus === "PAID") {
    await processPaidWebhook({
      event: "payment.completed",
      invoice_id: Number(payment.invoice_id),
      status: "PAID",
      amount: Number(remote.amount || payment.amount_rial),
      final_amount: Number(remote.final_amount || payment.final_amount_rial || payment.amount_rial),
      paid_at: remote.paid_at || nowIso(),
    }, env);
  } else if (["CANCELED", "EXPIRED", "FAILED"].includes(remoteStatus)) {
    try {
      await env.DB.prepare(`UPDATE payments SET status=?, verified_by=?, webhook_payload=? WHERE id=? AND status <> 'PAID'`)
        .bind(remoteStatus, "blupal_api_sync", JSON.stringify(remote), payment.id)
        .run();
    } catch (_) {}
  }

  return env.DB.prepare(`SELECT * FROM payments WHERE id=?`).bind(payment.id).first();
}

/* =========================
   Blupal Webhook
========================= */

async function blupalWebhook(request, env, ctx) {
  need(env, ["BLUPAL_WEBHOOK_SECRET"]);
  const url = new URL(request.url);
  const secret = decodeURIComponent(url.pathname.split("/").filter(Boolean)[1] || "");
  if (secret !== env.BLUPAL_WEBHOOK_SECRET) return json({ received: false, error: "forbidden" }, 403);
  if (request.method !== "POST") return json({ received: false, error: "method_not_allowed" }, 405);
  const payload = await request.json().catch(() => null);
  if (!payload || payload.event !== "payment.completed" || payload.status !== "PAID") return json({ received: false, error: "invalid_payload" }, 400);
  ctx.waitUntil(processPaidWebhook(payload, env));
  return json({ received: true });
}

async function processPaidWebhook(payload, env) {
  const invoiceId = Number(payload.invoice_id);
  await env.DB.prepare(`INSERT INTO webhook_events (invoice_id, event, payload, created_at) VALUES (?, ?, ?, ?)`).bind(invoiceId || null, payload.event || null, JSON.stringify(payload), nowIso()).run();

  const payment = await env.DB.prepare(
    `SELECT p.*, s.telegram_id, s.title, s.balance_rial, s.api_secret, s.default_webhook_url
     FROM payments p JOIN sellers s ON s.id=p.seller_id
     WHERE p.invoice_id=?`
  ).bind(invoiceId).first();

  if (!payment) { await notifyAdmins(env, `⚠️ <b>وبهوک پرداخت دریافت شد اما پرداخت پیدا نشد</b>\n\n<b>Invoice ID:</b>\n<code>${invoiceId}</code>`); return; }
  if (payment.status === "PAID") return;

  const amountMatches = Number(payment.amount_rial) === Number(payload.amount) && Number(payment.final_amount_rial) === Number(payload.final_amount);
  if (!amountMatches) { await notifyAdmins(env, `🚨 <b>مغایرت مبلغ در وبهوک</b>\n\n<b>Invoice ID:</b>\n<code>${invoiceId}</code>`); return; }

  let remote = null;
  let apiStatus = "UNKNOWN";
  try { remote = await getBlupalInvoice(env, invoiceId); apiStatus = remote.status || "UNKNOWN"; } catch (_) { apiStatus = "API_ERROR"; }
  const apiConfirmed = remote?.status === "PAID";
  if (env.STRICT_API_VERIFY === "true" && !apiConfirmed) { await notifyAdmins(env, `⚠️ وبهوک PAID است اما API هنوز تأیید نکرده.\n\nInvoice ID: ${invoiceId}\nAPI Status: ${apiStatus}`); return; }

  const paidAt = remote?.paid_at || nowIso();
  const updatePaid = await env.DB.prepare(`UPDATE payments SET status='PAID', paid_at=?, verified_by=?, webhook_payload=? WHERE invoice_id=? AND status <> 'PAID'`).bind(paidAt, apiConfirmed ? "api" : "webhook_amount_match", JSON.stringify(payload), invoiceId).run();
  if (!updatePaid.meta || Number(updatePaid.meta.changes || 0) < 1) return;

  const seller = await getSellerById(env, payment.seller_id);
  if (!seller) return;
  const newBalance = Number(seller.balance_rial) + Number(payment.net_rial);
  await env.DB.prepare(`UPDATE sellers SET balance_rial=?, total_sales_rial=total_sales_rial+?, total_fee_rial=total_fee_rial+?, updated_at=? WHERE id=?`).bind(newBalance, Number(payment.amount_rial), Number(payment.fee_rial), nowIso(), seller.id).run();
  await addLedger(env, seller.id, "SALE_CREDIT", Number(payment.net_rial), newBalance, "payment", String(payment.id), "افزایش موجودی بابت پرداخت موفق مشتری");

  await sendMessage(env, seller.telegram_id, `✅ <b>پرداخت موفق دریافت شد</b>\n\n<b>فروشنده:</b>\n${esc(seller.title)}\n\n<b>Order ID:</b>\n${payment.order_id ? `<code>${esc(payment.order_id)}</code>` : "-"}\n\n<b>Payment ID:</b>\n${payment.public_payment_id ? `<code>${esc(payment.public_payment_id)}</code>` : "-"}\n\n<b>مبلغ پرداخت:</b>\n<code>${fmt(rialToToman(payment.amount_rial))}</code> تومان\n\n<b>کارمزد:</b>\n<code>${fmt(rialToToman(payment.fee_rial))}</code> تومان\n\n<b>اضافه‌شده به موجودی:</b>\n<code>${fmt(rialToToman(payment.net_rial))}</code> تومان\n\n<b>موجودی فعلی:</b>\n<code>${fmt(rialToToman(newBalance))}</code> تومان\n\n<b>شماره فاکتور:</b>\n<code>${invoiceId}</code>`);

  await notifyAdmins(env, `✅ <b>پرداخت موفق در درگاه واسط</b>\n\n<b>فروشنده:</b>\n${esc(seller.title)}\n\n<b>Invoice ID:</b>\n<code>${invoiceId}</code>\n\n<b>Payment ID:</b>\n${payment.public_payment_id ? `<code>${esc(payment.public_payment_id)}</code>` : "-"}\n\n<b>مبلغ:</b>\n<code>${fmt(rialToToman(payment.amount_rial))}</code> تومان\n\n<b>کارمزد سیستم:</b>\n<code>${fmt(rialToToman(payment.fee_rial))}</code> تومان\n\n<b>خالص فروشنده:</b>\n<code>${fmt(rialToToman(payment.net_rial))}</code> تومان\n\n<b>API Status:</b>\n<code>${apiStatus}</code>`);

  await sendSellerWebhook(env, payment, seller, paidAt);
}

/* =========================
   Seller Webhook
========================= */

async function sendSellerWebhook(env, payment, seller, paidAt) {
  const targetUrl = payment.webhook_url || seller.default_webhook_url;
  if (!targetUrl || !seller.api_secret) return;

  const payload = { event: "payment.completed", payment_id: payment.public_payment_id, order_id: payment.order_id, status: "PAID", amount: rialToToman(payment.amount_rial), amount_rial: Number(payment.amount_rial), final_amount_rial: Number(payment.final_amount_rial), fee: rialToToman(payment.fee_rial), fee_rial: Number(payment.fee_rial), seller_amount: rialToToman(payment.net_rial), seller_amount_rial: Number(payment.net_rial), paid_at: paidAt };
  const raw = JSON.stringify(payload);
  const signature = await hmacHex(seller.api_secret, raw);

  let ok = false;
  let error = "";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), 8000);
    const res = await fetch(targetUrl, { method: "POST", headers: { "Content-Type": "application/json", "X-BluePay-Event": "payment.completed", "X-BluePay-Signature": signature }, body: raw, signal: controller.signal });
    clearTimeout(timer);
    ok = res.status >= 200 && res.status < 300;
    if (!ok) error = `HTTP ${res.status}`;
  } catch (err) { error = String(err?.message || err); }

  await env.DB.prepare(`UPDATE payments SET seller_webhook_sent=?, seller_webhook_attempts=seller_webhook_attempts+1, seller_webhook_last_error=? WHERE id=?`).bind(ok ? 1 : 0, ok ? null : error, payment.id).run();
  if (!ok) await notifyAdmins(env, `⚠️ <b>Webhook فروشنده ارسال نشد</b>\n\n<b>Payment ID:</b>\n<code>${esc(payment.public_payment_id || "-")}</code>\n\n<b>Order ID:</b>\n<code>${esc(payment.order_id || "-")}</code>\n\n<b>URL:</b>\n${esc(targetUrl)}\n\n<b>Error:</b>\n<code>${esc(error)}</code>`);
}

/* =========================
   Telegram Mini App Auth + HMAC
========================= */

async function verifyTelegramWebAppInitData(initData, env) {
  if (!initData) return { ok: false, error: "empty_init_data" };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, error: "hash_missing" };
  const pairs = [];
  for (const [key, value] of params.entries()) if (key !== "hash") pairs.push([key, value]);
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([key, value]) => `${key}=${value}`).join("\n");
  const secretKey = await hmacBytes("WebAppData", env.BOT_TOKEN);
  const calculatedHash = bytesToHex(await hmacBytes(secretKey, dataCheckString));
  if (!safeEqualHex(calculatedHash, hash)) return { ok: false, error: "invalid_hash" };

  const authDate = Number(params.get("auth_date") || 0);
  const maxAge = Number(env.TELEGRAM_INIT_MAX_AGE_SECONDS || 604800);
  if (maxAge > 0 && authDate > 0 && Math.floor(Date.now() / 1000) - authDate > maxAge) return { ok: false, error: "init_data_expired" };

  let user = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch (_) {}
  return { ok: true, user };
}

async function hmacBytes(key, data) {
  const enc = new TextEncoder();
  const keyBytes = typeof key === "string" ? enc.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  return new Uint8Array(sig);
}

async function hmacHex(key, data) { return bytesToHex(await hmacBytes(key, data)); }
function bytesToHex(bytes) { return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(""); }
function safeEqualHex(a, b) {
  const x = String(a || "").toLowerCase();
  const y = String(b || "").toLowerCase();
  if (x.length !== y.length) return false;
  let out = 0;
  for (let i = 0; i < x.length; i++) out |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return out === 0;
}

async function notifyAdmins(env, text, extra = {}) {
  const ids = adminIds(env);
  if (!ids.length) return;
  await Promise.allSettled(ids.map((id) => sendMessage(env, id, text, extra)));
}
