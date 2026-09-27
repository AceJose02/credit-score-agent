// ─────────────────────────────────────────────────────────────
//  Credit score plan: page logic
//  Uses CSA.md (markdown.js), CSA.charts (charts.js),
//  CSA.exporter (export.js) and CSA.engine (engine.js).
// ─────────────────────────────────────────────────────────────
(function (CSA) {
  'use strict';
  const { md, charts, exporter, engine } = CSA;

  // ─── Constants ───────────────────────────────────────────────
  const MIN = 300, MAX = 850;
  const TIERS = [
    { name: 'Poor',        from: 300, to: 580 },
    { name: 'Fair',        from: 580, to: 670 },
    { name: 'Good',        from: 670, to: 740 },
    { name: 'Very good',   from: 740, to: 800 },
    { name: 'Exceptional', from: 800, to: 851 },
  ];
  const STORE_KEY = document.documentElement.dataset.storeKey || 'creditPlan.v3';
  const EXAMPLE = {
    score: '682', goal: '750',
    cards: [
      { name: 'Chase Sapphire',          limit: '8000', balance: '2100', ageYears: '4', ageMonths: '6' },
      { name: 'Capital One Quicksilver', limit: '3500', balance: '1800', ageYears: '2', ageMonths: '3' },
    ],
  };

  const $ = id => document.getElementById(id);
  const els = {
    score: $('score'), goal: $('goal'), scoreRead: $('scoreRead'),
    rail: $('rail'), band: $('band'), gap: $('gap'), pinNow: $('pinNow'), pinGoal: $('pinGoal'),
    tierNames: $('tierNames'), tierNums: $('tierNums'),
    cards: $('cards'), addCard: $('addCard'), numbers: $('numbers'),
    providers: $('providers'), model: $('model'),
    write: $('write'), stop: $('stop'), notice: $('notice'),
    plan: $('plan'), stale: $('stale'), planMeta: $('planMeta'), planBy: $('planBy'),
    copy: $('copy'), pdf: $('pdf'), docx: $('docx'), fileStatus: $('fileStatus'),
    thread: $('thread'), suggestions: $('suggestions'), question: $('question'), ask: $('ask'),
    askNote: $('askNote'), clearChat: $('clearChat'),
  };

  // ─── State ───────────────────────────────────────────────────
  let state = load() ?? structuredClone(EXAMPLE);
  state.cards = (state.cards ?? []).map(c => ({ ...c, id: crypto.randomUUID() }));
  state.plan ??= null;      // { text, by, status, message, profileKey }
  state.chat ??= [];        // [{ role, content, note?, noteKind? }]
  let providers = null;
  let running = null;       // { ctl: AbortController, kind: 'plan' | 'chat' }

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)); } catch { return null; }
  }
  function save() {
    try {
      const { cards, ...rest } = state;
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...rest, cards: cards.map(({ id, ...c }) => c) }));
    } catch { /* storage unavailable: fine, just not remembered */ }
  }

  // ─── Helpers ─────────────────────────────────────────────────
  const esc = md.escapeHtml;
  const num = v => (v === '' || v == null || !Number.isFinite(Number(v))) ? null : Number(v);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pct = v => ((clamp(v, MIN, MAX) - MIN) / (MAX - MIN)) * 100;
  const usd = n => '$' + Math.round(n).toLocaleString('en-US');
  const tierOf = s => TIERS.find(t => s >= t.from && s < t.to) ?? TIERS[TIERS.length - 1];
  const validScore = v => Number.isInteger(v) && v >= MIN && v <= MAX;
  const profile = () => ({ score: state.score, goal: state.goal, cards: state.cards.map(({ id, ...c }) => c) });
  const profileKey = () => JSON.stringify(profile());

  function utilColor(u) {
    if (u < 10) return '--t-exc';
    if (u < 30) return '--t-vgood';
    if (u < 50) return '--t-fair';
    return '--t-poor';
  }
  function ageText(months) {
    const y = Math.floor(months / 12), m = Math.round(months % 12);
    if (y && m) return `${y} yr ${m} mo`;
    if (y) return `${y} yr`;
    return `${m} mo`;
  }

  /** Numbers shared by the summary panel and the exported report. */
  function stats() {
    const priced = state.cards.filter(c => num(c.limit) > 0 && num(c.balance) != null);
    const totalLimit = priced.reduce((s, c) => s + num(c.limit), 0);
    const totalBal = priced.reduce((s, c) => s + num(c.balance), 0);
    const perCard = priced.map(c => ({ name: c.name || 'Unnamed card', u: Math.round(num(c.balance) / num(c.limit) * 100) }));
    const aged = state.cards.filter(c => num(c.ageYears) != null || num(c.ageMonths) != null);
    return {
      priced, totalLimit, totalBal,
      util: totalLimit > 0 ? Math.round(totalBal / totalLimit * 100) : null,
      highest: [...perCard].sort((a, b) => b.u - a.u)[0],
      avgMonths: aged.length ? aged.reduce((s, c) => s + (num(c.ageYears) ?? 0) * 12 + (num(c.ageMonths) ?? 0), 0) / aged.length : null,
    };
  }

  // ─── Rail ────────────────────────────────────────────────────
  function buildScale() {
    els.tierNames.innerHTML = TIERS.map(t => `<span style="left:${pct((t.from + Math.min(t.to, MAX)) / 2)}%">${t.name}</span>`).join('');
    const marks = [300, 580, 670, 740, 800, 850];
    els.tierNums.innerHTML = marks.map((m, i) =>
      `<span class="${i === 0 ? 'end-l' : i === marks.length - 1 ? 'end-r' : ''}" style="left:${pct(m)}%">${m}</span>`).join('');
  }

  function renderScore() {
    const score = num(state.score), goal = num(state.goal);
    const hasScore = validScore(score), hasGoal = validScore(goal);
    els.score.setAttribute('aria-invalid', Boolean(state.score) && !hasScore);
    els.goal.setAttribute('aria-invalid', Boolean(state.goal) && !hasGoal);

    const active = hasScore ? TIERS.indexOf(tierOf(score)) : -1;
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

    let read;
    if (!hasScore) {
      read = state.score ? 'Scores run from 300 to 850.' : 'Enter your current score to see where it sits.';
    } else {
      const t = tierOf(score);
      const next = TIERS[TIERS.indexOf(t) + 1];
      read = `<strong>${score}</strong> is ${t.name}.`;
      if (hasGoal && goal > score) read += ` Your goal is <strong>${goal - score} points</strong> higher, in ${tierOf(goal).name}.`;
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
    edge(nowL, num(state.score));
    edge(goalL, num(state.goal));
    if (score == null) return;
    const dx = (pct(goal) - pct(score)) / 100 * (els.rail.clientWidth || 1);
    if (Math.abs(dx) < 70) {
      const [left, right] = dx >= 0 ? [nowL, goalL] : [goalL, nowL];
      left.className = 'pin-label nudge-left';
      right.className = 'pin-label nudge-right';
    }
  }

  // ─── Cards ───────────────────────────────────────────────────
  const X_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

  function cardRow(card, index) {
    const row = document.createElement('div');
    row.className = 'card-row';
    row.dataset.id = card.id;
    const label = esc(card.name || `Card ${index + 1}`);
    const v = k => esc(card[k] ?? '');
    row.innerHTML = `
      <div class="card-fields">
        <div class="c-name"><input class="field name-field" data-k="name" type="text" maxlength="60" placeholder="Card name" aria-label="Card name" value="${v('name')}"></div>
        <div class="c-limit"><span class="mobile-label">Limit</span>
          <div class="money"><input class="field" data-k="limit" type="number" inputmode="decimal" min="0" step="any" placeholder="5,000" aria-label="${label} credit limit" value="${v('limit')}"></div></div>
        <div class="c-bal"><span class="mobile-label">Balance</span>
          <div class="money"><input class="field" data-k="balance" type="number" inputmode="decimal" min="0" step="any" placeholder="1,200" aria-label="${label} balance" value="${v('balance')}"></div></div>
        <div class="c-age"><span class="mobile-label">Age</span>
          <div class="age">
            <label><input class="field" data-k="ageYears" type="number" inputmode="numeric" min="0" max="80" placeholder="0" aria-label="${label} age in years" value="${v('ageYears')}"></label>
            <label><input class="field" data-k="ageMonths" type="number" inputmode="numeric" min="0" max="11" placeholder="0" aria-label="${label} age in months" value="${v('ageMonths')}"></label>
          </div></div>
        <div class="c-remove"><button class="remove" type="button" data-remove aria-label="Remove ${label}">${X_ICON}</button></div>
      </div>
      <div class="util">
        <div class="util-track"><div class="util-fill"></div><span class="util-tick" style="left:10%"></span><span class="util-tick" style="left:30%"></span></div>
        <span class="util-text"></span>
      </div>`;
    updateUtil(row, card);
    return row;
  }

  function updateUtil(row, card) {
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
    const flag = (k, max) => {
      const val = card[k];
      row.querySelector(`[data-k="${k}"]`).setAttribute('aria-invalid',
        val !== '' && val != null && (num(val) == null || num(val) < 0 || (max != null && num(val) > max)));
    };
    flag('limit'); flag('balance'); flag('ageYears', 80); flag('ageMonths', 11);
  }

  const renderCards = () => els.cards.replaceChildren(...state.cards.map(cardRow));

  els.cards.addEventListener('input', e => {
    const input = e.target.closest('[data-k]');
    if (!input) return;
    const row = input.closest('.card-row');
    const card = state.cards.find(c => c.id === row.dataset.id);
    card[input.dataset.k] = input.value;
    if (input.dataset.k === 'name') row.querySelector('[data-remove]').setAttribute('aria-label', `Remove ${input.value || 'this card'}`);
    updateUtil(row, card);
    changed();
  });
  els.cards.addEventListener('click', e => {
    const btn = e.target.closest('[data-remove]');
    if (!btn) return;
    const idx = state.cards.findIndex(c => c.id === btn.closest('.card-row').dataset.id);
    state.cards.splice(idx, 1);
    renderCards();
    changed();
    const next = els.cards.querySelectorAll('.card-row')[Math.min(idx, state.cards.length - 1)];
    (next?.querySelector('[data-remove]') ?? els.addCard).focus();
  });
  els.addCard.addEventListener('click', () => {
    state.cards.push({ id: crypto.randomUUID(), name: '', limit: '', balance: '', ageYears: '', ageMonths: '' });
    renderCards();
    changed();
    els.cards.lastElementChild.querySelector('[data-k="name"]').focus();
  });

  // ─── Numbers ─────────────────────────────────────────────────
  function renderNumbers() {
    const s = stats();
    const swatch = c => `<span class="swatch" style="background:var(${c})"></span>`;
    const row = (term, value, note) => `<div class="row"><dt>${term}</dt><dd>${value}</dd>${note ? `<div class="note">${note}</div>` : ''}</div>`;
    const utilNote = u => u < 10 ? 'Under 10%, the range scoring models reward most.'
      : u < 30 ? 'Under 30%. Getting below 10% can still help.'
      : 'Above 30%. Paying this down is usually the fastest lever.';
    const rows = [
      s.util == null ? row('Overall utilization', '\u2014', 'Add limits and balances to see this.')
        : row('Overall utilization', `${swatch(utilColor(s.util))}${s.util}%`, utilNote(s.util)),
    ];
    if (s.highest && s.priced.length > 1) rows.push(row('Highest single card', `${swatch(utilColor(s.highest.u))}${s.highest.u}%`, esc(s.highest.name)));
    if (s.util != null) rows.push(row('Owed', `${usd(s.totalBal)} of ${usd(s.totalLimit)}`));
    rows.push(row('Average card age', s.avgMonths == null ? '\u2014' : ageText(s.avgMonths)));
    rows.push(row('Open cards', String(state.cards.length)));
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
        : '<p class="empty">Your plan shows up here, with charts where they help. It\u2019s written from the numbers on this page, so check your cards first.</p>';
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
    if (!validScore(num(state.score))) {
      els.plan.innerHTML = '<p class="error">Enter a current score between 300 and 850 first.</p>';
      return els.score.focus();
    }
    if (!state.cards.length) {
      els.plan.innerHTML = '<p class="error">Add at least one card first.</p>';
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
    const score = num(state.score), goal = num(state.goal);
    const summary = [['Current score', `${score} (${tierOf(score).name})`]];
    if (validScore(goal)) summary.push(['Goal', `${goal} (${tierOf(goal).name})`]);
    if (s.util != null) summary.push(['Overall utilization', `${s.util}%`], ['Owed', `${usd(s.totalBal)} of ${usd(s.totalLimit)}`]);
    if (s.avgMonths != null) summary.push(['Average card age', ageText(s.avgMonths)]);

    const chat = [];
    state.chat.forEach((m, i) => {
      const next = state.chat[i + 1];
      if (m.role === 'user' && next?.role === 'assistant' && next.content) chat.push({ q: m.content, a: next.content });
    });

    return {
      title: 'Credit score plan',
      date: 'Prepared ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      by: state.plan.by,
      summary,
      cards: {
        header: ['Card', 'Limit', 'Balance', 'Used', 'Age'],
        align: ['left', 'right', 'right', 'right', 'right'],
        rows: state.cards.map((c, i) => {
          const l = num(c.limit), b = num(c.balance);
          const months = (num(c.ageYears) ?? 0) * 12 + (num(c.ageMonths) ?? 0);
          return [
            (c.name || `Card ${i + 1}`).replace(/[*_`]/g, ''),
            l != null ? usd(l) : '\u2014',
            b != null ? usd(b) : '\u2014',
            l > 0 && b != null ? `${Math.round(b / l * 100)}%` : '\u2014',
            c.ageYears || c.ageMonths ? ageText(months) : '\u2014',
          ];
        }),
      },
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
    if (!validScore(num(state.score)) || !state.cards.length) {
      setStatus(els.askNote, 'Enter your score and at least one card first, so the answer can use your numbers.', 'error');
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
      changed();
    });
  }
  window.addEventListener('resize', renderScore);

  buildScale();
  renderScore();
  renderCards();
  renderNumbers();
  renderPlan();
  renderThread();
  refreshControls();
  loadProviders();
})(window.CSA);
