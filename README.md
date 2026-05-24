# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

---

## KKB Webhook

Serverless webhook service for "Kaam Ki Baat" — receives call-completion events from Bolna/Raya, extracts metrics + profile data via OpenAI, writes to Google Sheets, and updates the Dhiway profile API. Lives in `api/` and `utils/` alongside the frontend in this same Vercel project.

Endpoints:
- `POST /api/webhook` — receives the call event; returns 200 immediately and processes asynchronously via `waitUntil`.
- `GET /api/health` — health check.

### Deployment

1. **Encode the service account JSON:**
   ```
   base64 -i service-account.json | tr -d '\n'
   ```
   Paste the result as `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` in Vercel env vars.

2. **Set all env vars** in the Vercel dashboard (see `.env.example`):
   - `OPENAI_API_KEY`
   - `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`
   - `SPREADSHEET_ID`
   - `UPDATE_PROFILE_API_URL`
   - `UPDATE_PROFILE_API_KEY`

3. **Deploy:** `vercel --prod`

4. **Point Bolna/Raya** webhook to: `https://<your-project>.vercel.app/api/webhook`

5. **Create the `Errors` tab** in the spreadsheet (exact name: `Errors`) with header row:
   `timestamp_ist | call_id | phone | task | error_message | stack_trace | retry_attempted | retry_succeeded`

6. **Share the spreadsheet** with the service-account email (Editor access).

## Chatbot setup (transcript-aware RAG)

The dashboard has a floating "KKB Analyst" chat panel that queries a Pinecone
vector store of recent transcripts. Setup:

1. **Add Pinecone env vars** (Vercel + local `.env.local`):
   - `PINECONE_API_KEY`
   - `PINECONE_INDEX_HOST` (e.g. `https://kkb-dkb-transcripts-3am8ycn.svc.aped-4627-b74a.pinecone.io`)
   - `PINECONE_NAMESPACE=kkb`

2. **Create the `EmbedManifest` tab** in the spreadsheet (exact name: `EmbedManifest`)
   with header row: `call_id | call_datetime_ist | namespace`. The code manages
   all rows automatically after that.

3. **Backfill existing transcripts** (one-shot, idempotent):
   ```bash
   node --env-file=.env.local scripts/bulk-embed.js
   ```
   Caps at 200 vectors per namespace (Pinecone free-tier rolling window).

After setup, every new webhook call automatically embeds + upserts + evicts.
