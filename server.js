// ─────────────────────────────────────────────────────────────
//  Credit Score AI Agent — Server
//
//  Reads API keys from .env, validates the credit profile the
//  browser sends, and streams a plan back from Anthropic
//  (Messages API) or OpenAI (Responses API). Keys never reach
//  the browser.
// ─────────────────────────────────────────────────────────────
require('dotenv').config({ quiet: true });

const path    = require('node:path');
const express = require('express');

const { validateProfile, validateChat, buildPrompt, buildChatSystem, ProfileError, SYSTEM_PROMPT } = require('./lib/profile');
const { CATALOG, adapters, isConfigured, findModel, describeProviders, explainError } = require('./lib/providers');

const app  = express();
const PORT = Number(process.env.PORT) || 3000;
// Localhost only by default, so other devices on your network
// can't spend your API credits. Set HOST=0.0.0.0 to share on purpose.
const HOST = process.env.HOST || '127.0.0.1';

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Export libraries, served from node_modules and loaded by the page
// only when someone downloads a PDF or Word file.
const VENDOR = {
  'pdfmake.min.js': 'pdfmake/build/pdfmake.min.js',
  'vfs_fonts.js':   'pdfmake/build/vfs_fonts.js',
  'docx.js':        'docx/dist/index.iife.js',
};
// The profile rules (tiers, loan math) are shared with the page.
app.get('/shared/profile.js', (req, res) => res.sendFile(path.join(__dirname, 'lib', 'profile.js')));

app.get('/vendor/:file', (req, res, next) => {
  const rel = VENDOR[req.params.file];
  if (!rel) return next();
  res.sendFile(path.join(__dirname, 'node_modules', rel), { maxAge: '7d' });
});

// ── Which providers are configured, and their models ─────────
app.get('/api/providers', (req, res) => {
  res.json(describeProviders());
});

// ── Streaming responses ──────────────────────────────────────
//  Both endpoints answer with newline-delimited JSON events:
//    {"type":"start","provider","model"}
//    {"type":"text","text":"..."}            (many)
//    {"type":"done","stopReason","usage"}
//    {"type":"error","message"}               (instead of done)

/** Shared checks; sends the error response and returns null if they fail. */
function prepare(req, res) {
  const provider = req.body?.provider;
  if (!Object.hasOwn(CATALOG, provider)) {
    res.status(400).json({ error: 'Choose Claude or OpenAI.' });
    return null;
  }
  if (!isConfigured(provider)) {
    const { label, envKey } = CATALOG[provider];
    res.status(503).json({ error: `${label} isn't set up. Add ${envKey} to .env and restart the server.` });
    return null;
  }
  try {
    return { provider, model: findModel(provider, req.body?.model), profile: validateProfile(req.body?.profile) };
  } catch (err) {
    if (err instanceof ProfileError) { res.status(400).json({ error: err.message }); return null; }
    throw err;
  }
}

async function stream(res, { provider, model, system, messages }) {
  // Stop the upstream request if the browser disconnects or presses Stop.
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });

  res.status(200).set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = event => res.write(JSON.stringify(event) + '\n');
  send({ type: 'start', provider, model: { id: model.id, label: model.label } });

  try {
    for await (const event of adapters[provider]({ model, system, messages, signal: abort.signal })) send(event);
  } catch (err) {
    if (abort.signal.aborted) return;        // client went away; nothing to report
    console.error(`[${provider}/${model.id}]`, err?.status ?? '', err?.message ?? err);
    send({ type: 'error', message: explainError(provider, err) });
  }
  res.end();
}

// Request: { provider, model, profile: { score, goal, cards[] } }
app.post('/api/plan', async (req, res) => {
  const ctx = prepare(req, res);
  if (!ctx) return;
  await stream(res, {
    ...ctx,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildPrompt(ctx.profile) }],
  });
});

// Request: { provider, model, profile, plan?, messages: [{ role, content }] }
app.post('/api/chat', async (req, res) => {
  const ctx = prepare(req, res);
  if (!ctx) return;
  let chat;
  try {
    chat = validateChat(req.body?.messages, req.body?.plan);
  } catch (err) {
    if (err instanceof ProfileError) return res.status(400).json({ error: err.message });
    throw err;
  }
  await stream(res, { ...ctx, system: buildChatSystem(ctx.profile, chat.plan), messages: chat.messages });
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, HOST, err => {
  if (err) {
    console.error(`\n  Couldn't start on ${HOST}:${PORT} — ${err.message}\n`);
    process.exit(1);
  }
  console.log(`\n  Credit Score AI Agent running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  for (const p of Object.values(describeProviders())) {
    const status = p.configured ? `✓ ${p.models[0].id}` : `✗ add ${p.envKey} to .env`;
    console.log(`  ${p.label.padEnd(8)}: ${status}`);
  }
  console.log('');
});
