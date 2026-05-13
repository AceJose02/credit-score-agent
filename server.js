// ─────────────────────────────────────────────────────────────
//  Credit Score AI Agent — Server
//  Reads API keys from .env and proxies requests to Anthropic
//  or OpenAI so keys are never exposed in the browser.
// ─────────────────────────────────────────────────────────────
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve the frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

// ── Health / provider-status endpoint ────────────────────────
// The frontend calls this on load to know which providers are
// configured so it can show/hide the toggle accordingly.
app.get('/api/status', (req, res) => {
  res.json({
    anthropic: !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your-anthropic-key-here',
    openai:    !!process.env.OPENAI_API_KEY    && process.env.OPENAI_API_KEY    !== 'your-openai-key-here',
  });
});

// ── Anthropic proxy ──────────────────────────────────────────
app.post('/api/analyze/anthropic', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your-anthropic-key-here') {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set in .env' });
  }

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-5',
        max_tokens: 1000,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Anthropic API error' });
    }

    const text = data.content?.find(b => b.type === 'text')?.text || '';
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── OpenAI proxy ─────────────────────────────────────────────
app.post('/api/analyze/openai', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey === 'your-openai-key-here') {
    return res.status(500).json({ error: 'OPENAI_API_KEY is not set in .env' });
  }

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:      'gpt-4o',
        max_tokens: 1000,
        messages: [
          { role: 'system', content: 'You are a credit score expert and financial advisor.' },
          { role: 'user',   content: prompt },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'OpenAI API error' });
    }

    const text = data.choices?.[0]?.message?.content || '';
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Credit Score AI Agent running at http://localhost:${PORT}\n`);

  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your-anthropic-key-here';
  const hasOpenAI    = !!process.env.OPENAI_API_KEY    && process.env.OPENAI_API_KEY    !== 'your-openai-key-here';
  console.log(`  Anthropic : ${hasAnthropic ? '✓ configured' : '✗ not set'}`);
  console.log(`  OpenAI    : ${hasOpenAI    ? '✓ configured' : '✗ not set'}\n`);
});
