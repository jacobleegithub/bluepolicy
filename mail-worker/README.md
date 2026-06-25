# 陳情書寄信後端（Cloudflare Worker + Resend）

前端（GitHub Pages）是靜態網站，無法安全保管 Resend secret key，也無法跨來源直接呼叫
Resend。此 Worker 負責保管金鑰、加上 CORS、再代為呼叫 Resend 寄信。

## 一、安裝 wrangler

```bash
npm install -g wrangler
wrangler login          # 以瀏覽器登入你的 Cloudflare 帳號
```

> 若要在本工作階段直接登入，可在輸入框輸入：`! wrangler login`

## 二、設定金鑰（不會進入 repo）

```bash
cd mail-worker
wrangler secret put RESEND_API_KEY
# 貼上你的 Resend 金鑰（re_...）後按 Enter
```

金鑰存於 Cloudflare，**不會**寫入 `wrangler.toml` 或任何檔案。
> 提醒：先前在對話中以明文出現的那把 key 建議到 Resend 後台重新產生一把再使用。

## 三、部署

```bash
wrangler deploy
```

成功後會得到一個網址，例如：

```
https://bluepolicy-mail.你的子網域.workers.dev
```

## 四、把網址接回前端

編輯專案根目錄的 `index.html`，找到：

```js
var MAIL_ENDPOINT = "https://YOUR-WORKER-SUBDOMAIN.workers.dev";
```

換成上一步的 Worker 網址，commit 後 push，GitHub Pages 會自動更新。

## 收件人與寄件人設定

於 `wrangler.toml` 的 `[vars]`：

| 變數 | 說明 |
| --- | --- |
| `MAIL_TO` | 收件人，預設受文機關 `AR6185@ntpc.gov.tw`。收件人固定由後端決定，避免被當成任意轉發中繼。 |
| `MAIL_FROM` | 寄件人。**需為 Resend 已驗證的網域**。 |
| `ALLOW_ORIGINS` | 允許呼叫的前端來源（CORS），逗號分隔。 |

## ⚠️ Resend 測試限制（很重要）

- 未驗證網域前，`MAIL_FROM` 只能用 `onboarding@resend.dev`，且**收件人只能是你註冊
  Resend 的本人信箱**。要先測通，請暫時把 `wrangler.toml` 的 `MAIL_TO` 改成你自己的
  Email，`wrangler deploy` 後再測。
- 正式對外（寄到 `AR6185@ntpc.gov.tw`）前，需到 Resend 後台
  **Domains → Add Domain** 驗證你的網域，並把 `MAIL_FROM` 改成該網域的寄件地址
  （例如 `no-reply@你的網域`）。

## 信件內容

前端會把整份陳情書（含使用者填寫的表單值、四個對照表）序列化為 HTML 寄出，
並附一份純文字摘要；陳情人 Email 會設為回信地址（reply-to）。
