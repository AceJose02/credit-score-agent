# Credit Score AI Agent

A local web app that analyzes your credit card profile and gives you a personalized plan to raise your score — powered by Claude (Anthropic) or GPT-4o (OpenAI).

API keys live in a `.env` file on your machine and are **never exposed** in the browser.

---

## Quick start

### 1. Install dependencies
```bash
npm install
```

### 2. Add your API key(s) to `.env`
Open the `.env` file and fill in one or both keys:

```env
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxx
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

You only need the key for the provider(s) you want to use.  
The provider toggle in the UI will automatically disable any unconfigured provider.

### 3. Start the server
```bash
npm start
```

Then open **http://localhost:3000** in your browser.

---

## How it works

```
Browser (no keys)
     │
     │  POST /api/analyze/anthropic   or   /api/analyze/openai
     ▼
server.js  ──reads──▶  .env  (ANTHROPIC_API_KEY / OPENAI_API_KEY)
     │
     │  forwards request with key in Authorization header
     ▼
Anthropic API  /  OpenAI API
     │
     └──▶  response text back to browser
```

The browser only ever talks to `localhost`. Keys never leave your machine.

---

## File structure

```
credit-score-agent/
├── .env                  ← your API keys (never commit this)
├── .gitignore            ← ignores .env and node_modules
├── package.json
├── server.js             ← Express server / API proxy
└── public/
    └── index.html        ← frontend (no key fields)
```

---

## Development (auto-restart on save)
```bash
npm run dev
```
Requires `nodemon` — installed automatically via `npx`.
