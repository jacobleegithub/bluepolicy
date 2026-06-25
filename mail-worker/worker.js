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

    if (!name) return json({ error: "缺少陳情人姓名" }, 400, cors);
    if (!html && !text) return json({ error: "缺少陳情書內容" }, 400, cors);
    if (html.length > 300000 || text.length > 100000) {
      return json({ error: "內容過長" }, 413, cors);
    }

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
    return json({ ok: true, id }, 200, cors);
  },
};

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
