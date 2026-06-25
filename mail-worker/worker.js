/**
 * 陳情書寄信後端 — Cloudflare Worker
 *
 * 由前端（GitHub Pages）POST 過來，後端持有 Resend API key（以 Worker secret 保管，
 * 絕不寫死在程式碼或 repo 內），再呼叫 Resend 寄信。
 *
 * 環境變數（於 Cloudflare 設定）：
 *   RESEND_API_KEY  （secret，必填）  Resend 的 API 金鑰
 *   MAIL_TO         （var，選填）     收件人，預設受文機關信箱
 *   MAIL_FROM       （var，選填）     寄件人，需為 Resend 已驗證網域；
 *                                     未驗證網域前，測試請用 onboarding@resend.dev
 *   ALLOW_ORIGINS   （var，選填）     允許的前端來源，逗號分隔
 */

const DEFAULT_ALLOW = [
  "https://bluepolicy.eponym.online",
  "http://bluepolicy.eponym.online",
  "https://jacobleegithub.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

const DEFAULT_TO = "AR6185@ntpc.gov.tw";
const DEFAULT_FROM = "陳情書系統 <onboarding@resend.dev>";

// 台灣 22 縣市白名單；只接受清單內的值寫入統計，避免任意字串污染 KV
const ALLOWED_CITIES = [
  "臺北市", "新北市", "基隆市", "桃園市", "新竹市", "新竹縣", "苗栗縣",
  "臺中市", "彰化縣", "南投縣", "雲林縣", "嘉義市", "嘉義縣", "臺南市",
  "高雄市", "屏東縣", "宜蘭縣", "花蓮縣", "臺東縣", "澎湖縣", "金門縣", "連江縣",
];

const STATS_KEY = "agg";

export default {
  async fetch(request, env) {
    const allow = (env.ALLOW_ORIGINS
      ? env.ALLOW_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
      : DEFAULT_ALLOW);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, allow);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    // 統計查詢：GET 回傳彙總（總份數與各縣市計數），供統計頁讀取
    if (request.method === "GET") {
      return json(await readStats(env), 200, cors);
    }
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, cors);
    }
    if (!env.RESEND_API_KEY) {
      return json({ error: "伺服器未設定 RESEND_API_KEY" }, 500, cors);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400, cors);
    }

    const name = (data.name || "").toString().trim();
    const replyTo = (data.replyTo || "").toString().trim();
    const subject = (data.subject || "陳情書意見陳述").toString().slice(0, 300);
    const html = (data.html || "").toString();
    const text = (data.text || "").toString();
    const city = normalizeCity(data.city); // 統計用，僅接受縣市白名單

    if (!name) return json({ error: "缺少陳情人姓名" }, 400, cors);
    if (!html && !text) return json({ error: "缺少陳情書內容" }, 400, cors);
    if (html.length > 300000 || text.length > 100000) {
      return json({ error: "內容過長" }, 413, cors);
    }

    // ===== 防濫用 =====
    const ip = request.headers.get("CF-Connecting-IP") || "";
    // 1) 速率限制（KV，便宜，先擋；保護機關信箱與 Resend 額度）
    const limited = await checkRateLimit(env, ip);
    if (limited) return json({ error: limited }, 429, cors);
    // 2) Turnstile 人機驗證（fail closed：未設定 secret 或驗證未過一律拒絕）
    const tsOk = await verifyTurnstile(env, (data.turnstileToken || "").toString(), ip);
    if (!tsOk) return json({ error: "人機驗證未通過，請重新整理頁面後再試。" }, 403, cors);

    // 收件人固定由後端決定（避免被當成任意轉發的開放中繼）
    const to = env.MAIL_TO || DEFAULT_TO;
    // 寄件地址固定在已驗證網域，但顯示名稱帶入陳情人姓名
    const from = buildFrom(name, env.MAIL_FROM || DEFAULT_FROM);

    const payload = {
      from,
      to: [to],
      subject,
      html: html || undefined,
      text: text || undefined,
    };
    // 回信地址設為陳情人 email，方便受文機關直接回覆
    if (replyTo && replyTo.includes("@")) payload.reply_to = replyTo;

    let resp, bodyText;
    try {
      resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      bodyText = await resp.text();
    } catch (e) {
      return json({ error: "無法連線寄信服務", detail: String(e) }, 502, cors);
    }

    if (!resp.ok) {
      let detail = bodyText;
      try { detail = JSON.parse(bodyText).message || detail; } catch { /* keep raw */ }
      return json({ error: "寄送失敗", detail }, 502, cors);
    }

    let id = null;
    try { id = JSON.parse(bodyText).id; } catch { /* ignore */ }

    // 寄送成功才計入統計（只存彙總，不存個資）；統計失敗不影響寄信結果
    await recordStats(env, city);

    return json({ ok: true, id }, 200, cors);
  },
};

