// ─────────────────────────────────────────────────────────────
//  Engine: how the page talks to an AI
//
//  This version uses the local server (server.js), which holds your
//  API keys. The published demo swaps in a different engine with the
//  same shape, so app.js never needs to know which one it has.
//
//  plan() and chat() never throw. They call onText(wholeTextSoFar)
//  while streaming and resolve with:
//    { status: 'done' | 'truncated' | 'stopped' | 'error', message?, by }
//  where `by` is a short credit line such as "Written by Claude Sonnet 5".
// ─────────────────────────────────────────────────────────────
(function (CSA) {
  'use strict';

  let providers = null;

  async function run(url, body, { signal, onText }) {
    const label = providers?.[body.provider]?.label ?? '';
    let by = label && `Written by ${label}`, text = '', status = 'done', message = '';
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return { status: 'error', message: data.error || `The server returned ${res.status}.`, by };
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const event = JSON.parse(line);
          if (event.type === 'start') by = `Written by ${label} ${event.model.label}`;
          else if (event.type === 'text') { text += event.text; onText(text); }
          else if (event.type === 'error') { status = 'error'; message = event.message; }
          else if (event.type === 'done' && ['max_tokens', 'max_output_tokens'].includes(event.stopReason)) status = 'truncated';
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return { status: 'stopped', by };
      return { status: 'error', message: err.message || 'Something went wrong.', by };
    }
    return { status, message, by };
  }

  CSA.engine = {
    // Export libraries, served by server.js from node_modules.
    vendor: { pdfmake: '/vendor/pdfmake.min.js', vfs: '/vendor/vfs_fonts.js', docx: '/vendor/docx.js' },

    async init() {
      const res = await fetch('/api/providers');
      if (!res.ok) throw new Error('Can\u2019t reach the local server.');
      providers = await res.json();
      return providers;
    },

    /** HTML note under the Write button. */
    notice() {
      const all = Object.values(providers ?? {});
      if (all.length && all.every(p => !p.configured)) {
        return 'No AI provider is set up. Add <code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code> to <code>.env</code>, then restart the server.';
      }
      return all.filter(p => !p.configured)
        .map(p => `To use ${CSA.md.escapeHtml(p.label)}, add <code>${p.envKey}</code> to <code>.env</code> and restart the server.`)
        .join(' ');
    },

    canAsk: () => true,
    canSave: () => true,

    plan: ({ provider, model, profile, signal, onText }) =>
      run('/api/plan', { provider, model, profile }, { signal, onText }),

    chat: ({ provider, model, profile, plan, messages, signal, onText }) =>
      run('/api/chat', { provider, model, profile, plan, messages }, { signal, onText }),

    /** Save a file through the browser's normal download. */
    async save({ filename, blob }) {
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return 'saved';
    },
  };
})(window.CSA = window.CSA || {});
