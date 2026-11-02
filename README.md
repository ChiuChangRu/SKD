# 專案排程

醫療器材開發專案的排程／甘特圖工具（公司制式進度管制表 Excel 匯出、鼎新 PLM 的 MS Project XML 匯出、多案件比較、人力分析）。

- **網頁**：`index.html`（GitHub Pages）。**不含任何案件資料**。
- **後端**：`worker/`（Cloudflare Worker + KV）。案件資料與公司 Excel 範本只存在這裡，所有 API 都要 PIN。
- 與其他系統完全獨立：自己的 Worker、自己的 PIN、自己的儲存空間；網頁不連到任何其他網站。

## 部署（一次性）

1. **Worker**：Cloudflare → Workers & Pages → Create → 連結此 GitHub 專案庫（SKD），Root directory 設 `worker`
   （或在 `worker/` 目錄執行 `npx wrangler deploy`）。
2. **設 PIN（機密變數）**：Worker `pm-schedule` → Settings → Variables and Secrets → 新增 Secret，名稱 `PM_PIN`。
   （或 `npx wrangler secret put PM_PIN`）。PIN 只存在 Cloudflare，不會出現在程式碼裡。
3. **GitHub Pages**：Settings → Pages → Branch `main` / root。
4. 網頁裡的 Worker 網址在 `index.html` 的 `PM_API`；若 Worker 網址不是 `https://pm-schedule.<帳號>.workers.dev`，改這一行。
   `worker/wrangler.jsonc` 的 `ALLOWED_ORIGIN` 是允許呼叫 API 的網站來源。
5. 打開網頁 → 輸入 PIN → 「④ 下載」分頁 → 匯入備份 JSON（舊資料與公司 Excel 範本一次匯入）。

## 安全設計

- PIN 用固定時間比對；同一 IP 連續輸錯 8 次鎖 10 分鐘。
- CORS 只放行 `ALLOWED_ORIGIN`（與本機測試用的 localhost）。
- PIN 只存在瀏覽器的 sessionStorage（關掉分頁即清除）；頁面設 `no-referrer`、`noindex`。
- **備份 JSON 含公司資料，請存在自己的電腦，不要放進此專案。**
