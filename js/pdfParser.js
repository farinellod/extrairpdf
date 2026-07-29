// Parser genérico de extratos bancários em PDF, baseado em posição (x, y) do texto.
// Funciona tanto no navegador (via pdf.js) quanto no Node (usado só para testes).
// Cada "config" descreve o layout de um modelo de extrato (ex: configs/cresol1.json).

function clean(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function collapse(text) {
  return (text || '').replace(/\s+/g, '');
}

function escapeRegex(s) {
  return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseNumero(t, config) {
  const milhar = config.separadorMilhar || '.';
  const decimal = config.separadorDecimal || ',';
  t = t.split(milhar).join('');
  t = t.replace(decimal, '.');
  return parseFloat(t);
}

// Aceita um range [min,max] OU uma lista de ranges [[min,max],[min,max],...]
function inRange(x, range) {
  if (!range) return true;
  if (Array.isArray(range[0])) {
    return range.some((r) => x >= r[0] && x <= r[1]);
  }
  return x >= range[0] && x <= range[1];
}

function includesCollapsed(haystack, needle) {
  return collapse(haystack).includes(collapse(needle));
}

// Constrói o regex + a função de parse do valor, de acordo com o formato usado
// pelo banco:
//  - "prefixoSinal"       ->  "+ R$ 1.000,00" / "- R$ 800,00"   (ex: Cresol)
//  - "sinalOpcional"      ->  "840,95" (crédito) / "-77,50" (débito), sem moeda   (ex: Santander, Itaú, Sicredi novo)
//  - "sufixoCD"           ->  "R$ 1.800,00D" / "R$ 181,65C"   (ex: Sicoob — modelo ainda não validado)
//  - "colunaDebitoCredito"->  duas colunas separadas, sem sinal no texto; o sinal
//                              vem de qual coluna bateu (colDebitoX = negativo,
//                              colCreditoX = positivo). Ex: Sicredi (extrato antigo)
function getValorMatcher(config) {
  const moeda = escapeRegex(config.moeda || '');
  const formato = config.formatoValor || 'prefixoSinal';

  if (formato === 'sinalOpcional') {
    return {
      regex: /^-?[\d.,]+$/,
      parse: (raw) => {
        let t = raw.trim();
        let sign = 1;
        if (t.startsWith('-')) { sign = -1; t = t.slice(1).trim(); }
        return sign * parseNumero(t, config);
      },
    };
  }

  if (formato === 'sufixoCD') {
    const re = new RegExp('^' + moeda + '\\s*[\\d.,]+\\s*[CD]$');
    return {
      regex: re,
      parse: (raw) => {
        let t = raw.trim();
        const sign = /D$/.test(t) ? -1 : 1;
        t = t.slice(0, -1).trim();
        t = t.replace(new RegExp('^' + moeda + '\\s*'), '').trim();
        return sign * parseNumero(t, config);
      },
    };
  }

  // default: prefixoSinal
  const re = new RegExp('^[+-]\\s*' + moeda + '\\s*[\\d.,]+$');
  return {
    regex: re,
    parse: (raw) => {
      let t = raw.trim();
      let sign = 1;
      if (t.startsWith('-')) { sign = -1; t = t.slice(1).trim(); }
      else if (t.startsWith('+')) { t = t.slice(1).trim(); }
      t = t.replace(new RegExp('^' + moeda + '\\s*'), '').trim();
      return sign * parseNumero(t, config);
    },
  };
}

// pages: array (por página) de arrays de items { text, x0, top }
function parseTransactions(pages, config) {
  const dateRegex = /^\d{2}\/\d{2}\/\d{4}$/;
  const ignorar = config.linhasIgnorar || [];
  const tol = config.toleranciaLinha || 3;
  const colunaDebitoCredito = config.formatoValor === 'colunaDebitoCredito';
  const { regex: valorRegex, parse: parseValorFn } = colunaDebitoCredito
    ? { regex: /^[\d.,]+$/, parse: (raw) => parseNumero(raw.trim(), config) }
    : getValorMatcher(config);

  let flat = [];
  let ended = false;
  let started = false;
  pages.forEach((items, pageIdx) => {
    if (ended) return;
    const offset = pageIdx * 100000;
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

    for (const line of lines) {
      const lineText = line.items
        .slice()
        .sort((a, b) => a.x0 - b.x0)
        .map((it) => it.text)
        .join(' ');
      if (config.marcadorFim && includesCollapsed(lineText, config.marcadorFim)) {
        ended = true;
        break;
      }
      if (!started) {
        if (includesCollapsed(lineText, config.marcadorInicio)) started = true;
        continue;
      }
      if (ignorar.some((s) => includesCollapsed(lineText, s))) continue;
      flat.push(...line.items);
    }
  });

  const dateItems = flat.filter((it) => dateRegex.test(it.text) && inRange(it.x0, config.colDataX));

  let valorItems;
  if (colunaDebitoCredito) {
    const debitos = flat
      .filter((it) => valorRegex.test(it.text) && inRange(it.x0, config.colDebitoX))
      .map((it) => ({ ...it, _sinal: -1 }));
    const creditos = flat
      .filter((it) => valorRegex.test(it.text) && inRange(it.x0, config.colCreditoX))
      .map((it) => ({ ...it, _sinal: 1 }));
    valorItems = debitos.concat(creditos);
  } else {
    valorItems = flat.filter((it) => valorRegex.test(it.text) && inRange(it.x0, config.colValorX));
  }

  const modoData = config.modoData || 'porTransacao';
  let anchors;

  if (modoData === 'porGrupo') {
    // A data só é impressa uma vez por grupo de lançamentos (ex: Bradesco);
    // cada âncora usa a última data vista antes dela, varrendo o documento em ordem.
    const marcados = dateItems
      .map((d) => ({ ...d, _tipo: 'data' }))
      .concat(valorItems.map((v) => ({ ...v, _tipo: 'valor' })))
      .sort((a, b) => a.top - b.top);
    let dataAtual = null;
    anchors = [];
    for (const item of marcados) {
      if (item._tipo === 'data') {
        dataAtual = item.text;
      } else {
        const valor = colunaDebitoCredito ? item._sinal * parseValorFn(item.text) : parseValorFn(item.text);
        anchors.push({ top: item.top, data: dataAtual, valor, valorRef: item });
      }
    }
  } else {
    // Cada âncora usa a data mais próxima (por distância vertical) ainda não usada.
    const usedDateIdx = new Set();
    anchors = valorItems.map((v) => {
      let best = -1, bestDiff = Infinity;
      dateItems.forEach((d, i) => {
        if (usedDateIdx.has(i)) return;
        const diff = Math.abs(d.top - v.top);
        if (diff < bestDiff) { bestDiff = diff; best = i; }
      });
      if (best >= 0) usedDateIdx.add(best);
      const valor = colunaDebitoCredito ? v._sinal * parseValorFn(v.text) : parseValorFn(v.text);
      return {
        top: v.top,
        data: best >= 0 ? dateItems[best].text : null,
        valor,
        valorRef: v,
        dateRef: best >= 0 ? dateItems[best] : null,
      };
    });
  }

  const descItems = flat.filter(
    (it) =>
      !dateItems.includes(it) &&
      !valorItems.includes(it) &&
      inRange(it.x0, config.colDescricaoX)
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
  module.exports = { parseTransactions };
} else {
  window.ExtratoParser = { parseTransactions };
}
