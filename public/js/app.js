// ─────────────────────────────────────────────────────────────
//  Credit score plan: page logic
//  Uses CreditProfile (lib/profile.js: tiers + loan math shared with
//  the server), CSA.md, CSA.charts, CSA.exporter and CSA.engine.
// ─────────────────────────────────────────────────────────────
(function (CSA, P) {
  'use strict';
  const { md, charts, exporter, engine } = CSA;

  // ─── Constants ───────────────────────────────────────────────
  const MIN = 300, MAX = 850;
  // Rail segments for a scoring model, built from CreditProfile's tier table.
  function railFor(model) {
    const tiers = [...P.MODELS[model].tiers].sort((a, b) => a.min - b.min);
    return tiers.map((t, i) => ({ name: t.name, level: t.level, from: t.min, to: tiers[i + 1]?.min ?? 851 }));
  }
  const LEVEL_COLOR = ['--t-poor', '--t-fair', '--t-good', '--t-vgood', '--t-exc'];
  const STORE_KEY = document.documentElement.dataset.storeKey || 'creditPlan.v3';
  const EXAMPLE = {
    score: '682', goal: '750', scoreModel: 'fico', scoreBureau: 'experian',
    scores: {
      equifax:    { fico: '679', vantage: '688' },
      experian:   { fico: '682', vantage: '' },
      transunion: { fico: '694', vantage: '701' },
    },
    cards: [
      { name: 'Chase Sapphire',          limit: '8000', balance: '2100', apr: '22.49', ageYears: '4', ageMonths: '6' },
      { name: 'Capital One Quicksilver', limit: '3500', balance: '1800', apr: '27.99', ageYears: '2', ageMonths: '3' },
    ],
    loans: [
      { type: 'auto',     name: 'Toyota Financial', balance: '14990',  original: '24000',  apr: '6.9', payment: '474',  ageYears: '2', ageMonths: '1' },
      { type: 'mortgage', name: 'Home loan',        balance: '250700', original: '260000', apr: '6.5', payment: '1643', ageYears: '3', ageMonths: '0' },
    ],
  };

  const $ = id => document.getElementById(id);
  const els = {
    score: $('score'), goal: $('goal'), scoreRead: $('scoreRead'), scoreModel: $('scoreModel'), scoreBureau: $('scoreBureau'),
    rail: $('rail'), band: $('band'), gap: $('gap'), pinNow: $('pinNow'), pinGoal: $('pinGoal'), range: $('bureauRange'),
    tierNames: $('tierNames'), tierNums: $('tierNums'),
    bureaus: $('bureaus'), bureauRows: $('bureauRows'), bureauSummary: $('bureauSummary'), useMiddle: $('useMiddle'),
    cards: $('cards'), addCard: $('addCard'), loans: $('loans'), addLoan: $('addLoan'), numbers: $('numbers'),
    providers: $('providers'), model: $('model'),
    write: $('write'), stop: $('stop'), notice: $('notice'),
    plan: $('plan'), stale: $('stale'), planMeta: $('planMeta'), planBy: $('planBy'),
    copy: $('copy'), pdf: $('pdf'), docx: $('docx'), fileStatus: $('fileStatus'),
    thread: $('thread'), suggestions: $('suggestions'), question: $('question'), ask: $('ask'),
    askNote: $('askNote'), clearChat: $('clearChat'),
  };

  // ─── State ───────────────────────────────────────────────────
  let state = load() ?? structuredClone(EXAMPLE);
  const withId = x => ({ ...x, id: crypto.randomUUID() });
  state.cards = (state.cards ?? []).map(withId);
  state.loans = (state.loans ?? []).map(withId);
  state.scores ??= {};
  state.scoreModel ??= 'fico';   // 'fico' | 'vantage' | 'unknown'
  state.scoreBureau ??= '';      // '' = not sure which bureau
  for (const b of Object.keys(P.BUREAUS)) state.scores[b] = { fico: '', vantage: '', ...state.scores[b] };
  state.plan ??= null;      // { text, by, status, message, profileKey }
  state.chat ??= [];        // [{ role, content, note?, noteKind? }]
  let providers = null;
  let running = null;       // { ctl: AbortController, kind: 'plan' | 'chat' }

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; }
  }
  const strip = list => list.map(({ id, ...x }) => x);
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...state, cards: strip(state.cards), loans: strip(state.loans) }));
    } catch { /* storage unavailable: fine, just not remembered */ }
  }

  // ─── Helpers ─────────────────────────────────────────────────
  const esc = md.escapeHtml;
  const num = v => (v === '' || v == null || !Number.isFinite(Number(v))) ? null : Number(v);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pct = v => ((clamp(v, MIN, MAX) - MIN) / (MAX - MIN)) * 100;
  const usd = n => '$' + Math.round(n).toLocaleString('en-US');
  const validScore = v => Number.isInteger(v) && v >= MIN && v <= MAX;
  /** A score of 0 means "don't know": no error, and the AI skips it. */
  const isZero = v => v !== '' && v != null && Number(v) === 0;
  /** Red only for real mistakes: blank and 0 are both fine. */
  const badScore = v => v !== '' && v != null && !isZero(v) && !validScore(num(v));
  const scoreKnown = () => state.scoreModel !== 'unknown';
  const railModel = () => (state.scoreModel === 'vantage' ? 'vantage' : 'fico');
  const railTier = s => { const r = railFor(railModel()); return r.find(t => s >= t.from && s < t.to) ?? r[r.length - 1]; };
  /** The main score, or null if the person doesn't know it. */
  const mainScore = () => (scoreKnown() ? num(state.score) : null);
  /** The bureau grid, with the main score filled into its own bureau and model. */
  function effectiveScores() {
    const out = structuredClone(state.scores);
    const v = mainScore();
    if (state.scoreBureau && validScore(v)) out[state.scoreBureau][state.scoreModel] = String(v);
    return out;
  }
  const profile = () => ({
    score: scoreKnown() ? state.score : '', scoreModel: state.scoreModel, scoreBureau: state.scoreBureau || null,
    goal: state.goal, scores: effectiveScores(),
    cards: strip(state.cards), loans: strip(state.loans),
  });
  const profileKey = () => JSON.stringify(profile());
  const hasAccounts = () => state.cards.length + state.loans.length > 0;
  const swatch = c => `<span class="swatch" style="background:var(${c})"></span>`;

  function utilColor(u) {
    if (u < 10) return '--t-exc';
    if (u < 30) return '--t-vgood';
    if (u < 50) return '--t-fair';
    return '--t-poor';
  }
  function ageText(months) {
    const total = Math.round(months);
    const y = Math.floor(total / 12), m = total % 12;
    if (y && m) return `${y} yr ${m} mo`;
    if (y) return `${y} yr`;
    return `${m} mo`;
  }
  const accountAge = a => (num(a.ageYears) != null || num(a.ageMonths) != null) ? (num(a.ageYears) ?? 0) * 12 + (num(a.ageMonths) ?? 0) : null;
  const payoffOf = l => P.loanPayoff({ balance: num(l.balance), apr: num(l.apr), payment: num(l.payment) });
  const monthsText = m => m >= 24 ? `${Math.floor(m / 12)} yr${m % 12 ? ` ${m % 12} mo` : ''}` : `${m} mo`;

  /** Entered bureau scores as [{ bureau, model, value }]. */
  function bureauScores() {
    const out = [], all = effectiveScores();
    for (const [b, label] of Object.entries(P.BUREAUS)) {
      for (const model of Object.keys(P.MODELS)) {
        const v = num(all[b][model]);
        if (validScore(v)) out.push({ bureau: b, label, model, value: v });
      }
    }
    return out;
  }

  /** Numbers shared by the summary panel and the exported report. */
  function stats() {
    const priced = state.cards.filter(c => num(c.limit) > 0 && num(c.balance) != null);
    const totalLimit = priced.reduce((s, c) => s + num(c.limit), 0);
    const pricedBal = priced.reduce((s, c) => s + num(c.balance), 0);
    const cardBal = state.cards.reduce((s, c) => s + (num(c.balance) ?? 0), 0);
    const loanBal = state.loans.reduce((s, l) => s + (num(l.balance) ?? 0), 0);
    const withOrig = state.loans.filter(l => num(l.original) > 0 && num(l.balance) != null);
    const origTotal = withOrig.reduce((s, l) => s + num(l.original), 0);
    const origOwed = withOrig.reduce((s, l) => s + num(l.balance), 0);
    const ages = [...state.cards, ...state.loans].map(accountAge).filter(a => a != null);
    const debts = [...state.cards, ...state.loans]
      .filter(a => num(a.apr) != null && num(a.balance) > 0)
      .map(a => ({ name: a.name || (a.type ? P.LOAN_TYPES[a.type] : 'Unnamed card'), apr: num(a.apr) }))
      .sort((a, b) => b.apr - a.apr);
    const fico = bureauScores().filter(s => s.model === 'fico').map(s => s.value);
    const vantage = bureauScores().filter(s => s.model === 'vantage').map(s => s.value);
    return {
      priced, totalLimit, cardBal, loanBal,
      util: totalLimit > 0 ? Math.round(pricedBal / totalLimit * 100) : null,
      highest: priced.map(c => ({ name: c.name || 'Unnamed card', u: Math.round(num(c.balance) / num(c.limit) * 100) })).sort((a, b) => b.u - a.u)[0],
      paidDown: origTotal > 0 ? Math.round((1 - origOwed / origTotal) * 100) : null,
      monthly: state.loans.reduce((s, l) => s + (num(l.payment) ?? 0), 0),
      avgMonths: ages.length ? ages.reduce((s, a) => s + a, 0) / ages.length : null,
      highestApr: debts[0] ?? null,
      mix: [state.cards.length ? 'Cards' : null, ...[...new Set(state.loans.map(l => l.type))].map(t => P.LOAN_TYPES[t]?.toLowerCase())].filter(Boolean),
      fico: fico.length ? { min: Math.min(...fico), max: Math.max(...fico), middle: P.middleScore(fico), count: fico.length } : null,
      vantage: vantage.length ? { min: Math.min(...vantage), max: Math.max(...vantage) } : null,
    };
  }

  // ─── Rail ────────────────────────────────────────────────────
  /** Draw the rail for the chosen model: FICO and VantageScore name their ranges differently. */
  function buildScale() {
    const rail = railFor(railModel());
    els.band.innerHTML = rail.map(t => `<span style="flex:${Math.min(t.to, MAX) - t.from};background:var(${LEVEL_COLOR[t.level]})"></span>`).join('');
    els.tierNames.innerHTML = rail.map(t => `<span style="left:${pct((t.from + Math.min(t.to, MAX)) / 2)}%">${t.name}</span>`).join('');
    const marks = [...rail.map(t => t.from), MAX];
    els.tierNums.innerHTML = marks.map((m, i) =>
      `<span class="${i === 0 ? 'end-l' : i === marks.length - 1 ? 'end-r' : ''}" style="left:${pct(m)}%">${m}</span>`).join('');
  }

  function renderScore() {
    const known = scoreKnown();
    const score = mainScore(), goal = num(state.goal);
    const hasScore = validScore(score), hasGoal = validScore(goal);
    const shown = known ? (state.score ?? '') : '';
    if (els.score.value !== shown) els.score.value = shown;
    els.score.disabled = !known;
    els.score.placeholder = known ? '680' : '\u2014';
    els.scoreBureau.disabled = !known;
    els.score.setAttribute('aria-invalid', known && badScore(state.score));
    els.goal.setAttribute('aria-invalid', badScore(state.goal));

    const rail = railFor(railModel());
    const active = hasScore ? rail.indexOf(railTier(score)) : -1;
    [...els.band.children].forEach((seg, i) => seg.classList.toggle('active', i === active));
    els.pinNow.hidden = !hasScore;
    els.pinGoal.hidden = !hasGoal;
    if (hasScore) els.pinNow.style.setProperty('--at', pct(score) + '%');
    if (hasGoal) els.pinGoal.style.setProperty('--at', pct(goal) + '%');

    const showGap = hasScore && hasGoal && goal > score;
    els.gap.hidden = !showGap;
    if (showGap) {
      els.gap.style.setProperty('--gap-from', pct(score) + '%');
      els.gap.style.setProperty('--gap-width', (pct(goal) - pct(score)) + '%');
    }
    placePinLabels(hasScore && hasGoal ? score : null, goal);

    // A bracket under the band spans the lowest to highest bureau score.
    const all = bureauScores().map(s => s.value);
    els.range.hidden = !all.length;
    if (all.length) {
      els.range.style.setProperty('--from', pct(Math.min(...all)) + '%');
      els.range.style.setProperty('--width', (pct(Math.max(...all)) - pct(Math.min(...all))) + '%');
    }

    const modelLabel = P.MODELS[railModel()].label;
    let read;
    if (!known) {
      read = 'No current score, and that\u2019s fine. The plan will work from your cards and loans instead.';
      if (hasGoal) read += ` Your goal of <strong>${goal}</strong> is ${railTier(goal).name} on the ${modelLabel} scale.`;
    } else if (isZero(state.score)) {
      read = 'A score of 0 counts as not known, and that\u2019s fine. The plan will work from your cards and loans instead.';
    } else if (!hasScore) {
      read = state.score ? 'Scores run from 300 to 850.' : 'Enter your current score, or choose \u201cI don\u2019t know my score\u201d.';
    } else {
      const t = railTier(score);
      const next = rail[rail.indexOf(t) + 1];
      const from = state.scoreBureau ? ` from ${P.BUREAUS[state.scoreBureau]}` : '';
      read = `<strong>${score}</strong>${from} is ${t.name} on the ${modelLabel} scale.`;
      if (hasGoal && goal > score) read += ` Your goal is <strong>${goal - score} points</strong> higher, in ${railTier(goal).name}.`;
      else if (hasGoal) read += ' You\u2019re already at your goal.';
      else if (next) read += ` ${next.from - score} points to ${next.name}.`;
    }
    els.scoreRead.innerHTML = read;
  }

  function placePinLabels(score, goal) {
    const nowL = els.pinNow.querySelector('.pin-label');
    const goalL = els.pinGoal.querySelector('.pin-label');
    nowL.className = 'pin-label';
    goalL.className = 'pin-label';
    const edge = (label, value) => {
      if (value == null) return;
      if (pct(value) < 5) label.classList.add('nudge-right');
      else if (pct(value) > 95) label.classList.add('nudge-left');
    };
    edge(nowL, mainScore());
    edge(goalL, num(state.goal));
    if (score == null) return;
    const dx = (pct(goal) - pct(score)) / 100 * (els.rail.clientWidth || 1);
    if (Math.abs(dx) < 70) {
      const [left, right] = dx >= 0 ? [nowL, goalL] : [goalL, nowL];
      left.className = 'pin-label nudge-left';
      right.className = 'pin-label nudge-right';
    }
  }

  // ─── Scores by bureau ────────────────────────────────────────
  function buildBureauRows() {
    els.bureauRows.innerHTML = Object.entries(P.BUREAUS).map(([b, label]) => `
      <tr>
        <th scope="row">${label}</th>
        ${Object.entries(P.MODELS).map(([m, { label: ml }]) => `
          <td><div class="bureau-cell">
            <input class="field" type="number" inputmode="numeric" min="300" max="850" placeholder="\u2014"
              data-bureau="${b}" data-model="${m}" aria-label="${label} ${ml}" value="${esc(state.scores[b][m] ?? '')}">
            <span class="tier" data-tier="${b}-${m}"></span>
          </div></td>`).join('')}
      </tr>`).join('');
    if (bureauScores().length) els.bureaus.open = true;
  }

  function renderBureaus() {
    // The cell matching the main score mirrors it (edit it at the top).
    const mirrored = scoreKnown() && state.scoreBureau ? `${state.scoreBureau}-${state.scoreModel}` : null;
    for (const input of els.bureauRows.querySelectorAll('input')) {
      const isMain = `${input.dataset.bureau}-${input.dataset.model}` === mirrored;
      const want = isMain ? (state.score ?? '') : (state.scores[input.dataset.bureau][input.dataset.model] ?? '');
      if (input.value !== want) input.value = want;
      input.disabled = isMain;
      input.title = isMain ? 'Your current score. Change it at the top.' : '';
      const v = num(input.value);
      const tier = els.bureauRows.querySelector(`[data-tier="${input.dataset.bureau}-${input.dataset.model}"]`);
      input.setAttribute('aria-invalid', badScore(input.value));
      if (validScore(v)) {
        const t = P.tierFor(v, input.dataset.model);
        tier.innerHTML = `${swatch(LEVEL_COLOR[t.level])}${t.name}`;
      } else {
        tier.textContent = isZero(input.value) ? 'Not known' : '';
      }
    }

    const s = stats();
    const lines = [];
    if (s.fico?.middle != null) {
      lines.push(`Middle FICO: <strong>${s.fico.middle}</strong>. Mortgage lenders commonly use this one.`);
    }
    if (s.fico && s.fico.count > 1) {
      const spread = s.fico.max - s.fico.min;
      lines.push(`FICO ranges from ${s.fico.min} to ${s.fico.max} across bureaus` + (spread >= 20
        ? `. A ${spread}-point gap is worth checking: pull the lowest bureau\u2019s report at AnnualCreditReport.com and look for errors or missing accounts.`
        : '.'));
    }
    if (s.vantage && s.vantage.max > s.vantage.min) lines.push(`VantageScore 3.0 ranges from ${s.vantage.min} to ${s.vantage.max}.`);
    els.bureauSummary.innerHTML = lines.length ? lines.map(l => `<p>${l}</p>`).join('') : '';

    const middle = s.fico?.middle;
    els.useMiddle.hidden = middle == null || (state.scoreModel === 'fico' && mainScore() === middle);
    if (middle != null) els.useMiddle.textContent = `Use ${middle} as my current score`;
  }

  els.bureauRows.addEventListener('input', e => {
    const input = e.target.closest('[data-bureau]');
    if (!input) return;
    state.scores[input.dataset.bureau][input.dataset.model] = input.value;
    renderBureaus();
    renderScore();
    changed();
  });
  els.useMiddle.addEventListener('click', () => {
    const middle = stats().fico?.middle;
    if (middle == null) return;
    Object.assign(state, { score: String(middle), scoreModel: 'fico', scoreBureau: '' });
    sourceChanged();
  });

  // ─── Account rows (cards and loans) ──────────────────────────
  const X_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  const moneyInput = (k, v, label, ph) =>
    `<div class="money"><input class="field" data-k="${k}" type="number" inputmode="decimal" min="0" step="any" placeholder="${ph}" aria-label="${label}" value="${esc(v ?? '')}"></div>`;
  const suffixInput = (k, v, label, suffix, attrs) =>
    `<label class="suffix" data-suffix="${suffix}"><input class="field" data-k="${k}" type="number" ${attrs} aria-label="${label}" value="${esc(v ?? '')}"></label>`;
  const aprInput = (v, label) => suffixInput('apr', v, `${label} APR`, '%', 'inputmode="decimal" min="0" max="100" step="any" placeholder="0"');
  const ageInputs = (a, label) => `<div class="age">
      ${suffixInput('ageYears', a.ageYears, `${label} age in years`, 'y', 'inputmode="numeric" min="0" max="80" placeholder="0"')}
      ${suffixInput('ageMonths', a.ageMonths, `${label} age in months`, 'm', 'inputmode="numeric" min="0" max="11" placeholder="0"')}
    </div>`;
  const removeBtn = label => `<button class="remove" type="button" data-remove aria-label="Remove ${label}">${X_ICON}</button>`;

  function cardRow(card, index) {
    const row = document.createElement('div');
    row.className = 'card-row';
    row.dataset.id = card.id;
    const label = esc(card.name || `Card ${index + 1}`);
    row.innerHTML = `
      <div class="acct-head card-head">
        <input class="field name-field" data-k="name" type="text" maxlength="60" placeholder="Card name" aria-label="Card name" value="${esc(card.name ?? '')}">
        ${removeBtn(label)}
      </div>
      <div class="acct-fields card-grid">
        <label class="lf"><span>Limit</span>${moneyInput('limit', card.limit, `${label} credit limit`, '5,000')}</label>
        <label class="lf"><span>Balance</span>${moneyInput('balance', card.balance, `${label} balance`, '1,200')}</label>
        <label class="lf"><span>APR</span>${aprInput(card.apr, label)}</label>
        <div class="lf"><span>Age</span>${ageInputs(card, label)}</div>
      </div>
      <div class="util">
        <div class="util-track"><div class="util-fill"></div><span class="util-tick" style="left:10%"></span><span class="util-tick" style="left:30%"></span></div>
        <span class="util-text"></span>
      </div>`;
    updateCard(row, card);
    return row;
  }

  function updateCard(row, card) {
    const limit = num(card.limit), balance = num(card.balance);
    const fill = row.querySelector('.util-fill'), text = row.querySelector('.util-text');
    if (limit > 0 && balance != null) {
      const u = Math.round(balance / limit * 100);
      fill.style.width = Math.min(u, 100) + '%';
      fill.style.backgroundColor = `var(${utilColor(u)})`;
      text.innerHTML = `<strong>${u}%</strong> used`;
    } else {
      fill.style.width = '0';
      text.textContent = 'not set';
    }
  }

  const typeOptions = selected => Object.entries(P.LOAN_TYPES)
    .map(([k, v]) => `<option value="${k}"${k === selected ? ' selected' : ''}>${v}</option>`).join('');

  function loanRow(loan) {
    const row = document.createElement('div');
    row.className = 'loan-row';
    row.dataset.id = loan.id;
    const label = esc(loan.name || P.LOAN_TYPES[loan.type] || 'Loan');
    row.innerHTML = `
      <div class="loan-head">
        <select class="field loan-type" data-k="type" aria-label="Loan type">${typeOptions(loan.type)}</select>
        <input class="field name-field" data-k="name" type="text" maxlength="60" placeholder="Lender or nickname (optional)" aria-label="Loan name" value="${esc(loan.name ?? '')}">
        ${removeBtn(label)}
      </div>
      <div class="loan-fields">
        <label class="lf"><span>Balance</span>${moneyInput('balance', loan.balance, `${label} balance`, '15,000')}</label>
        <label class="lf"><span>Original amount</span>${moneyInput('original', loan.original, `${label} original amount`, '24,000')}</label>
        <label class="lf"><span>APR</span>${aprInput(loan.apr, label)}</label>
        <label class="lf"><span>Monthly payment</span>${moneyInput('payment', loan.payment, `${label} monthly payment`, '475')}</label>
        <div class="lf"><span>Age</span>${ageInputs(loan, label)}</div>
      </div>
      <div class="util loan-progress">
        <div class="util-track"><div class="util-fill"></div></div>
        <span class="util-text"></span>
      </div>
      <p class="loan-note"></p>`;
    updateLoan(row, loan);
    return row;
  }

  function updateLoan(row, loan) {
    const balance = num(loan.balance), original = num(loan.original);
    const fill = row.querySelector('.util-fill'), text = row.querySelector('.util-text'), note = row.querySelector('.loan-note');
    if (original > 0 && balance != null && balance <= original) {
      const paid = Math.round((1 - balance / original) * 100);
      fill.style.width = paid + '%';
      text.innerHTML = `<strong>${paid}%</strong> paid`;
    } else {
      fill.style.width = '0';
      text.textContent = original > 0 && balance > original ? 'above original' : 'not set';
    }
    const p = payoffOf(loan);
    note.dataset.kind = p?.never ? 'warn' : '';
    note.textContent = p?.never
      ? 'This payment doesn\u2019t cover the monthly interest, so the balance won\u2019t go down.'
      : p ? `About ${monthsText(p.months)} and ${usd(p.interest)} in interest left at this payment.` : '';
  }

  /** Shared wiring for the card and loan lists. */
  function bindList(container, list, rowFn, update, labelOf, focusAfterRemove) {
    const render = () => container.replaceChildren(...list().map(rowFn));
    container.addEventListener('input', e => {
      const input = e.target.closest('[data-k]');
      if (!input) return;
      const row = input.closest('[data-id]');
      const item = list().find(x => x.id === row.dataset.id);
      item[input.dataset.k] = input.value;
      input.setAttribute('aria-invalid', !input.checkValidity());
      if (input.dataset.k === 'name' || input.dataset.k === 'type') {
        row.querySelector('[data-remove]').setAttribute('aria-label', `Remove ${labelOf(item)}`);
      }
      update(row, item);
      changed();
    });
    container.addEventListener('change', e => { if (e.target.matches('select[data-k]')) e.target.dispatchEvent(new Event('input', { bubbles: true })); });
    container.addEventListener('click', e => {
      const btn = e.target.closest('[data-remove]');
      if (!btn) return;
      const items = list();
      const idx = items.findIndex(x => x.id === btn.closest('[data-id]').dataset.id);
      items.splice(idx, 1);
      render();
      changed();
      const next = container.querySelectorAll('[data-id]')[Math.min(idx, items.length - 1)];
      (next?.querySelector('[data-remove]') ?? focusAfterRemove).focus();
    });
    return render;
  }

  const renderCards = bindList(els.cards, () => state.cards, cardRow, updateCard, c => c.name || 'this card', els.addCard);
  const renderLoans = bindList(els.loans, () => state.loans, loanRow, updateLoan, l => l.name || P.LOAN_TYPES[l.type] || 'this loan', els.addLoan);

  els.addCard.addEventListener('click', () => {
    state.cards.push(withId({ name: '', limit: '', balance: '', apr: '', ageYears: '', ageMonths: '' }));
    renderCards();
    changed();
    els.cards.lastElementChild.querySelector('[data-k="name"]').focus();
  });
  els.addLoan.addEventListener('click', () => {
    state.loans.push(withId({ type: 'auto', name: '', balance: '', original: '', apr: '', payment: '', ageYears: '', ageMonths: '' }));
    renderLoans();
    changed();
    els.loans.lastElementChild.querySelector('[data-k="type"]').focus();
  });

  // ─── Numbers ─────────────────────────────────────────────────
  function renderNumbers() {
    const s = stats();
    const row = (term, value, note) => `<div class="row"><dt>${term}</dt><dd>${value}</dd>${note ? `<div class="note">${note}</div>` : ''}</div>`;
    const utilNote = u => u < 10 ? 'Under 10%, the range scoring models reward most.'
      : u < 30 ? 'Under 30%. Getting below 10% can still help.'
      : 'Above 30%. Paying cards down is usually the fastest lever.';
    const rows = [];

    if (state.cards.length) {
      rows.push(s.util == null
        ? row('Card utilization', '\u2014', 'Add limits and balances to see this.')
        : row('Card utilization', `${swatch(utilColor(s.util))}${s.util}%`, `${usd(s.cardBal)} of ${usd(s.totalLimit)}. ${utilNote(s.util)}`));
      if (s.highest && s.priced.length > 1) rows.push(row('Highest single card', `${swatch(utilColor(s.highest.u))}${s.highest.u}%`, esc(s.highest.name)));
    }
    if (s.fico) {
      rows.push(s.fico.middle != null
        ? row('Middle FICO', String(s.fico.middle), `${s.fico.min} to ${s.fico.max} across the three bureaus.`)
        : row('FICO across bureaus', s.fico.min === s.fico.max ? String(s.fico.min) : `${s.fico.min}\u2013${s.fico.max}`));
    }
    rows.push(row('Total debt', usd(s.cardBal + s.loanBal),
      state.loans.length ? `${usd(s.cardBal)} on cards, ${usd(s.loanBal)} on loans.` : ''));
    if (state.loans.length) {
      rows.push(row('Loans paid down', s.paidDown == null ? '\u2014' : `${s.paidDown}%`,
        s.monthly ? `${usd(s.monthly)} a month in loan payments.` : 'Add original amounts to see this.'));
    }
    if (s.highestApr) rows.push(row('Highest APR', `${s.highestApr.apr}%`, esc(s.highestApr.name)));
    rows.push(row('Credit mix', esc(s.mix.join(', ') || '\u2014')));
    rows.push(row('Average account age', s.avgMonths == null ? '\u2014' : ageText(s.avgMonths), 'Cards and loans together, the way FICO counts it.'));
    els.numbers.innerHTML = rows.join('');
  }

  // ─── AI text: markdown + charts + tables, streamed ───────────
  function renderAI(el, text, streaming = false) {
    el._blocks = md.parse(text);
    el.innerHTML = md.toHTML(el._blocks, { chart: b => charts.figureHTML(b) });
    if (streaming) addCaret(el);
  }

  // Put the typing caret after the last word, but never inside a chart or table.
  function addCaret(el) {
    let t = el;
    while (t.lastElementChild) {
      const c = t.lastElementChild;
      if (['FIGURE', 'TABLE', 'PRE', 'svg'].includes(c.tagName)) return;
      if (['BR', 'CODE', 'STRONG', 'EM'].includes(c.tagName)) break;
      t = c;
    }
    t.insertAdjacentHTML('beforeend', '<span class="caret" aria-hidden="true"></span>');
  }

  const queued = new Set();
  function queueRender(el, text) {
    el._text = text;
    if (queued.has(el)) return;
    queued.add(el);
    // Skip if the stream finished (and the final render ran) before this frame.
    requestAnimationFrame(() => { if (queued.delete(el)) renderAI(el, el._text, true); });
  }

  function setStatus(el, html, kind = 'info') {
    el.innerHTML = html;
    el.dataset.kind = kind;
  }

  // ─── Providers ───────────────────────────────────────────────
  async function loadProviders() {
    try {
      providers = await engine.init();
    } catch {
      setStatus(els.notice, 'Can\u2019t reach the local server. Start it with <code>npm start</code>, then reload.');
      els.write.disabled = true;
      return;
    }
    els.providers.querySelectorAll('label').forEach(l => l.remove());
    for (const [key, p] of Object.entries(providers)) {
      const label = document.createElement('label');
      label.innerHTML = `<input type="radio" name="provider" value="${key}" ${p.configured ? '' : 'disabled'}><span>${esc(p.label)}</span>`;
      if (!p.configured) label.title = p.hint || `Add ${p.envKey} to .env to use ${p.label}`;
      els.providers.append(label);
    }
    const configured = Object.keys(providers).filter(k => providers[k].configured);
    if (!configured.includes(state.provider)) state.provider = configured[0] ?? Object.keys(providers)[0];
    els.providers.querySelector(`input[value="${state.provider}"]`).checked = true;
    renderModels();
    refreshControls();
    engine.ready?.then(refreshControls);
  }

  function renderModels() {
    const p = providers?.[state.provider];
    if (!p) return;
    els.model.innerHTML = p.models.map(m =>
      `<option value="${esc(m.id)}">${esc(m.label)}${m.note ? ` (${esc(m.note)})` : ''}</option>`).join('');
    const saved = state.models?.[state.provider];
    if (saved && p.models.some(m => m.id === saved)) els.model.value = saved;
    els.model.disabled = !p.configured;
  }

  /** Enable/disable everything that depends on providers and on a request running. */
  function refreshControls() {
    const anyConfigured = providers && Object.values(providers).some(p => p.configured);
    setStatus(els.notice, providers ? engine.notice() : els.notice.innerHTML);
    els.write.disabled = Boolean(running) || !anyConfigured;
    els.stop.hidden = running?.kind !== 'plan';
    els.write.textContent = running?.kind === 'plan' ? 'Writing\u2026' : 'Write my plan';

    const canAsk = anyConfigured && engine.canAsk();
    els.question.disabled = !canAsk || running?.kind === 'plan';
    els.ask.disabled = !canAsk || running?.kind === 'plan';
    els.ask.textContent = running?.kind === 'chat' ? 'Stop' : 'Ask';
    els.suggestions.querySelectorAll('button').forEach(b => { b.disabled = !canAsk || Boolean(running); });
    if (!canAsk && anyConfigured) setStatus(els.askNote, 'Questions need live AI, which isn\u2019t available in this view.');
    else if (els.askNote.dataset.kind !== 'error') setStatus(els.askNote, '');

    const hasPlan = Boolean(state.plan?.text);
    const canSave = engine.canSave();
    els.pdf.hidden = els.docx.hidden = !canSave;
    els.pdf.disabled = els.docx.disabled = !hasPlan || Boolean(running);
    els.copy.disabled = !hasPlan;
  }

  els.providers.addEventListener('change', e => {
    state.provider = e.target.value;
    renderModels();
    save();
  });
  els.model.addEventListener('change', () => {
    state.models = { ...state.models, [state.provider]: els.model.value };
    save();
  });

  // ─── Plan ────────────────────────────────────────────────────
  function renderPlan() {
    const p = state.plan;
    if (!p?.text) {
      els.plan.innerHTML = p?.message
        ? `<p class="error">${esc(p.message)}</p>`
        : '<p class="empty">Your plan shows up here, with charts where they help. It\u2019s written from the numbers on this page, so check your cards and loans first.</p>';
      els.planMeta.hidden = true;
      return;
    }
    renderAI(els.plan, p.text);
    if (p.status === 'error') els.plan.insertAdjacentHTML('beforeend', `<p class="error">${esc(p.message)} The plan above is incomplete.</p>`);
    els.planBy.textContent = p.by + (p.status === 'stopped' ? '. Stopped early.' : p.status === 'truncated' ? '. Cut off at the length limit.' : '.');
    els.planMeta.hidden = false;
    els.stale.hidden = p.profileKey === profileKey();
  }

  function startRun(kind) {
    running = { ctl: new AbortController(), kind };
    setStatus(els.fileStatus, '');
    refreshControls();
    return running.ctl.signal;
  }
  function endRun() {
    running = null;
    refreshControls();
  }

  async function writePlan() {
    if (running) return;
    if (scoreKnown() && !isZero(state.score) && !validScore(mainScore())) {
      els.plan.innerHTML = '<p class="error">Enter a current score between 300 and 850, or choose \u201cI don\u2019t know my score\u201d.</p>';
      return els.score.focus();
    }
    if (!hasAccounts()) {
      els.plan.innerHTML = '<p class="error">Add at least one card or loan first.</p>';
      return els.addCard.focus();
    }
    const key = profileKey();
    const signal = startRun('plan');
    els.stale.hidden = true;
    els.planMeta.hidden = true;
    els.plan.setAttribute('aria-busy', 'true');
    els.plan.innerHTML = '<p class="waiting">Reading your numbers\u2026</p>';

    let text = '';
    const res = await engine.plan({
      provider: state.provider, model: els.model.value, profile: profile(), signal,
      onText: t => { text = t; queueRender(els.plan, t); },
    });
    queued.delete(els.plan);
    els.plan.setAttribute('aria-busy', 'false');

    state.plan = text
      ? { text, by: res.by, status: res.status, message: res.message, profileKey: key }
      : { text: '', message: res.status === 'stopped' ? 'Stopped before any of the plan was written.' : res.message };
    endRun();
    renderPlan();
    save();
  }

  els.write.addEventListener('click', writePlan);
  els.stop.addEventListener('click', () => running?.ctl.abort());

  // ─── Files: copy, PDF, Word, CSV ─────────────────────────────
  const today = () => new Date().toISOString().slice(0, 10);

  async function saveFile(filename, blob) {
    try {
      const result = await engine.save({ filename, blob });
      if (result === 'declined') setStatus(els.fileStatus, '');
    } catch (err) {
      setStatus(els.fileStatus, esc(err.message || 'Couldn\u2019t save the file.'), 'error');
    }
  }

  function buildReport() {
    const s = stats();
    const score = mainScore(), goal = num(state.goal);
    const plainName = t => String(t).replace(/[*_`]/g, '');
    const dash = '\u2014';

    const modelLabel = P.MODELS[railModel()].label;
    const from = state.scoreBureau ? `, ${P.BUREAUS[state.scoreBureau]}` : '';
    const summary = [['Current score', validScore(score) ? `${score} (${railTier(score).name}, ${modelLabel}${from})` : 'Not known']];
    if (validScore(goal)) summary.push(['Goal', `${goal} (${railTier(goal).name}, ${modelLabel})`]);
    if (s.fico?.middle != null) summary.push(['Middle FICO', `${s.fico.middle} (range ${s.fico.min} to ${s.fico.max})`]);
    if (s.util != null) summary.push(['Card utilization', `${s.util}% (${usd(s.cardBal)} of ${usd(s.totalLimit)})`]);
    summary.push(['Total debt', usd(s.cardBal + s.loanBal)]);
    if (s.monthly) summary.push(['Monthly loan payments', usd(s.monthly)]);
    if (s.avgMonths != null) summary.push(['Average account age', ageText(s.avgMonths)]);

    const tables = [];
    const scored = Object.entries(P.BUREAUS).filter(([b]) => Object.keys(P.MODELS).some(m => validScore(num(state.scores[b][m]))));
    if (scored.length) {
      const cell = (b, m) => { const v = num(state.scores[b][m]); return validScore(v) ? `${v} (${P.tierFor(v, m).name})` : dash; };
      tables.push({
        title: 'Scores by bureau', header: ['Bureau', 'FICO', 'VantageScore 3.0'], align: ['left', 'right', 'right'],
        rows: scored.map(([b, label]) => [label, cell(b, 'fico'), cell(b, 'vantage')]),
        pdfWidths: ['*', 140, 140], docxWidths: [3400, 3000, 3000],
      });
    }
    if (state.cards.length) {
      tables.push({
        title: 'Your cards', header: ['Card', 'Limit', 'Balance', 'Used', 'APR', 'Age'], align: ['left', 'right', 'right', 'right', 'right', 'right'],
        rows: state.cards.map((c, i) => {
          const l = num(c.limit), b = num(c.balance), age = accountAge(c);
          return [plainName(c.name || `Card ${i + 1}`), l != null ? usd(l) : dash, b != null ? usd(b) : dash,
            l > 0 && b != null ? `${Math.round(b / l * 100)}%` : dash, num(c.apr) != null ? `${num(c.apr)}%` : dash, age != null ? ageText(age) : dash];
        }),
        pdfWidths: ['*', 56, 56, 38, 44, 62], docxWidths: [3300, 1300, 1300, 900, 1100, 1500],
      });
    }
    if (state.loans.length) {
      tables.push({
        title: 'Your loans', header: ['Loan', 'Balance', 'Original', 'APR', 'Monthly', 'Time left'], align: ['left', 'right', 'right', 'right', 'right', 'right'],
        rows: state.loans.map(l => {
          const type = P.LOAN_TYPES[l.type] ?? 'Loan', p = payoffOf(l);
          return [plainName(l.name && l.name !== type ? `${l.name} (${type.toLowerCase()})` : type),
            num(l.balance) != null ? usd(num(l.balance)) : dash, num(l.original) != null ? usd(num(l.original)) : dash,
            num(l.apr) != null ? `${num(l.apr)}%` : dash, num(l.payment) != null ? usd(num(l.payment)) : dash,
            p?.never ? 'Not paying down' : p ? monthsText(p.months) : dash];
        }),
        pdfWidths: ['*', 62, 62, 40, 56, 66], docxWidths: [3100, 1400, 1400, 900, 1200, 1500],
      });
    }

    const chat = [];
    state.chat.forEach((m, i) => {
      const next = state.chat[i + 1];
      if (m.role === 'user' && next?.role === 'assistant' && next.content) chat.push({ q: m.content, a: next.content });
    });

    return {
      title: 'Credit score plan',
      date: 'Prepared ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      by: state.plan.by,
      summary, tables,
      plan: state.plan.text,
      chat,
    };
  }

  async function exportPlan(kind, btn) {
    if (!state.plan?.text || running) return;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = kind === 'pdf' ? 'Preparing PDF\u2026' : 'Preparing Word file\u2026';
    setStatus(els.fileStatus, '');
    try {
      const blob = await exporter[kind](buildReport(), engine.vendor);
      await saveFile(`credit-plan-${today()}.${kind}`, blob);
    } catch (err) {
      setStatus(els.fileStatus, esc(err.message || 'Couldn\u2019t create the file.'), 'error');
    }
    btn.textContent = label;
    refreshControls();
  }

  els.pdf.addEventListener('click', () => exportPlan('pdf', els.pdf));
  els.docx.addEventListener('click', () => exportPlan('docx', els.docx));

  els.copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.plan?.text ?? '');
      els.copy.textContent = 'Copied';
    } catch {
      // Clipboard can be blocked in embedded views: select the plan so it can be copied by hand.
      const range = document.createRange();
      range.selectNodeContents(els.plan);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      els.copy.textContent = 'Selected: press Ctrl+C or \u2318C';
    }
    setTimeout(() => { els.copy.textContent = 'Copy'; }, 2400);
  });

  // Any table the AI writes can be saved as a spreadsheet.
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-csv]');
    const block = btn?.closest('.ai-text')?._blocks?.[Number(btn.dataset.csv)];
    if (block?.type === 'table') saveFile(`credit-plan-table-${today()}.csv`, new Blob([md.toCSV(block)], { type: 'text/csv' }));
  });

  // ─── Questions ───────────────────────────────────────────────
  function renderThread() {
    els.thread.replaceChildren();
    for (const m of state.chat) {
      const div = document.createElement('div');
      if (m.role === 'user') {
        div.className = 'q';
        div.innerHTML = '<span class="q-label">You asked</span><p></p>';
        div.querySelector('p').textContent = m.content;
      } else {
        div.className = 'a ai-text';
        renderAI(div, m.content);
        if (m.note) div.insertAdjacentHTML('beforeend', `<p class="${m.noteKind === 'error' ? 'error' : 'answer-note'}">${esc(m.note)}</p>`);
      }
      els.thread.append(div);
    }
    els.suggestions.hidden = state.chat.length > 0;
    els.clearChat.hidden = state.chat.length === 0;
  }

  /** Messages to send: drop questions whose answer failed with nothing written. */
  function history() {
    const out = [];
    for (const m of state.chat) {
      if (m.role === 'assistant' && !m.content) { if (out[out.length - 1]?.role === 'user') out.pop(); continue; }
      out.push({ role: m.role, content: m.content });
    }
    return out;
  }

  async function ask(question) {
    question = question.trim();
    if (!question || running) return;
    if ((scoreKnown() && !isZero(state.score) && !validScore(mainScore())) || !hasAccounts()) {
      setStatus(els.askNote, 'Enter your score (or choose \u201cI don\u2019t know my score\u201d) and at least one card or loan first, so the answer can use your numbers.', 'error');
      return;
    }
    setStatus(els.askNote, '');
    state.chat.push({ role: 'user', content: question });
    const messages = history();
    const answer = { role: 'assistant', content: '' };
    state.chat.push(answer);
    els.question.value = '';
    renderThread();

    const el = els.thread.lastElementChild;
    el.innerHTML = '<p class="waiting">Thinking\u2026</p>';
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const signal = startRun('chat');
    els.thread.setAttribute('aria-busy', 'true');

    const res = await engine.chat({
      provider: state.provider, model: els.model.value, profile: profile(),
      plan: state.plan?.text ?? '', messages, signal,
      onText: t => { answer.content = t; queueRender(el, t); },
    });
    queued.delete(el);
    els.thread.setAttribute('aria-busy', 'false');

    if (res.status === 'error') Object.assign(answer, { note: res.message, noteKind: 'error' });
    else if (res.status === 'stopped') answer.note = answer.content ? 'Stopped early.' : 'Stopped before an answer was written.';
    else if (res.status === 'truncated') answer.note = 'Cut off at the length limit.';
    endRun();
    renderThread();
    save();
  }

  els.ask.addEventListener('click', () => {
    if (running?.kind === 'chat') running.ctl.abort();
    else ask(els.question.value);
  });
  els.question.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(els.question.value); }
  });
  els.suggestions.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (btn) ask(btn.textContent);
  });
  els.clearChat.addEventListener('click', () => {
    if (running?.kind === 'chat') return;
    state.chat = [];
    renderThread();
    save();
    els.question.focus();
  });

  // ─── Wiring ──────────────────────────────────────────────────
  function changed() {
    renderNumbers();
    save();
    if (state.plan?.text) els.stale.hidden = state.plan.profileKey === profileKey();
  }
  for (const key of ['score', 'goal']) {
    els[key].value = state[key] ?? '';
    els[key].addEventListener('input', () => {
      state[key] = els[key].value;
      renderScore();
      renderBureaus();
      changed();
    });
  }
  window.addEventListener('resize', renderScore);

  // ─── Which score it is: model (or "I don't know") and bureau ─
  function syncSource() {
    els.scoreModel.querySelector(`input[value="${state.scoreModel}"]`).checked = true;
    els.scoreBureau.value = state.scoreBureau;
  }
  function sourceChanged() {
    syncSource();
    buildScale();
    renderScore();
    renderBureaus();
    changed();
  }
  // If the newly chosen bureau and model already has a score in the grid, use it.
  function prefillFromGrid() {
    if (!scoreKnown() || !state.scoreBureau || state.score) return;
    const v = state.scores[state.scoreBureau][state.scoreModel];
    if (v) state.score = v;
  }
  els.scoreModel.addEventListener('change', e => {
    state.scoreModel = e.target.value;
    prefillFromGrid();
    sourceChanged();
    if (scoreKnown()) els.score.focus();
  });
  els.scoreBureau.addEventListener('change', () => {
    state.scoreBureau = els.scoreBureau.value;
    prefillFromGrid();
    sourceChanged();
  });

  syncSource();
  buildScale();
  buildBureauRows();
  renderBureaus();
  renderScore();
  renderCards();
  renderLoans();
  renderNumbers();
  renderPlan();
  renderThread();
  refreshControls();
  loadProviders();
})(window.CSA, window.CreditProfile);
