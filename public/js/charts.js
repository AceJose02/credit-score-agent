// ─────────────────────────────────────────────────────────────
//  Charts
//
//  The AI writes charts as JSON in ```chart blocks:
//    {"type":"bar"|"line","title","unit":"$"|"%"|"pts","labels":[..],
//     "series":[{"name","values":[..]}]}
//  This file validates that JSON and draws it as SVG. The same
//  drawing is used on screen (theme colours via CSS variables) and
//  in exports (fixed colours, turned into a PNG).
//
//  Colour rule, same as the rest of the app: series are ink tones.
//  Colour appears only where it means credit health: utilization
//  bars (single % series) and FICO tier bands behind score lines.
// ─────────────────────────────────────────────────────────────
(function (CSA) {
  'use strict';

  const W = 480, H = 260;
  const TIERS = [
    { name: 'Poor', from: 300, to: 580 }, { name: 'Fair', from: 580, to: 670 },
    { name: 'Good', from: 670, to: 740 }, { name: 'Very good', from: 740, to: 800 },
    { name: 'Exceptional', from: 800, to: 850 },
  ];

  const SCREEN = {
    ink: 'var(--ink)', ink2: 'var(--ink-2)', ink3: 'var(--ink-3)', rule: 'var(--rule)', bg: 'var(--sheet)',
    font: 'var(--sans)', fs: 1.2, tiers: ['var(--t-poor)', 'var(--t-fair)', 'var(--t-good)', 'var(--t-vgood)', 'var(--t-exc)'],
  };
  const PRINT = {
    ink: '#17202b', ink2: '#4b5664', ink3: '#8a939e', rule: '#d3d9e1', bg: '#ffffff',
    font: 'Helvetica, Arial, sans-serif', fs: 1, tiers: ['#c2412d', '#d4891a', '#93a83a', '#3e9a66', '#1f7c78'],
  };

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── Validate the model's JSON ────────────────────────────────
  function parse(text) {
    let raw;
    try { raw = JSON.parse(text); } catch { return { error: 'This chart couldn\u2019t be read.' }; }
    const type = raw?.type === 'line' ? 'line' : raw?.type === 'bar' ? 'bar' : null;
    const labels = Array.isArray(raw?.labels) ? raw.labels.slice(0, 12).map(l => String(l).slice(0, 40)) : [];
    const series = (Array.isArray(raw?.series) ? raw.series : []).slice(0, 3).map(s => ({
      name: String(s?.name ?? '').slice(0, 32),
      values: labels.map((_, i) => {
        const v = typeof s?.values?.[i] === 'string' ? Number(s.values[i].replace(/[$,%\s]/g, '')) : Number(s?.values?.[i]);
        return Number.isFinite(v) ? v : null;
      }),
    })).filter(s => s.values.some(v => v != null));
    if (!type || !labels.length || !series.length) return { error: 'This chart is missing its data.' };
    return { spec: { type, title: String(raw.title ?? '').slice(0, 90), unit: ['$', '%', 'pts'].includes(raw.unit) ? raw.unit : '', labels, series } };
  }

  // ── Helpers ──────────────────────────────────────────────────
  function fmt(v, unit, compact) {
    if (v == null) return '';
    if (unit === '$') {
      if (compact && Math.abs(v) >= 1000) return '$' + (v / 1000).toFixed(Math.abs(v) % 1000 ? 1 : 0).replace(/\.0$/, '') + 'k';
      return '$' + Math.round(v).toLocaleString('en-US');
    }
    if (unit === '%') return Math.round(v) + '%';
    return Math.round(v).toLocaleString('en-US');
  }

  function niceStep(range, count) {
    const raw = range / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  }

  function domain(spec) {
    const vals = spec.series.flatMap(s => s.values).filter(v => v != null);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (spec.unit === 'pts') {
      lo = Math.max(300, lo - 20); hi = Math.min(850, hi + 20);
    } else {
      lo = Math.min(0, lo); hi = hi <= lo ? lo + 1 : hi * 1.08;
    }
    const step = niceStep(hi - lo || 1, 4);
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t * 100) / 100);
    return { lo, hi, ticks };
  }

  // Two lines max per axis label, sized to the space available.
  function wrap(label, maxChars) {
    const words = label.split(/\s+/);
    const lines = [''];
    for (const w of words) {
      const cur = lines[lines.length - 1];
      if (!cur) lines[lines.length - 1] = w;
      else if ((cur + ' ' + w).length <= maxChars) lines[lines.length - 1] = cur + ' ' + w;
      else if (lines.length < 2) lines.push(w);
      else { lines[1] = (lines[1] + ' ' + w); break; }
    }
    return lines.map(l => l.length > maxChars + 1 ? l.slice(0, maxChars) + '\u2026' : l);
  }

  function utilTier(u) { return u < 10 ? 4 : u < 30 ? 3 : u < 50 ? 1 : 0; }

  // ── Draw ─────────────────────────────────────────────────────
  function svg(spec, P = SCREEN) {
    const n = spec.series.length;
    const legend = n > 1;
    const m = { l: 54 * P.fs, r: 14, t: legend ? 34 * P.fs : 16, b: 44 * P.fs };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const { lo, hi, ticks } = domain(spec);
    const y = v => m.t + ph - ((v - lo) / (hi - lo)) * ph;
    const band = pw / spec.labels.length;
    const cx = i => m.l + band * (i + 0.5);
    const colors = n === 1 ? [P.ink] : n === 2 ? [P.ink3, P.ink] : [P.ink3, P.ink2, P.ink];
    const T = (x, yy, text, { size = 12, fill = P.ink2, anchor = 'middle', weight = 400 } = {}) =>
      `<text x="${x.toFixed(1)}" y="${yy.toFixed(1)}" text-anchor="${anchor}" style="font:${weight} ${(size * P.fs).toFixed(1)}px ${P.font};fill:${fill}">${esc(text)}</text>`;
    const out = [];

    // Tier bands behind score charts
    if (spec.unit === 'pts') {
      TIERS.forEach((t, i) => {
        const a = Math.max(t.from, lo), b = Math.min(t.to, hi);
        if (b <= a) return;
        out.push(`<rect x="${m.l}" y="${y(b).toFixed(1)}" width="${pw}" height="${(y(a) - y(b)).toFixed(1)}" style="fill:${P.tiers[i]};opacity:.13"/>`);
        if (y(a) - y(b) >= 16) out.push(T(W - m.r - 4, y(b) + 13, t.name, { size: 10.5, fill: P.ink3, anchor: 'end' }));
      });
    }

    // Grid + y axis
    for (const t of ticks) {
      out.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" style="stroke:${t === 0 ? P.ink3 : P.rule};stroke-width:1"/>`);
      out.push(T(m.l - 8, y(t) + 4, fmt(t, spec.unit, true), { size: 11, fill: P.ink3, anchor: 'end' }));
    }

    // X labels
    const maxChars = Math.max(6, Math.floor(band / (7 * P.fs)));
    spec.labels.forEach((label, i) => {
      wrap(label, maxChars).forEach((line, k) => out.push(T(cx(i), H - m.b + 18 * P.fs + k * 14 * P.fs, line, { size: 11.5, fill: P.ink2 })));
    });

    const showValues = spec.labels.length * n <= 12;

    if (spec.type === 'bar') {
      const group = band * (n === 1 ? 0.56 : 0.72);
      const bw = (group - (n - 1) * 3) / n;
      spec.series.forEach((s, si) => s.values.forEach((v, i) => {
        if (v == null) return;
        const x = cx(i) - group / 2 + si * (bw + 3);
        const y0 = y(Math.max(0, lo)), y1 = y(v);
        const top = Math.min(y0, y1), h = Math.max(1, Math.abs(y0 - y1));
        const fill = n === 1 && spec.unit === '%' ? P.tiers[utilTier(v)] : colors[si];
        out.push(`<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" style="fill:${fill}"/>`);
        if (showValues) out.push(T(x + bw / 2, top - 6, fmt(v, spec.unit), { size: 11.5, fill: P.ink, weight: 600 }));
      }));
    } else {
      spec.series.forEach((s, si) => {
        const pts = s.values.map((v, i) => v == null ? null : [cx(i), y(v)]).filter(Boolean);
        const dash = n > 1 && si < n - 1 ? 'stroke-dasharray:5 4;' : '';
        out.push(`<polyline points="${pts.map(p => p.map(c => c.toFixed(1)).join(',')).join(' ')}" style="fill:none;stroke:${colors[si]};stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round;${dash}"/>`);
        s.values.forEach((v, i) => {
          if (v == null) return;
          out.push(`<circle cx="${cx(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" style="fill:${colors[si]};stroke:${P.bg};stroke-width:2"/>`);
          if (showValues) out.push(T(cx(i), y(v) - 10, fmt(v, spec.unit), { size: 11.5, fill: P.ink, weight: 600 }));
        });
      });
    }

    // Legend
    if (legend) {
      let x = m.l;
      spec.series.forEach((s, si) => {
        out.push(`<rect x="${x}" y="10" width="10" height="10" rx="2" style="fill:${colors[si]}"/>`);
        out.push(T(x + 15, 19, s.name || `Series ${si + 1}`, { size: 11.5, fill: P.ink2, anchor: 'start' }));
        x += 15 + (s.name || 'Series 1').length * 6.6 * P.fs + 18;
      });
    }

    const summary = spec.title + '. ' + spec.labels.map((l, i) =>
      `${l}: ${spec.series.map(s => (n > 1 ? s.name + ' ' : '') + fmt(s.values[i], spec.unit)).join(', ')}`).join('; ');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(summary)}">${out.join('')}</svg>`;
  }

  // ── Screen: cached figure HTML for a chart block ─────────────
  const cache = new Map();
  function figureHTML(block) {
    if (!block.closed) return '<figure class="chart pending"><p>Drawing a chart\u2026</p></figure>';
    if (cache.has(block.text)) return cache.get(block.text);
    const { spec, error } = parse(block.text);
    const html = error
      ? `<figure class="chart"><p class="chart-error">${esc(error)}</p></figure>`
      : `<figure class="chart">${spec.title ? `<figcaption>${esc(spec.title)}</figcaption>` : ''}${svg(spec, SCREEN)}</figure>`;
    if (cache.size > 200) cache.clear();
    cache.set(block.text, html);
    return html;
  }

  // ── Export: PNG bytes for PDF / Word ─────────────────────────
  function toPNG(spec, scale = 2.5) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = W * scale; c.height = H * scale;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        const dataUrl = c.toDataURL('image/png');
        const bin = atob(dataUrl.split(',')[1]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve({ dataUrl, bytes, width: W, height: H });
      };
      img.onerror = () => reject(new Error('Couldn\u2019t draw a chart for the file.'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg(spec, PRINT));
    });
  }

  CSA.charts = { parse, svg, figureHTML, toPNG, SIZE: { W, H } };
})(window.CSA = window.CSA || {});