// 向 Cloudflare Turnstile 驗證前端送來的 token；任何失敗皆回 false（fail closed）
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return false; // 未設定 secret → 一律拒絕
  if (!token) return false;
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const d = await r.json();
    return d && d.success === true;
  } catch {
    return false;
  }
}

// 速率限制（以現有 KV 實作）：單一 IP 每小時上限 + 全域每日上限。
// 回傳錯誤訊息字串表示超限；null 表示放行。KV 失敗時不阻擋正常寄信。
async function checkRateLimit(env, ip) {
  if (!env.STATS) return null;
  const ipMax = parseInt(env.RL_IP_MAX, 10) || 10;     // 每 IP / 小時
  const dayMax = parseInt(env.RL_DAY_MAX, 10) || 1000;  // 全域 / 日
  try {
    if (ip) {
      const k = "rl:ip:" + ip;
      const n = (parseInt(await env.STATS.get(k), 10) || 0) + 1;
      if (n > ipMax) return "送出過於頻繁，請稍後再試。";
      await env.STATS.put(k, String(n), { expirationTtl: 3600 });
    }
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD（UTC）
    const gk = "rl:day:" + day;
    const g = (parseInt(await env.STATS.get(gk), 10) || 0) + 1;
    if (g > dayMax) return "今日寄送量已達上限，請明日再試。";
    await env.STATS.put(gk, String(g), { expirationTtl: 172800 });
    return null;
  } catch {
    return null;
  }
}

// 縣市消毒：trim 後僅接受白名單內的值，否則回 null（不計入縣市分布）
function normalizeCity(raw) {
  const c = (raw || "").toString().trim();
  return ALLOWED_CITIES.includes(c) ? c : null;
}

// 讀取彙總統計；KV 不存在或解析失敗時回空結構
async function readStats(env) {
  if (!env.STATS) return { total: 0, byCity: {} };
  try {
    const raw = await env.STATS.get(STATS_KEY);
    const agg = raw ? JSON.parse(raw) : null;
    if (agg && typeof agg.total === "number" && agg.byCity) return agg;
  } catch { /* fall through */ }
  return { total: 0, byCity: {} };
}

// 累加統計：總份數 +1，若有有效縣市則該縣市 +1（read-modify-write）
async function recordStats(env, city) {
  if (!env.STATS) return;
  try {
    const agg = await readStats(env);
    agg.total += 1;
    if (city) agg.byCity[city] = (agg.byCity[city] || 0) + 1;
    await env.STATS.put(STATS_KEY, JSON.stringify(agg));
  } catch { /* 統計失敗不影響寄信 */ }
}

/**
 * 以陳情人姓名作為 From 的顯示名稱，地址沿用已驗證網域（Resend 規範：From 網域必須已驗證，
 * 顯示名稱則可自由設定）。姓名為使用者輸入，需消毒以避免 header 注入。
 */
function buildFrom(name, mailFrom) {
  const m = mailFrom.match(/<([^>]+)>/);
  const addr = (m ? m[1] : mailFrom).trim();
  // 去除控制字元（含換行）與引號／反斜線，避免破壞或注入 From 標頭；限制長度
  const clean = name
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/["\\]/g, "")
    .trim()
    .slice(0, 60);
  const display = clean ? `${clean}（陳情人）` : "陳情書系統";
  // 一律加引號，顯示名稱即使含逗號等特殊字元也安全（RFC 5322）
  return `"${display}" <${addr}>`;
}

function corsHeaders(origin, allow) {
  const o = allow.includes(origin) ? origin : allow[0];
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}
