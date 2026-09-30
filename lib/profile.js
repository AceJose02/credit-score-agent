// ─────────────────────────────────────────────────────────────
//  Credit profile: validation, shared math, and prompts
//
//  Plain JavaScript with no dependencies. The same file runs on
//  the server (validation + prompts) and in the browser (the page
//  uses the tiers and loan math so numbers match everywhere).
//
//  The browser sends structured numbers, never a free-form prompt.
//  That keeps the API keys from being usable as a general-purpose
//  proxy and keeps the system prompt in one place.
// ─────────────────────────────────────────────────────────────

const SCORE_MIN = 300;
const SCORE_MAX = 850;
const MAX_CARDS = 30;
const MAX_LOANS = 20;
const MAX_NAME  = 60;
const MAX_MONEY = 50_000_000;

// Both models run 300–850 but name their ranges differently.
const MODELS = {
  fico: {
    label: 'FICO',
    tiers: [
      { min: 800, name: 'Exceptional', level: 4 },
      { min: 740, name: 'Very good',   level: 3 },
      { min: 670, name: 'Good',        level: 2 },
      { min: 580, name: 'Fair',        level: 1 },
      { min: 300, name: 'Poor',        level: 0 },
    ],
  },
  vantage: {
    label: 'VantageScore 3.0',
    tiers: [
      { min: 781, name: 'Excellent', level: 4 },
      { min: 661, name: 'Good',      level: 2 },
      { min: 601, name: 'Fair',      level: 1 },
      { min: 500, name: 'Poor',      level: 0 },
      { min: 300, name: 'Very poor', level: 0 },
    ],
  },
};

const BUREAUS = { equifax: 'Equifax', experian: 'Experian', transunion: 'TransUnion' };

const LOAN_TYPES = {
  auto:     'Auto loan',
  mortgage: 'Mortgage',
  student:  'Student loan',
  personal: 'Personal loan',
  other:    'Other loan',
};

class ProfileError extends Error {}

// ── Shared math ──────────────────────────────────────────────

/** Tier for a score on a model's own scale: { name, level 0–4 }. */
function tierFor(score, model = 'fico') {
  return MODELS[model].tiers.find(t => score >= t.min);
}

/** Middle of three FICO scores (what mortgage lenders commonly use). Null unless all three are present. */
function middleScore(values) {
  const v = values.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  return v.length === 3 ? v[1] : null;
}

/**
 * Months and interest left on an amortizing loan.
 * Returns null if there isn't enough to work it out,
 * or { never: true } if the payment doesn't cover the interest.
 */
function loanPayoff({ balance, apr, payment }) {
  if (!(balance > 0) || !(payment > 0) || apr == null || !(apr >= 0)) return null;
  const r = apr / 100 / 12;
  if (r === 0) return { months: Math.ceil(balance / payment), interest: 0 };
  if (payment <= balance * r) return { never: true };
  const n = -Math.log(1 - (r * balance) / payment) / Math.log(1 + r);
  return { months: Math.ceil(n), interest: Math.max(0, payment * n - balance) };
}

const usd = n => '$' + Math.round(n).toLocaleString('en-US');

function describeAge(months) {
  const total = Math.round(months);
  const y = Math.floor(total / 12);
  const m = total % 12;
  const parts = [];
  if (y) parts.push(`${y} year${y === 1 ? '' : 's'}`);
  if (m || !y) parts.push(`${m} month${m === 1 ? '' : 's'}`);
  return parts.join(' ');
}

const ageMonths = a => (a.ageYears ?? 0) * 12 + (a.ageMonths ?? 0);
const hasAge = a => a.ageYears !== null || a.ageMonths !== null;

