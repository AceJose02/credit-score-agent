# Credit Score AI Agent

A local web app that reads your credit card profile and writes a plan to raise your score. It runs on your own computer and uses Claude (Anthropic) or OpenAI, whichever you have a key for.

Your API keys live in a `.env` file and never reach the browser. The plan streams in as it's written, and you can stop it at any time.

What it can do:

- **Write a plan** from your score, goal and cards, with **charts** (balances, utilization, an estimated score path) and **tables** (payment schedules) drawn right in the page.
- **Answer follow-up questions.** The AI already knows your numbers and the plan it wrote, and can answer with its own charts and tables.
- **Export** the whole thing, including summary, cards, plan, charts and your questions, as a **PDF** or **Word** document. Any table can also be saved as a **CSV** spreadsheet.
- Remember your numbers, plan and questions in this browser between visits.

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
Browser  (no keys; sends only your score and card numbers)
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
│   ├── profile.js       ← validation and prompts (plan + follow-up questions)
│   └── providers.js     ← model list, Anthropic + OpenAI adapters, error messages
└── public/              ← the frontend (no build step)
    ├── index.html       ← markup and styles
    └── js/
        ├── app.js       ← page logic: score rail, cards, plan, questions, downloads
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
