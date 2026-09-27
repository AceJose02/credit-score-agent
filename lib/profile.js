// ─────────────────────────────────────────────────────────────
//  Credit profile: validation + prompt construction
//
//  Plain JavaScript with no dependencies, so the same file runs on
//  the server and in the browser demo.
//
//  The browser sends structured numbers, never a free-form prompt.
//  That keeps the API keys from being usable as a general-purpose
//  proxy and keeps the system prompt in one place.
// ─────────────────────────────────────────────────────────────

const SCORE_MIN = 300;
const SCORE_MAX = 850;
const MAX_CARDS = 30;
const MAX_NAME  = 60;
const MAX_MONEY = 10_000_000;

const TIERS = [
  { min: 800, name: 'Exceptional' },
  { min: 740, name: 'Very good' },
  { min: 670, name: 'Good' },
  { min: 580, name: 'Fair' },
  { min: 300, name: 'Poor' },
];

class ProfileError extends Error {}

function toNumber(value, { field, min, max, integer = false, optional = false }) {
  if (value === '' || value === null || value === undefined) {
    if (optional) return null;
    throw new ProfileError(`${field} is required.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ProfileError(`${field} must be a number.`);
  if (integer && !Number.isInteger(n)) throw new ProfileError(`${field} must be a whole number.`);
  if (n < min || n > max) throw new ProfileError(`${field} must be between ${min} and ${max}.`);
  return n;
}

function cleanName(value, index) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')   // no newlines / control chars in the prompt
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
  return text || `Card ${index + 1}`;
}

/** Validate and normalise the profile the browser sent. Throws ProfileError. */
function validateProfile(raw) {
  if (!raw || typeof raw !== 'object') throw new ProfileError('Missing profile.');

  const score = toNumber(raw.score, { field: 'Current score', min: SCORE_MIN, max: SCORE_MAX, integer: true });
  const goal  = toNumber(raw.goal,  { field: 'Goal score',    min: SCORE_MIN, max: SCORE_MAX, integer: true, optional: true });

  if (!Array.isArray(raw.cards) || raw.cards.length === 0) {
    throw new ProfileError('Add at least one credit card.');
  }
  if (raw.cards.length > MAX_CARDS) {
    throw new ProfileError(`Up to ${MAX_CARDS} cards are supported.`);
  }

  const cards = raw.cards.map((c, i) => {
    const label = cleanName(c?.name, i);
    return {
      name:      label,
      limit:     toNumber(c?.limit,     { field: `Credit limit for ${label}`,  min: 0, max: MAX_MONEY, optional: true }),
      balance:   toNumber(c?.balance,   { field: `Balance for ${label}`,       min: 0, max: MAX_MONEY, optional: true }),
      ageYears:  toNumber(c?.ageYears,  { field: `Age in years for ${label}`,  min: 0, max: 80, integer: true, optional: true }),
      ageMonths: toNumber(c?.ageMonths, { field: `Age in months for ${label}`, min: 0, max: 11, integer: true, optional: true }),
    };
  });

  return { score, goal, cards };
}

function tierFor(score) {
  return TIERS.find(t => score >= t.min).name;
}

const usd = n => '$' + Math.round(n).toLocaleString('en-US');

function describeAge(months) {
  const y = Math.floor(months / 12);
  const m = Math.round(months % 12);
  const parts = [];
  if (y) parts.push(`${y} year${y === 1 ? '' : 's'}`);
  if (m || !y) parts.push(`${m} month${m === 1 ? '' : 's'}`);
  return parts.join(' ');
}

/** Summary numbers shared by the prompt (and mirrored in the frontend). */
function summarize(cards) {
  const priced = cards.filter(c => c.limit > 0 && c.balance !== null);
  const totalLimit   = priced.reduce((s, c) => s + c.limit, 0);
  const totalBalance = priced.reduce((s, c) => s + c.balance, 0);
  const aged = cards.filter(c => c.ageYears !== null || c.ageMonths !== null);
  const avgAgeMonths = aged.length
    ? aged.reduce((s, c) => s + (c.ageYears ?? 0) * 12 + (c.ageMonths ?? 0), 0) / aged.length
    : null;
  return {
    totalLimit,
    totalBalance,
    utilization: totalLimit > 0 ? Math.round((totalBalance / totalLimit) * 100) : null,
    avgAgeMonths,
  };
}

// How the app renders answers. Shared by the plan and follow-up chat.
const FORMAT_RULES = `Formatting (the app renders this):
- Use Markdown: "## " for section headings, numbered or "-" lists, **bold** for key figures. No emoji.
- To show a chart, add a fenced code block whose language is "chart" and whose body is only JSON, for example:
\`\`\`chart
{"type":"bar","title":"Balances now and target","unit":"$","labels":["Card A","Card B"],"series":[{"name":"Now","values":[1800,2100]},{"name":"Target","values":[350,800]}]}
\`\`\`
  "type" is "bar" or "line". "unit" is "$", "%" or "pts" (score points). Use 2 to 8 labels and 1 to 3 series, with one number per label in every series. Keep titles short.
- Good charts: balances now and target by card (bar, $), utilization by card (bar, %), an estimated score over the coming months (line, pts, with "estimated" in the title).
- For schedules, such as month-by-month payments, use a Markdown table with at most 8 rows and 5 columns.
- Put charts and tables between paragraphs, never inside a list item. Only use numbers from the profile or simple arithmetic on them.`;

const SYSTEM_PROMPT = `You are a careful, plain-spoken credit advisor. You help one person improve their FICO score using only the numbers they give you.

How to write:
- Start with a two or three sentence read of where they stand and what is holding the score back most.
- Then give 3 to 5 actions, most impactful first, as a numbered list. For each: what to do (with dollar amounts drawn from their cards where it helps), why it moves the score, and a realistic timeline.
- End with a short "What to avoid" list.
- Include one or two charts where they make the numbers clearer, and a table if a payment schedule helps.
- Keep the prose under about 450 words. Be specific and encouraging, never alarmist.
- Only use facts from the profile. If something important is missing (for example payment history or other loan types), say what it is in one line instead of guessing.
- Do not recommend specific card products or lenders. Remind them briefly that this is general guidance, not personalised financial advice, only once at the very end.

${FORMAT_RULES}`;

/** Plain-text summary of a validated profile. */
function describeProfile({ score, goal, cards }) {
  const s = summarize(cards);
  const lines = [];

  lines.push(`Current FICO score: ${score} (${tierFor(score)}, on the 300–850 scale)`);
  if (goal !== null) {
    const gap = goal - score;
    lines.push(`Goal score: ${goal} (${tierFor(goal)})` + (gap > 0 ? `, ${gap} points above today` : ', already at or below the current score'));
  }

  lines.push('', `Credit cards (${cards.length}):`);
  for (const c of cards) {
    const bits = [];
    bits.push(c.limit   !== null ? `limit ${usd(c.limit)}`     : 'limit unknown');
    bits.push(c.balance !== null ? `balance ${usd(c.balance)}` : 'balance unknown');
    if (c.limit > 0 && c.balance !== null) bits.push(`${Math.round((c.balance / c.limit) * 100)}% utilization`);
    const months = (c.ageYears ?? 0) * 12 + (c.ageMonths ?? 0);
    bits.push(c.ageYears !== null || c.ageMonths !== null ? `open ${describeAge(months)}` : 'age unknown');
    lines.push(`- ${c.name}: ${bits.join(', ')}`);
  }

  lines.push('', 'Totals:');
  if (s.utilization !== null) {
    lines.push(`- ${usd(s.totalBalance)} owed on ${usd(s.totalLimit)} of total credit (${s.utilization}% overall utilization)`);
  }
  if (s.avgAgeMonths !== null) {
    lines.push(`- Average card age: ${describeAge(s.avgAgeMonths)}`);
  }

  return lines.join('\n');
}

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
- Use their actual numbers. If the question depends on something not in the profile, say what you'd need to know.
- Add a chart or table when the answer is about amounts over time or comparisons, or when they ask for one.
- Stay on credit, debt and personal finance. Don't recommend specific card products or lenders.
- This is general guidance, not personalised financial advice; say so only if the question calls for professional advice.

${FORMAT_RULES}`;
}

const api = { validateProfile, validateChat, describeProfile, buildPrompt, buildChatSystem, ProfileError, SYSTEM_PROMPT, FORMAT_RULES };

// Works in Node (the server) and in a browser (the published demo).
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.CreditProfile = api;