/** Summary numbers for a validated profile (also mirrored in the page). */
function summarize({ cards, loans, scores }) {
  const priced = cards.filter(c => c.limit > 0 && c.balance !== null);
  const totalLimit = priced.reduce((s, c) => s + c.limit, 0);
  const cardBalance = cards.reduce((s, c) => s + (c.balance ?? 0), 0);
  const pricedBalance = priced.reduce((s, c) => s + c.balance, 0);

  const loanBalance = loans.reduce((s, l) => s + (l.balance ?? 0), 0);
  const withOriginal = loans.filter(l => l.original > 0 && l.balance !== null);
  const originalTotal = withOriginal.reduce((s, l) => s + l.original, 0);
  const originalOwed = withOriginal.reduce((s, l) => s + l.balance, 0);

  const aged = [...cards, ...loans].filter(hasAge);
  const debts = [
    ...cards.filter(c => c.apr !== null && c.balance > 0).map(c => ({ name: c.name, apr: c.apr })),
    ...loans.filter(l => l.apr !== null && l.balance > 0).map(l => ({ name: l.name, apr: l.apr })),
  ].sort((a, b) => b.apr - a.apr);

  const fico = Object.keys(BUREAUS).map(b => scores[b].fico).filter(v => v !== null);
  const vantage = Object.keys(BUREAUS).map(b => scores[b].vantage).filter(v => v !== null);

  return {
    totalLimit,
    cardBalance,
    utilization: totalLimit > 0 ? Math.round((pricedBalance / totalLimit) * 100) : null,
    loanBalance,
    installmentPaidDown: originalTotal > 0 ? Math.round((1 - originalOwed / originalTotal) * 100) : null,
    monthlyLoanPayments: loans.reduce((s, l) => s + (l.payment ?? 0), 0),
    totalDebt: cardBalance + loanBalance,
    avgAgeMonths: aged.length ? aged.reduce((s, a) => s + ageMonths(a), 0) / aged.length : null,
    highestApr: debts[0] ?? null,
    loanTypes: [...new Set(loans.map(l => l.type))],
    fico: fico.length ? { min: Math.min(...fico), max: Math.max(...fico), middle: middleScore(fico) } : null,
    vantage: vantage.length ? { min: Math.min(...vantage), max: Math.max(...vantage) } : null,
  };
}

// ── Validation ───────────────────────────────────────────────

