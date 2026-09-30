// ─────────────────────────────────────────────────────────────
//  Markdown → blocks → HTML
//
//  The AI's answers are parsed once into plain blocks. The screen
//  renderer, the PDF exporter and the Word exporter all read the
//  same blocks, so what you see is what you download.
//
//  Blocks: h, p, hr, list, table, chart, code
//  Everything is escaped before it becomes HTML, so model output
//  can never inject markup.
// ─────────────────────────────────────────────────────────────
(function (CSA) {
  'use strict';

  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── Inline: `code`, **bold**, *italic*, _italic_ ─────────────
  const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|(?<![\w*])\*(?!\s)([^*]+?)\*(?!\*)|(?<![\w])_(?!\s)([^_]+?)_(?![\w])/g;

  function inlineRuns(text) {
    const runs = [];
    let last = 0, m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text))) {
      if (m.index > last) runs.push({ text: text.slice(last, m.index) });
      if (m[1] != null) runs.push({ text: m[1], code: true });
      else if (m[2] != null) runs.push({ text: m[2], bold: true });
      else runs.push({ text: m[3] ?? m[4], italic: true });
      last = INLINE.lastIndex;
    }
    if (last < text.length) runs.push({ text: text.slice(last) });
    return runs;
  }

  function inlineHTML(text) {
    return inlineRuns(text).map(r => {
      const t = escapeHtml(r.text);
      return r.code ? `<code>${t}</code>` : r.bold ? `<strong>${t}</strong>` : r.italic ? `<em>${t}</em>` : t;
    }).join('');
  }

  const plain = text => inlineRuns(text).map(r => r.text).join('');

  // ── Blocks ───────────────────────────────────────────────────
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function splitRow(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map(c => c.trim());
  }

  function parse(src) {
    const lines = String(src ?? '').replace(/\r/g, '').split('\n');
    const blocks = [];
    let para = [], list = null;
    const flushPara = () => { if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = []; } };
    const flushList = () => { if (list) { blocks.push(list); list = null; } };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\s+$/, '');
      let m;

      // Fenced block (```chart holds chart JSON). Unclosed = still streaming.
      if ((m = line.match(/^\s*```\s*([\w-]*)\s*$/))) {
        flushPara(); flushList();
        const lang = m[1].toLowerCase();
        const body = [];
        let closed = false;
        for (i++; i < lines.length; i++) {
          if (/^\s*```\s*$/.test(lines[i])) { closed = true; break; }
          body.push(lines[i]);
        }
        blocks.push({ type: lang === 'chart' ? 'chart' : 'code', lang, text: body.join('\n'), closed });
        continue;
      }

      if (!line.trim()) { flushPara(); continue; }

      // Table: a row with pipes followed by a --- separator row.
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        flushPara(); flushList();
        const header = splitRow(line);
        const align = splitRow(lines[i + 1]).map(c => c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : null);
        const rows = [];
        for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) {
          const r = splitRow(lines[i]);
          rows.push(header.map((_, k) => r[k] ?? ''));
        }
        i--;
        blocks.push({ type: 'table', header, align: header.map((_, k) => align[k] ?? null), rows });
        continue;
      }

      const indent = line.match(/^\s*/)[0].length;

      if ((m = line.match(/^\s*(#{1,6})\s+(.*)$/))) {
        flushPara(); flushList();
        blocks.push({ type: 'h', level: m[1].length <= 2 ? 3 : 4, text: m[2].replace(/#+\s*$/, '') });
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); flushList(); blocks.push({ type: 'hr' }); continue; }

      if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/)) || (m = line.match(/^\s*([-*+])\s+(.*)$/))) {
        flushPara();
        const ordered = /\d/.test(m[1]);
        if (indent >= 2 && list) { list.items[list.items.length - 1].sub.push(m[2]); continue; }
        if (!list || list.ordered !== ordered) { flushList(); list = { type: 'list', ordered, start: ordered ? Number(m[1]) : 1, items: [] }; }
        list.items.push({ lines: [m[2]], sub: [] });
        continue;
      }
      if (list && indent >= 2) {
        const item = list.items[list.items.length - 1];
        if (item.sub.length) item.sub[item.sub.length - 1] += ' ' + line.trim();
        else item.lines.push(line.trim());
        continue;
      }
      flushList();
      para.push(line.trim());
    }
    flushPara(); flushList();
    return blocks;
  }

  // ── Tables ───────────────────────────────────────────────────
  const NUMERIC = /^[-+−]?\$?\s?[\d,]+(\.\d+)?\s?(%|pts?|k)?$/i;

  /** Right-align columns that are mostly numbers, unless the table says otherwise. */
  function columnAlign(table) {
    return table.header.map((_, k) => {
      if (table.align[k]) return table.align[k];
      const cells = table.rows.map(r => plain(r[k])).filter(Boolean);
      const numeric = cells.filter(c => NUMERIC.test(c)).length;
      return cells.length && numeric / cells.length >= 0.6 ? 'right' : 'left';
    });
  }

  function toCSV(table) {
    const cell = v => {
      let t = plain(v);
      if (/^[=@]/.test(t) || /^[+\-][^\d$]/.test(t)) t = "'" + t;   // keep spreadsheets from running it as a formula
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    return '\ufeff' + [table.header, ...table.rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  // ── HTML ─────────────────────────────────────────────────────
  function tableHTML(b, idx) {
    const align = columnAlign(b);
    const th = b.header.map((h, k) => `<th scope="col" style="text-align:${align[k]}">${inlineHTML(h)}</th>`).join('');
    const rows = b.rows.map(r => `<tr>${r.map((c, k) => `<td style="text-align:${align[k]}">${inlineHTML(c)}</td>`).join('')}</tr>`).join('');
    return `<figure class="md-table"><div class="table-scroll"><table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table></div>` +
      `<figcaption><button type="button" class="text-btn small" data-csv="${idx}">Download as spreadsheet (CSV)</button></figcaption></figure>`;
  }

  function listHTML(b) {
    const tag = b.ordered ? 'ol' : 'ul';
    const start = b.ordered && b.start > 1 ? ` start="${b.start}"` : '';
    return `<${tag}${start}>` + b.items.map(it =>
      `<li>${it.lines.map(inlineHTML).join('<br>')}${it.sub.length ? `<ul>${it.sub.map(s => `<li>${inlineHTML(s)}</li>`).join('')}</ul>` : ''}</li>`
    ).join('') + `</${tag}>`;
  }

  /** @param chart (block, index) => html for chart blocks */
  function toHTML(blocks, { chart } = {}) {
    return blocks.map((b, idx) => {
      switch (b.type) {
        case 'h':     return `<h${b.level}>${inlineHTML(b.text)}</h${b.level}>`;
        case 'p':     return `<p>${inlineHTML(b.text)}</p>`;
        case 'hr':    return '<hr>';
        case 'list':  return listHTML(b);
        case 'table': return tableHTML(b, idx);
        case 'code':  return `<pre class="code"><code>${escapeHtml(b.text)}</code></pre>`;
        case 'chart': return chart ? chart(b, idx) : '';
        default:      return '';
      }
    }).join('');
  }

  CSA.md = { parse, toHTML, inlineRuns, inlineHTML, plain, columnAlign, toCSV, escapeHtml };
})(window.CSA = window.CSA || {});
