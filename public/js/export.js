// ─────────────────────────────────────────────────────────────
//  Export: the plan as a PDF or Word document
//
//  Report = title, date, who wrote it, score summary, account tables
//  (scores by bureau, cards, loans),
//  the plan (with its charts and tables) and any questions asked.
//  Both formats are built in the browser from the same Markdown
//  blocks the screen shows. Charts become PNG images.
//
//  pdfmake and docx are ~1 MB each, so they load on first use from
//  the URLs the engine provides.
// ─────────────────────────────────────────────────────────────
(function (CSA) {
  'use strict';

  const INK = '#17202b', INK2 = '#4b5664', INK3 = '#7a8491', RULE = '#d3d9e1';

  const loaded = {};
  function loadScript(src) {
    return loaded[src] ??= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { delete loaded[src]; reject(new Error('Couldn\u2019t load the export tools. Check your connection and try again.')); };
      document.head.append(s);
    });
  }

  /** Parse the plan and answers, and draw every chart as a PNG. */
  async function prepare(report) {
    const sections = {
      plan: CSA.md.parse(report.plan),
      chat: report.chat.map(({ q, a }) => ({ q, blocks: CSA.md.parse(a) })),
    };
    const charts = [sections.plan, ...sections.chat.map(c => c.blocks)].flat().filter(b => b.type === 'chart' && b.closed);
    await Promise.all(charts.map(async b => {
      const { spec } = CSA.charts.parse(b.text);
      if (!spec) return;
      b.spec = spec;
      try { b.png = await CSA.charts.toPNG(spec); } catch { /* leave the chart out rather than fail the file */ }
    }));
    return sections;
  }

  // ── PDF (pdfmake) ────────────────────────────────────────────
  const runsPdf = text => CSA.md.inlineRuns(text).map(r => ({ text: r.text, bold: !!r.bold, italics: !!r.italic }));

  function tablePdf(header, rows, align, widths = header.map(() => '*')) {
    const cell = (t, k, head) => head
      ? { text: CSA.md.plain(t), alignment: align[k], bold: true, fontSize: 8.5, color: INK2 }
      : { text: runsPdf(t), alignment: align[k], fontSize: 9.5 };
    return {
      table: { headerRows: 1, widths, body: [header.map((h, k) => cell(h, k, true)), ...rows.map(r => r.map((c, k) => cell(c, k, false)))] },
      layout: {
        hLineWidth: i => (i === 0 ? 0 : i === 1 ? 0.9 : 0.4), vLineWidth: () => 0, hLineColor: () => RULE,
        paddingLeft: () => 4, paddingRight: () => 4, paddingTop: () => 4, paddingBottom: () => 4,
      },
      margin: [0, 2, 0, 12],
    };
  }

  function blocksPdf(blocks) {
    const out = [];
    for (const b of blocks) {
      if (b.type === 'h') out.push({ text: runsPdf(b.text), style: b.level === 3 ? 'h3' : 'h4' });
      else if (b.type === 'p') out.push({ text: runsPdf(b.text), margin: [0, 0, 0, 7] });
      else if (b.type === 'hr') out.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 504, y2: 0, lineWidth: 0.5, lineColor: RULE }], margin: [0, 6, 0, 10] });
      else if (b.type === 'code') out.push({ text: b.text, fontSize: 9, color: INK2, margin: [0, 0, 0, 8] });
      else if (b.type === 'table') out.push(tablePdf(b.header, b.rows, CSA.md.columnAlign(b)));
      else if (b.type === 'chart' && b.png) {
        out.push({ stack: [b.spec.title ? { text: b.spec.title, style: 'caption' } : '', { image: b.png.dataUrl, width: 400 }], unbreakable: true, margin: [0, 4, 0, 12] });
      } else if (b.type === 'list') {
        const items = b.items.map(it => {
          const stack = it.lines.map((l, k) => ({ text: runsPdf(l), margin: [0, k ? 2 : 0, 0, 0] }));
          if (it.sub.length) stack.push({ ul: it.sub.map(s => ({ text: runsPdf(s) })), margin: [0, 3, 0, 0] });
          return { stack, margin: [0, 0, 0, 5] };
        });
        out.push(b.ordered ? { ol: items, start: b.start, margin: [0, 0, 0, 6] } : { ul: items, margin: [0, 0, 0, 6] });
      }
    }
    return out;
  }

  async function pdf(report, vendor) {
    await loadScript(vendor.pdfmake);
    await loadScript(vendor.vfs);
    const s = await prepare(report);

    const content = [
      { text: report.title, style: 'title' },
      { text: [report.date, report.by].filter(Boolean).join('\n'), style: 'meta' },
      {
        table: { widths: [150, '*'], body: report.summary.map(([k, v]) => [{ text: k, color: INK2 }, { text: v, bold: true }]) },
        layout: { hLineWidth: i => (i === 0 ? 0 : 0.4), vLineWidth: () => 0, hLineColor: () => RULE, paddingTop: () => 4, paddingBottom: () => 4, paddingLeft: () => 0 },
        margin: [0, 0, 0, 6],
      },
      ...report.tables.flatMap(t => [{ text: t.title, style: 'h2' }, tablePdf(t.header, t.rows, t.align, t.pdfWidths)]),
      { text: 'Your plan', style: 'h2' },
      ...blocksPdf(s.plan),
    ];
    if (s.chat.length) {
      content.push({ text: 'Your questions', style: 'h2' });
      for (const { q, blocks } of s.chat) content.push({ text: q, style: 'q' }, ...blocksPdf(blocks));
    }

    const doc = {
      pageSize: 'LETTER',
      pageMargins: [54, 54, 54, 64],
      info: { title: report.title, creator: 'Credit Score AI Agent' },
      defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.3, color: INK },
      styles: {
        title:   { fontSize: 20, bold: true, margin: [0, 0, 0, 4] },
        meta:    { fontSize: 9.5, color: INK2, margin: [0, 0, 0, 16] },
        h2:      { fontSize: 14, bold: true, margin: [0, 18, 0, 8] },
        h3:      { fontSize: 12.5, bold: true, margin: [0, 12, 0, 5] },
        h4:      { fontSize: 10.5, bold: true, margin: [0, 8, 0, 3] },
        caption: { fontSize: 10, bold: true, margin: [0, 0, 0, 4] },
        q:       { fontSize: 11, bold: true, margin: [0, 12, 0, 6] },
        foot:    { fontSize: 8.5, color: INK3 },
      },
      footer: (page, pages) => ({
        margin: [54, 26, 54, 0],
        columns: [{ text: 'General guidance, not financial advice.', style: 'foot' }, { text: `Page ${page} of ${pages}`, style: 'foot', alignment: 'right' }],
      }),
      content,
    };
    return window.pdfMake.createPdf(doc).getBlob();
  }

  // ── Word (docx) ──────────────────────────────────────────────
  async function docx(report, vendor) {
    await loadScript(vendor.docx);
    const D = window.docx;
    const s = await prepare(report);
    const hex = c => c.replace('#', '').toUpperCase();
    let olInstance = 0;

    const runs = (text, o = {}) => CSA.md.inlineRuns(text).map(r => new D.TextRun({
      text: r.text, bold: r.bold || o.bold, italics: r.italic, font: r.code ? 'Consolas' : undefined, size: o.size, color: o.color,
    }));
    const para = (text, o = {}) => new D.Paragraph({ children: runs(text, o), spacing: { after: 120 }, ...o.p });
    const heading = (text, level) => new D.Paragraph({ heading: level, children: runs(text) });

    const alignOf = a => a === 'right' ? D.AlignmentType.RIGHT : a === 'center' ? D.AlignmentType.CENTER : D.AlignmentType.LEFT;
    const none = { style: D.BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const line = w => ({ style: D.BorderStyle.SINGLE, size: w, color: hex(RULE) });

    function table(header, rows, align, { head = true, columnWidths } = {}) {
      const all = head ? [header, ...rows] : rows;
      return new D.Table({
        width: { size: 100, type: D.WidthType.PERCENTAGE },
        columnWidths,
        borders: { top: none, left: none, right: none, bottom: line(4), insideVertical: none, insideHorizontal: line(4) },
        rows: all.map((r, ri) => new D.TableRow({
          tableHeader: head && ri === 0,
          children: r.map((c, k) => new D.TableCell({
            margins: { top: 60, bottom: 60, left: 80, right: 80 },
            borders: head && ri === 0 ? { bottom: line(8) } : undefined,
            children: [new D.Paragraph({
              alignment: alignOf(align[k]),
              children: runs(c, head && ri === 0 ? { bold: true, size: 18, color: hex(INK2) } : { size: 20 }),
            })],
          })),
        })),
      });
    }

    function blocksDocx(blocks) {
      const out = [];
      for (const b of blocks) {
        if (b.type === 'h') out.push(heading(b.text, b.level === 3 ? D.HeadingLevel.HEADING_2 : D.HeadingLevel.HEADING_3));
        else if (b.type === 'p') out.push(para(b.text));
        else if (b.type === 'code') out.push(para(b.text, { color: hex(INK2) }));
        else if (b.type === 'hr') out.push(new D.Paragraph({ border: { bottom: line(4) }, spacing: { after: 160 } }));
        else if (b.type === 'table') out.push(table(b.header, b.rows, CSA.md.columnAlign(b)), new D.Paragraph({ spacing: { after: 120 } }));
        else if (b.type === 'chart' && b.png) {
          if (b.spec.title) out.push(para(b.spec.title, { bold: true, p: { keepNext: true, spacing: { before: 120, after: 60 } } }));
          out.push(new D.Paragraph({
            spacing: { after: 200, line: 240, lineRule: D.LineRuleType.AUTO },
            keepLines: true,
            children: [new D.ImageRun({ type: 'png', data: b.png.bytes, transformation: { width: 540, height: Math.round(540 * b.png.height / b.png.width) } })],
          }));
        } else if (b.type === 'list') {
          const instance = olInstance++;
          for (const it of b.items) {
            const children = it.lines.flatMap((l, k) => (k ? [new D.TextRun({ break: 1 }), ...runs(l)] : runs(l)));
            out.push(new D.Paragraph({
              children,
              spacing: { after: 80 },
              numbering: b.ordered ? { reference: 'ol', level: 0, instance } : { reference: 'ul', level: 0 },
            }));
            for (const sub of it.sub) out.push(new D.Paragraph({ children: runs(sub), spacing: { after: 60 }, numbering: { reference: 'ul', level: 1 } }));
          }
        }
      }
      return out;
    }

    const children = [
      new D.Paragraph({ heading: D.HeadingLevel.TITLE, children: [new D.TextRun(report.title)] }),
      new D.Paragraph({ children: [new D.TextRun({ text: [report.date, report.by].filter(Boolean).join('  |  '), color: hex(INK2), size: 19 })], spacing: { after: 240 } }),
      table(null, report.summary.map(([k, v]) => [k, `**${v}**`]), ['left', 'left'], { head: false }),
      ...report.tables.flatMap(t => [heading(t.title, D.HeadingLevel.HEADING_1), table(t.header, t.rows, t.align, { columnWidths: t.docxWidths })]),
      heading('Your plan', D.HeadingLevel.HEADING_1),
      ...blocksDocx(s.plan),
    ];
    if (s.chat.length) {
      children.push(heading('Your questions', D.HeadingLevel.HEADING_1));
      for (const { q, blocks } of s.chat) {
        children.push(para(q, { bold: true, p: { keepNext: true, spacing: { before: 200, after: 100 } } }), ...blocksDocx(blocks));
      }
    }

    const indent = (left, hanging = 320) => ({ paragraph: { indent: { left, hanging } } });
    const doc = new D.Document({
      creator: 'Credit Score AI Agent',
      title: report.title,
      styles: {
        default: {
          document: { run: { font: 'Calibri', size: 22, color: hex(INK) }, paragraph: { spacing: { line: 288, lineRule: D.LineRuleType.AUTO } } },
          title:    { run: { font: 'Calibri', size: 40, bold: true, color: hex(INK) }, paragraph: { spacing: { after: 80 } } },
          heading1: { run: { font: 'Calibri', size: 28, bold: true, color: hex(INK) }, paragraph: { spacing: { before: 360, after: 140 } } },
          heading2: { run: { font: 'Calibri', size: 24, bold: true, color: hex(INK) }, paragraph: { spacing: { before: 240, after: 100 } } },
          heading3: { run: { font: 'Calibri', size: 22, bold: true, color: hex(INK) }, paragraph: { spacing: { before: 200, after: 80 } } },
        },
      },
      numbering: {
        config: [
          { reference: 'ol', levels: [{ level: 0, format: D.LevelFormat.DECIMAL, text: '%1.', alignment: D.AlignmentType.START, style: indent(440) }] },
          { reference: 'ul', levels: [
            { level: 0, format: D.LevelFormat.BULLET, text: '\u2022', alignment: D.AlignmentType.START, style: indent(440) },
            { level: 1, format: D.LevelFormat.BULLET, text: '\u2013', alignment: D.AlignmentType.START, style: indent(880) },
          ] },
        ],
      },
      sections: [{
        properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
        footers: {
          default: new D.Footer({
            children: [new D.Paragraph({
              children: [
                new D.TextRun({ text: 'General guidance, not financial advice.   Page ', size: 16, color: hex(INK3) }),
                new D.TextRun({ children: [D.PageNumber.CURRENT], size: 16, color: hex(INK3) }),
              ],
            })],
          }),
        },
        children,
      }],
    });
    return D.Packer.toBlob(doc);
  }

  CSA.exporter = { pdf, docx };
})(window.CSA = window.CSA || {});
