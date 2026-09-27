// ─────────────────────────────────────────────────────────────
//  AI providers
//
//  Anthropic → official SDK, Messages API, streamed
//  OpenAI    → official SDK, Responses API, streamed
//
//  Both adapters take { model, system, messages, signal }, where
//  messages is [{ role: 'user' | 'assistant', content }], and are
//  async generators that yield the same events:
//    { type: 'text', text }
//    { type: 'done', stopReason, usage: { input, output } }
//  and throw on failure.
// ─────────────────────────────────────────────────────────────
const Anthropic = require('@anthropic-ai/sdk').default;
const OpenAI    = require('openai').default;

const MAX_OUTPUT_TOKENS = 8000;   // room for reasoning + a ~450-word plan

// Models offered in the UI. The first entry is the default unless
// ANTHROPIC_MODEL / OPENAI_MODEL in .env names a different one.
const CATALOG = {
  anthropic: {
    label:  'Claude',
    envKey: 'ANTHROPIC_API_KEY',
    placeholder: 'your-anthropic-key-here',
    models: [
      // `effort` is sent as output_config.effort; null = model doesn't support it.
      { id: 'claude-sonnet-5',           label: 'Sonnet 5',  note: 'balanced',      effort: 'medium' },
      { id: 'claude-opus-5-5',           label: 'Opus 5.5',  note: 'most thorough', effort: 'medium' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', note: 'fastest',       effort: null },
    ],
  },
  openai: {
    label:  'OpenAI',
    envKey: 'OPENAI_API_KEY',
    placeholder: 'your-openai-key-here',
    models: [
      // `effort` is sent as reasoning.effort.
      { id: 'gpt-6-sol',   label: 'GPT-6 Sol',   note: 'balanced',      effort: 'low' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', note: 'most thorough', effort: 'low' },
      { id: 'gpt-6-luna',  label: 'GPT-6 Luna',  note: 'fastest',       effort: 'low' },
    ],
  },
};

// Let .env pick the default model, including one not in the list above.
for (const [name, envModel] of [['anthropic', process.env.ANTHROPIC_MODEL], ['openai', process.env.OPENAI_MODEL]]) {
  const id = envModel?.trim();
  if (!id) continue;
  const models = CATALOG[name].models;
  const existing = models.findIndex(m => m.id === id);
  const entry = existing >= 0
    ? models.splice(existing, 1)[0]
    : { id, label: id, note: 'from .env', effort: null };
  models.unshift(entry);
}

function apiKey(provider) {
  const { envKey, placeholder } = CATALOG[provider];
  const key = process.env[envKey]?.trim();
  return key && key !== placeholder ? key : null;
}

function isConfigured(provider) {
  return Boolean(apiKey(provider));
}

function findModel(provider, modelId) {
  const models = CATALOG[provider]?.models ?? [];
  return models.find(m => m.id === modelId) ?? models[0];
}

/** Public description of providers for the frontend (no secrets). */
function describeProviders() {
  return Object.fromEntries(Object.entries(CATALOG).map(([name, p]) => [name, {
    label: p.label,
    envKey: p.envKey,
    configured: isConfigured(name),
    models: p.models.map(({ id, label, note }) => ({ id, label, note })),
  }]));
}

// Clients are created lazily so a missing key for one provider
// doesn't stop the other from working.
const clients = {};
function client(provider) {
  if (!clients[provider]) {
    const key = apiKey(provider);
    clients[provider] = provider === 'anthropic'
      ? new Anthropic({ apiKey: key })
      : new OpenAI({ apiKey: key });
  }
  return clients[provider];
}

// ── Anthropic: Messages API ──────────────────────────────────
async function* streamAnthropic({ model, system, messages, signal }) {
  const params = {
    model: model.id,
    max_tokens: MAX_OUTPUT_TOKENS,
    system,
    messages,
  };
  if (model.effort) params.output_config = { effort: model.effort };

  const stream = client('anthropic').messages.stream(params, { signal });

  // Thinking blocks may stream first on adaptive-thinking models;
  // only text deltas are forwarded to the browser.
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield { type: 'text', text: event.delta.text };
    }
  }

  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') {
    throw new ProviderError('Claude declined to answer this request. Try adjusting the card names or details.');
  }
  yield {
    type: 'done',
    stopReason: message.stop_reason,
    usage: { input: message.usage.input_tokens, output: message.usage.output_tokens },
  };
}

// ── OpenAI: Responses API ────────────────────────────────────
async function* streamOpenAI({ model, system, messages, signal }) {
  const stream = await client('openai').responses.create({
    model: model.id,
    instructions: system,
    input: messages.map(({ role, content }) => ({ role, content })),
    reasoning: model.effort ? { effort: model.effort } : undefined,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    store: false,          // personal financial data: don't keep it server-side
    stream: true,
  }, { signal });

  let refusal = '';
  for await (const event of stream) {
    switch (event.type) {
      case 'response.output_text.delta':
        yield { type: 'text', text: event.delta };
        break;
      case 'response.refusal.delta':
        refusal += event.delta;
        break;
      case 'response.completed':
      case 'response.incomplete': {
        const r = event.response;
        if (refusal) throw new ProviderError(`OpenAI declined to answer: ${refusal}`);
        yield {
          type: 'done',
          stopReason: r.incomplete_details?.reason ?? r.status,
          usage: { input: r.usage?.input_tokens, output: r.usage?.output_tokens },
        };
        return;
      }
      case 'response.failed':
        throw new ProviderError(event.response.error?.message || 'OpenAI could not complete the response.');
      case 'error':
        throw new ProviderError(event.message || 'OpenAI returned an error while streaming.');
    }
  }
}

class ProviderError extends Error {}

/** Turn SDK errors into something a person can act on. */
function explainError(provider, err) {
  if (err instanceof ProviderError) return err.message;
  const { label, envKey } = CATALOG[provider];
  const status = err?.status;
  const detail = err?.error?.error?.message || err?.error?.message || err?.message || 'Unknown error';

  if (status === 401 || status === 403) return `${label} rejected the API key. Check ${envKey} in .env and restart the server.`;
  if (status === 404) return `${label} couldn't find that model for your key (${detail}). Pick another model or set one in .env.`;
  if (status === 429) return `${label} is rate limiting this key, or the account is out of credit. Wait a moment and try again.`;
  if (status === 529 || status === 503) return `${label} is overloaded right now. Try again in a minute.`;
  if (status >= 500) return `${label} had a server error. Try again in a minute.`;
  if (err?.name === 'APIConnectionError' || err?.cause?.code === 'ENOTFOUND') {
    return `Couldn't reach ${label}. Check your internet connection.`;
  }
  return `${label}: ${detail}`;
}

const adapters = { anthropic: streamAnthropic, openai: streamOpenAI };

module.exports = {
  CATALOG,
  adapters,
  isConfigured,
  findModel,
  describeProviders,
  explainError,
};
