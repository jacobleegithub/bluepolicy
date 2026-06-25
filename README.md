# 藍色海洋政策 · 陳情書（一頁式網站）

依「陳情書」原文逐字製作的一頁式網站，可線上填寫陳情人基本資料、一鍵產生 PDF 陳情書，並以本機內定郵件服務寄送。

- **內容**：關於「新北市貢寮、萬里、瑞芳水產動植物繁殖保育區及有關限制事項」公告草案之意見陳述
- **受文機關**：新北市政府農業局漁業及漁港事業管理處（AR6185@ntpc.gov.tw）

## 功能

- 📄 完整逐字呈現陳情書全文（壹～柒、附件、簽名欄）
- 📝 線上表單：姓名、聯絡電話、電子郵件、通訊地址、身分、日期、簽名
- 🖨️ **一鍵產生 PDF 陳情書**：使用瀏覽器「列印 → 另存為 PDF」，中文字完整無誤
- ✉️ **以郵件寄送**：透過 Cloudflare Worker 呼叫 [Resend](https://resend.com) 寄出陳情書。整份陳情書（含填寫值與對照表）會序列化為 HTML 寄到受文機關，陳情人 Email 設為回信地址。後端設定請見 [`mail-worker/README.md`](mail-worker/README.md)。
- 📱 支援 RWD：電腦版與手機版自動調整版面

## 本機預覽

直接以瀏覽器開啟 `index.html` 即可，或：

```bash
python3 -m http.server 8080
# 開啟 http://localhost:8080
```

## 部署到 GitHub Pages

倉庫：<https://github.com/jacobleegithub/bluepolicy>

```bash
git init
git add index.html README.md
git commit -m "Add one-page bluepolicy petition website"
git branch -M main
git remote add origin https://github.com/jacobleegithub/bluepolicy.git
git push -u origin main
```

接著於 GitHub 倉庫 **Settings → Pages**：
- **Source**：Deploy from a branch
- **Branch**：`main` / `/ (root)`

儲存後網站將發布於：

```
https://jacobleegithub.github.io/bluepolicy/
```

## 檔案

| 檔案 | 說明 |
| --- | --- |
| `index.html` | 完整自包含的一頁式網站（HTML + CSS + JS，無外部相依） |
| `mail-worker/` | 寄信後端（Cloudflare Worker + Resend），保管 API 金鑰並代為寄信 |
| `README.md` | 本說明文件 |

## 寄信功能（Resend）

寄信走「前端 → Cloudflare Worker → Resend」三段式，金鑰只存在 Worker（不進 repo）。
部署步驟見 [`mail-worker/README.md`](mail-worker/README.md)，重點：

1. `cd mail-worker && wrangler secret put RESEND_API_KEY`（貼上金鑰）
2. `wrangler deploy` 取得 Worker 網址
3. 把 `index.html` 內的 `MAIL_ENDPOINT` 換成該網址，push 即可
