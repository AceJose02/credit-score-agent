# Credit Score AI Agent

A local web app that reads your credit profile (scores, cards and loans) and writes a plan to raise your score. It runs on your own computer and uses Claude (Anthropic) or OpenAI, whichever you have a key for.

Your API keys live in a `.env` file and never reach the browser. The plan streams in as it's written, and you can stop it at any time.

What it can do:

- **Pick your score type and bureau**, the same way you pick the AI model: FICO or VantageScore 3.0, from Equifax, Experian, TransUnion or "not sure". The score scale switches to that model's own ranges (VantageScore's "Good" starts at 661, FICO's at 670).
- **Don't know your score?** Choose "I don't know my score". The AI won't guess one; it works from your cards and loans and suggests a free way to check.
- **Scores from other bureaus (optional).** Add FICO and VantageScore 3.0 from the other bureaus if you have them. The app shows your middle FICO (the one mortgage lenders commonly use) and flags gaps of 20+ points worth checking.
- **Track loans** (auto, mortgage, student, personal) with balance, original amount, APR and monthly payment. The app works out how much is paid off and the months and interest left. Cards take an APR too, so the AI can weigh interest against score impact.
- **Write a plan** from all of the above, with **charts** (balances, utilization, an estimated score path) and **tables** (payment schedules) drawn right in the page.
- **Answer follow-up questions.** The AI already knows your numbers and the plan it wrote, and can answer with its own charts and tables.
- **Export** the whole thing, including summary, cards, plan, charts and your questions, as a **PDF** or **Word** document. Any table can also be saved as a **CSV** spreadsheet.
- Remember your numbers, plan and questions in this browser between visits.

> **Where do the bureau scores come from?** You enter them. The app can't pull scores from the bureaus directly: that needs a business agreement with each bureau and a legally permitted purpose under the Fair Credit Reporting Act. Many banks and card issuers show a free FICO score, and free credit-monitoring services show VantageScore 3.0. Free credit *reports* from all three bureaus are at [AnnualCreditReport.com](https://www.annualcreditreport.com).

---

## Quick start

Requires **Node.js 22 or newer** (`node --version` to check).

### 1. Install dependencies
```bash
npm install
```

### 2. Create your `.env` file

> **The app will not work without this step.** API keys are never included in the repo.

Copy the example file to create your own:

```bash
cp .env.example .env
```

Then open `.env` in any text editor and paste in at least one key:

```env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

Where to get keys:
- **Anthropic (Claude):** https://platform.claude.com
- **OpenAI:** https://platform.openai.com/api-keys

You only need a key for the provider you want to use. The app disables any provider whose key is missing and tells you exactly what to add. The `.env` file is listed in `.gitignore` so it will never be committed to GitHub by accident.

See `.env.example` for all available settings (custom port, default model, and so on).

### 3. Start the server
```bash
npm start
```

Open **http://127.0.0.1:3000** in your browser.

---

## Models

Pick the provider and model in the app. The first model in each list is the default.

| Provider | Models | API |
| --- | --- | --- |
| Claude | Sonnet 5 (default), Opus 5.5, Haiku 4.5 | Messages API, streamed |
| OpenAI | GPT-6 Sol (default), GPT-6 Astra, GPT-6 Luna | Responses API, streamed |

To change a default, set `ANTHROPIC_MODEL` or `OPENAI_MODEL` in `.env`. To change the list itself, edit `CATALOG` in `lib/providers.js`.

---

## How it works

```
Browser  (no keys; sends only your scores, cards and loans as numbers)
   │
   │  POST /api/plan  { provider, model, profile }
   │  POST /api/chat  { provider, model, profile, plan, messages }
   ▼
server.js ── validates the profile, builds the prompt (lib/profile.js)
   │         reads keys from .env
   │
   ├──▶ Anthropic  messages.stream()        (@anthropic-ai/sdk)
   └──▶ OpenAI     responses.create(stream) (openai)
   │
   └──▶ streams the answer back as newline-delimited JSON
```

**Charts and tables.** The prompt teaches the model two formats: Markdown tables, and small JSON chart blocks (`bar` or `line`, in `$`, `%` or score points). The page draws those as SVG, so there's no chart library, and the same drawing is turned into images for the PDF and Word files. Colour only ever means credit health: utilization bars use the health colours, and score projections sit over the FICO tier bands.

**Exports** are built in the browser with [pdfmake](https://pdfmake.github.io/docs/) and [docx](https://docx.js.org/), which the server serves from `node_modules` and the page loads only the first time you download a file.

A few deliberate choices:

- **The browser sends numbers, not a prompt.** The server builds the prompt from validated data, so the endpoint can't be used to run arbitrary prompts on your key.
- **Localhost only.** The server listens on `127.0.0.1` by default, and has no CORS, so other websites and other devices on your network can't use it. Set `HOST=0.0.0.0` if you want to reach it from your phone, knowing anyone on the network could then spend your credits.
- **Stopping stops billing.** Pressing Stop, or closing the tab, cancels the request to the provider.
- **OpenAI requests use `store: false`**, so the Responses API doesn't retain your financial details for later retrieval.
- **Your inputs are saved in this browser** (localStorage) so they're there next time. Nothing is saved on the server.

---

## File structure

```
credit-score-agent/
├── .env                 ← your API keys (create from .env.example; never commit)
├── .env.example
├── .gitignore
├── package.json
├── server.js            ← Express server: routes and streaming
├── lib/
│   ├── profile.js       ← validation, prompts, score tiers and loan math (shared with the page)
│   └── providers.js     ← model list, Anthropic + OpenAI adapters, error messages
└── public/              ← the frontend (no build step)
    ├── index.html       ← markup and styles
    └── js/
        ├── app.js       ← page logic: score rail, bureaus, cards, loans, plan, questions, downloads
        ├── engine.js    ← talks to the server (the only file that does)
        ├── markdown.js  ← AI text → blocks → HTML, tables, CSV
        ├── charts.js    ← chart JSON → SVG, and PNG for exports
        └── export.js    ← PDF and Word reports
```

---

## Development

```bash
npm run dev
```

Restarts the server when you save a file (uses Node's built-in `--watch`).

---

This is general guidance, not financial advice.