function toNumber(value, { field, min, max, integer = false, optional = false }) {
  if (value === '' || value === null || value === undefined) {
    if (optional) return null;
    throw new ProfileError(`${field} is required.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ProfileError(`${field} must be a number.`);
  if (integer && !Number.isInteger(n)) throw new ProfileError(`${field} must be a whole number.`);
  if (n < min || n > max) throw new ProfileError(`${field} must be between ${min} and ${max.toLocaleString('en-US')}.`);
  return n;
}

function cleanName(value, fallback) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')   // no newlines / control chars in the prompt
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
  return text || fallback;
}

/** A score of 0 means "don't know": treated like a blank so the AI skips it. */
const isZero = v => v !== '' && v != null && Number(v) === 0;

const money = (v, field) => toNumber(v, { field, min: 0, max: MAX_MONEY, optional: true });
const apr   = (v, field) => toNumber(v, { field, min: 0, max: 100, optional: true });
const age = (a, label) => ({
  ageYears:  toNumber(a?.ageYears,  { field: `Age in years for ${label}`,  min: 0, max: 80, integer: true, optional: true }),
  ageMonths: toNumber(a?.ageMonths, { field: `Age in months for ${label}`, min: 0, max: 11, integer: true, optional: true }),
});

/** Validate and normalise the profile the browser sent. Throws ProfileError. */
function validateProfile(raw) {
  if (!raw || typeof raw !== 'object') throw new ProfileError('Missing profile.');

  // Which score this is. "unknown" means they don't know it, and the AI works without it.
  const scoreModel = ['fico', 'vantage', 'unknown'].includes(raw.scoreModel) ? raw.scoreModel : 'fico';
  const scoreBureau = Object.hasOwn(BUREAUS, raw.scoreBureau ?? '') ? raw.scoreBureau : null;
  if (scoreModel !== 'unknown' && (raw.score === '' || raw.score == null)) {
    throw new ProfileError('Enter your current score, or choose "I don\u2019t know my score".');
  }
  const score = scoreModel === 'unknown' || isZero(raw.score) ? null
    : toNumber(raw.score, { field: 'Current score', min: SCORE_MIN, max: SCORE_MAX, integer: true });
  const goal = isZero(raw.goal) ? null
    : toNumber(raw.goal, { field: 'Goal score', min: SCORE_MIN, max: SCORE_MAX, integer: true, optional: true });

  const rawCards = Array.isArray(raw.cards) ? raw.cards : [];
  const rawLoans = Array.isArray(raw.loans) ? raw.loans : [];
  if (!rawCards.length && !rawLoans.length) throw new ProfileError('Add at least one card or loan.');
  if (rawCards.length > MAX_CARDS) throw new ProfileError(`Up to ${MAX_CARDS} cards are supported.`);
  if (rawLoans.length > MAX_LOANS) throw new ProfileError(`Up to ${MAX_LOANS} loans are supported.`);

  const cards = rawCards.map((c, i) => {
    const name = cleanName(c?.name, `Card ${i + 1}`);
    return {
      name,
      limit:   money(c?.limit,   `Credit limit for ${name}`),
      balance: money(c?.balance, `Balance for ${name}`),
      apr:     apr(c?.apr,       `APR for ${name}`),
      ...age(c, name),
    };
  });

  const loans = rawLoans.map(l => {
    const type = Object.hasOwn(LOAN_TYPES, l?.type) ? l.type : 'other';
    const name = cleanName(l?.name, LOAN_TYPES[type]);
    return {
      type,
      name,
      balance:  money(l?.balance,  `Balance for ${name}`),
      original: money(l?.original, `Original amount for ${name}`),
      apr:      apr(l?.apr,        `APR for ${name}`),
      payment:  money(l?.payment,  `Monthly payment for ${name}`),
      ...age(l, name),
    };
  });

  const scores = {};
  for (const [key, label] of Object.entries(BUREAUS)) {
    scores[key] = {};
    for (const [model, { label: modelLabel }] of Object.entries(MODELS)) {
      const value = raw.scores?.[key]?.[model];
      scores[key][model] = isZero(value) ? null : toNumber(value, {
        field: `${label} ${modelLabel} score`, min: SCORE_MIN, max: SCORE_MAX, integer: true, optional: true,
      });
    }
  }

  return { score, scoreModel, scoreBureau, goal, cards, loans, scores };
}

// ── Prompt text ──────────────────────────────────────────────

/** Plain-text summary of a validated profile. */
function describeProfile(profile) {
  const { score, scoreModel, scoreBureau, goal, cards, loans, scores } = profile;
  const s = summarize(profile);
  const lines = [];
  const scale = scoreModel === 'vantage' ? 'vantage' : 'fico';
  const scaleLabel = MODELS[scale].label;

  const anyBureau = Object.values(scores).some(b => b.fico !== null || b.vantage !== null);
  if (score === null && anyBureau) {
    lines.push('Current score: not picked as a single number. Use their scores by bureau below.');
  } else if (score === null) {
    lines.push('Current score: not known. They don\'t know their score, so don\'t guess one or estimate where they stand. Work from their cards and loans, and suggest a free way to check a score.');
  } else {
    const from = scoreBureau ? `from ${BUREAUS[scoreBureau]}` : 'bureau not specified';
    lines.push(`Current score: ${score} (${scaleLabel}, ${from}; ${tierFor(score, scale).name} on the ${scaleLabel} scale, which runs 300–850)`);
  }
  if (goal !== null) {
    const gap = score === null ? null : goal - score;
    lines.push(`Goal score: ${goal} (${tierFor(goal, scale).name} on the ${scaleLabel} scale)` +
      (gap === null ? '' : gap > 0 ? `, ${gap} points above today` : ', already at or below the current score'));
  }

  const bureauLines = Object.entries(BUREAUS).map(([key, label]) => {
    const parts = Object.entries(MODELS)
      .filter(([m]) => scores[key][m] !== null)
      .map(([m, { label: ml }]) => `${ml} ${scores[key][m]} (${tierFor(scores[key][m], m).name} on the ${ml} scale)`);
    return parts.length ? `- ${label}: ${parts.join(', ')}` : null;
  }).filter(Boolean);
  if (bureauLines.length) {
    lines.push('', 'Scores by bureau:', ...bureauLines);
    if (s.fico?.middle != null) lines.push(`- Middle FICO across the three bureaus: ${s.fico.middle}`);
    if (s.fico && s.fico.max > s.fico.min) lines.push(`- FICO spread between bureaus: ${s.fico.max - s.fico.min} points`);
    if (s.vantage && s.vantage.max > s.vantage.min) lines.push(`- VantageScore 3.0 spread between bureaus: ${s.vantage.max - s.vantage.min} points`);
  }

  if (cards.length) {
    lines.push('', `Credit cards (${cards.length}):`);
    for (const c of cards) {
      const bits = [];
      bits.push(c.limit   !== null ? `limit ${usd(c.limit)}`     : 'limit unknown');
      bits.push(c.balance !== null ? `balance ${usd(c.balance)}` : 'balance unknown');
      if (c.limit > 0 && c.balance !== null) bits.push(`${Math.round((c.balance / c.limit) * 100)}% utilization`);
      if (c.apr !== null) bits.push(`${c.apr}% APR`);
      bits.push(hasAge(c) ? `open ${describeAge(ageMonths(c))}` : 'age unknown');
      lines.push(`- ${c.name}: ${bits.join(', ')}`);
    }
  } else {
    lines.push('', 'Credit cards: none');
  }

  if (loans.length) {
    lines.push('', `Loans (${loans.length}):`);
    for (const l of loans) {
      const bits = [];
      if (l.balance !== null) {
        bits.push(`balance ${usd(l.balance)}` + (l.original > 0 ? ` of ${usd(l.original)} original` : ''));
        if (l.original > 0 && l.balance <= l.original) bits.push(`${Math.round((1 - l.balance / l.original) * 100)}% paid down`);
      } else {
        bits.push('balance unknown');
      }
      if (l.apr !== null) bits.push(`${l.apr}% APR`);
      if (l.payment !== null) bits.push(`${usd(l.payment)} a month`);
      if (hasAge(l)) bits.push(`open ${describeAge(ageMonths(l))}`);
      const p = loanPayoff(l);
      if (p?.never) bits.push('the payment does not cover the monthly interest');
      else if (p) bits.push(`about ${p.months} months and ${usd(p.interest)} of interest left at this payment`);
      const label = l.name === LOAN_TYPES[l.type] ? l.name : `${LOAN_TYPES[l.type]} (${l.name})`;
      lines.push(`- ${label}: ${bits.join(', ')}`);
    }
  } else {
    lines.push('', 'Loans: none');
  }

  lines.push('', 'Totals:');
  if (s.utilization !== null) lines.push(`- Cards: ${usd(s.cardBalance)} owed on ${usd(s.totalLimit)} of total credit (${s.utilization}% overall utilization)`);
  if (loans.length) {
    lines.push(`- Loans: ${usd(s.loanBalance)} owed` + (s.installmentPaidDown !== null ? `, ${s.installmentPaidDown}% of original loan amounts paid down` : ''));
    if (s.monthlyLoanPayments) lines.push(`- Monthly loan payments: ${usd(s.monthlyLoanPayments)}`);
  }
  lines.push(`- Total debt: ${usd(s.totalDebt)}`);
  lines.push(`- Credit mix: ${[cards.length ? 'credit cards' : null, ...s.loanTypes.map(t => LOAN_TYPES[t].toLowerCase())].filter(Boolean).join(', ')}`);
  if (s.highestApr) lines.push(`- Highest APR: ${s.highestApr.name} at ${s.highestApr.apr}%`);
  if (s.avgAgeMonths !== null) lines.push(`- Average account age (cards and loans): ${describeAge(s.avgAgeMonths)}`);

  return lines.join('\n');
}

// How the app renders answers. Shared by the plan and follow-up chat.
const FORMAT_RULES = `Formatting (the app renders this):
- Use Markdown: "## " for section headings, numbered or "-" lists, **bold** for key figures. No emoji.
- To show a chart, add a fenced code block whose language is "chart" and whose body is only JSON, for example:
\`\`\`chart
{"type":"bar","title":"Balances now and target","unit":"$","labels":["Card A","Card B"],"series":[{"name":"Now","values":[1800,2100]},{"name":"Target","values":[350,800]}]}
\`\`\`
  "type" is "bar" or "line". "unit" is "$", "%" or "pts" (score points). Use 2 to 8 labels and 1 to 3 series, with one number per label in every series. Keep titles short.
- Good charts: card balances now and target (bar, $), utilization by card (bar, %), scores by bureau with FICO and VantageScore 3.0 as two series (bar, pts), debt by account or interest left by loan (bar, $), an estimated score over the coming months (line, pts, with "estimated" in the title).
- For schedules, such as month-by-month payments, use a Markdown table with at most 8 rows and 5 columns.
- Put charts and tables between paragraphs, never inside a list item. Only use numbers from the profile or simple arithmetic on them.`;

const SCORING_NOTES = `What you know about scoring (use it, don't lecture):
- Payment history and card utilization move scores the most. Paying down card balances usually helps a score faster than extra payments on installment loans.
- Loans matter through payment history, credit mix and total debt. Paying extra on a low-APR loan saves interest but rarely moves the score much; say so when it applies. Paying off an installment loan early can even dip a score slightly.
- Use APRs to rank debts for saving money (highest APR first) and say when the best move for the score and the best move for interest differ.
- Scores differ between bureaus because lenders don't always report to all three. A gap of 20 or more points is worth checking: suggest pulling that bureau's report at AnnualCreditReport.com and looking for errors or missing accounts.
- FICO and VantageScore 3.0 use different scales for their ranges, so the same number can mean different things; VantageScore tends to weigh utilization more heavily. Mortgage lenders commonly use the middle of the three FICO scores.`;

const SYSTEM_PROMPT = `You are a careful, plain-spoken credit advisor. You help one person improve their credit score using only the numbers they give you.

How to write:
- Start with a two or three sentence read of where they stand and what is holding the score back most.
- Then give 3 to 5 actions, most impactful first, as a numbered list. For each: what to do (with dollar amounts drawn from their cards and loans where it helps), why it moves the score or saves money, and a realistic timeline.
- End with a short "What to avoid" list.
- Include one or two charts where they make the numbers clearer, and a table if a payment schedule helps.
- Keep the prose under about 500 words. Be specific and encouraging, never alarmist.
- Only use facts from the profile. If something important is missing (for example payment history or recent hard inquiries), say what it is in one line instead of guessing.
- If their current score isn't known, say so in one line, work from their accounts, and skip any estimated-score chart.
- Do not recommend specific card products or lenders. Remind them briefly that this is general guidance, not personalised financial advice, only once at the very end.

${SCORING_NOTES}

${FORMAT_RULES}`;

/** The user turn that asks for a plan. */
function buildPrompt(profile) {
  return `${describeProfile(profile)}\n\nWrite my plan.`;
}

// ── Follow-up questions ──────────────────────────────────────
const MAX_TURNS = 24;
const MAX_QUESTION = 2000;
const MAX_ANSWER = 16000;
const MAX_PLAN = 24000;

/** Validate the chat history the browser sent. Throws ProfileError. */
function validateChat(rawMessages, rawPlan) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) throw new ProfileError('Ask a question first.');
  const messages = rawMessages.slice(-MAX_TURNS).map(m => {
    const role = m?.role;
    if (role !== 'user' && role !== 'assistant') throw new ProfileError('Each message must be from the user or the assistant.');
    const content = String(m?.content ?? '').trim();
    if (!content) throw new ProfileError('Messages cannot be empty.');
    const max = role === 'user' ? MAX_QUESTION : MAX_ANSWER;
    if (content.length > max) throw new ProfileError(role === 'user' ? `Keep questions under ${MAX_QUESTION} characters.` : 'An earlier answer is too long to resend.');
    return { role, content };
  });
  while (messages.length && messages[0].role !== 'user') messages.shift();   // must start on a question
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw new ProfileError('The last message must be a question.');
  const plan = typeof rawPlan === 'string' ? rawPlan.slice(0, MAX_PLAN).trim() : '';
  return { messages, plan };
}

/** System prompt for follow-up questions: the advisor, the numbers, and the plan so far. */
function buildChatSystem(profile, plan) {
  return `You are a careful, plain-spoken credit advisor answering follow-up questions from one person about their credit.

Their profile:
${describeProfile(profile)}

${plan ? `The plan you already wrote for them:\n<plan>\n${plan}\n</plan>` : 'You have not written a plan for them yet.'}

How to answer:
- Answer the question directly first, then explain briefly. Usually under 200 words unless they ask for more.
- Use their actual numbers. If the question depends on something not in the profile, say what you'd need to know. If their score isn't known, don't guess it.
- Add a chart or table when the answer is about amounts over time or comparisons, or when they ask for one.
- Stay on credit, debt and personal finance. Don't recommend specific card products or lenders.
- This is general guidance, not personalised financial advice; say so only if the question calls for professional advice.

${SCORING_NOTES}

${FORMAT_RULES}`;
}

const api = {
  validateProfile, validateChat, describeProfile, buildPrompt, buildChatSystem, ProfileError,
  SYSTEM_PROMPT, FORMAT_RULES,
  // Shared with the page so numbers match everywhere.
  MODELS, BUREAUS, LOAN_TYPES, tierFor, middleScore, loanPayoff,
};

// Works in Node (the server) and in a browser (the page and the published demo).
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.CreditProfile = api;
