// Parser genérico de extratos bancários em PDF, baseado em posição (x, y) do texto.
// Funciona tanto no navegador (via pdf.js) quanto no Node (usado só para testes).
// Cada "config" descreve o layout de um modelo de extrato (ex: configs/cresol1.json).

function clean(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function parseValor(rawText, config) {
  const moeda = config.moeda || 'R$';
  let t = rawText.replace(moeda, '').trim();
  let sign = 1;
  if (t.startsWith('-')) { sign = -1; t = t.slice(1).trim(); }
  else if (t.startsWith('+')) { t = t.slice(1).trim(); }
  const milhar = config.separadorMilhar || '.';
  const decimal = config.separadorDecimal || ',';
  t = t.split(milhar).join('');
  t = t.replace(decimal, '.');
  const value = parseFloat(t);
  return sign * value;
}

function inRange(x, range) {
  if (!range) return true;
  return x >= range[0] && x <= range[1];
}

// pages: array (por página) de arrays de items { text, x0, top }
// (top já deve incluir o offset de página para não colidir entre páginas)
function parseTransactions(pages, config) {
  const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
  const valorRegex = new RegExp('^[+-]\\s*' + config.moeda.replace('$', '\\$') + '\\s*[\\d.,]+$');
  const ignorar = config.linhasIgnorar || [];
  const tol = config.toleranciaLinha || 3;

  let flat = [];
  pages.forEach((items, pageIdx) => {
    const offset = pageIdx * 100000;
    // cluster items into visual lines by proximity em "top"
    const withTop = items
      .map((raw) => ({ text: clean(raw.text), x0: raw.x0, top: raw.top + offset }))
      .filter((it) => it.text);
    const lines = [];
    withTop
      .sort((a, b) => a.top - b.top)
      .forEach((it) => {
        const line = lines.find((l) => Math.abs(l.top - it.top) <= tol);
        if (line) line.items.push(it);
        else lines.push({ top: it.top, items: [it] });
      });

    let started = false;
    for (const line of lines) {
      const lineText = line.items
        .slice()
        .sort((a, b) => a.x0 - b.x0)
        .map((it) => it.text)
        .join(' ');
      if (!started) {
        if (lineText.includes(config.marcadorInicio)) started = true;
        continue;
      }
      if (ignorar.some((s) => lineText.includes(s))) continue;
      flat.push(...line.items);
    }
  });

  const dateItems = flat.filter((it) => dateRegex.test(it.text) && inRange(it.x0, config.colDataX));
  const valorItems = flat.filter((it) => valorRegex.test(it.text) && inRange(it.x0, config.colValorX));
  const used = new Set(valorItems).size ? null : null; // no-op, mantém legibilidade

  const usedDateIdx = new Set();
  const anchors = valorItems.map((v) => {
    let best = -1, bestDiff = Infinity;
    dateItems.forEach((d, i) => {
      if (usedDateIdx.has(i)) return;
      const diff = Math.abs(d.top - v.top);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    });
    if (best >= 0) usedDateIdx.add(best);
    return {
      top: v.top,
      data: best >= 0 ? dateItems[best].text : null,
      valor: parseValor(v.text, config),
      valorRef: v,
      dateRef: best >= 0 ? dateItems[best] : null,
    };
  });

  const descItems = flat.filter(
    (it) => !dateItems.includes(it) && !valorItems.includes(it)
  );

  const assigned = new Map(anchors.map((a) => [a, []]));
  descItems.forEach((it) => {
    if (anchors.length === 0) return;
    let best = anchors[0], bestDiff = Math.abs(anchors[0].top - it.top);
    for (const a of anchors) {
      const diff = Math.abs(a.top - it.top);
      if (diff < bestDiff) { bestDiff = diff; best = a; }
    }
    assigned.get(best).push(it);
  });

  const transactions = anchors.map((a) => {
    const parts = assigned.get(a).slice().sort((x, y) => x.top - y.top);
    const descricao = clean(parts.map((p) => p.text).join(' '));
    return { data: a.data, descricao, valor: a.valor, _top: a.top };
  });

  transactions.sort((x, y) => x._top - y._top);
  transactions.forEach((t) => delete t._top);
  return transactions;
}

if (typeof module !== 'undefined') {
  module.exports = { parseTransactions, parseValor };
} else {
  window.ExtratoParser = { parseTransactions, parseValor };
}
