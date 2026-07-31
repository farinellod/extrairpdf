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

  if (formato === 'semSinalContexto') {
    // valor sem sinal e sem moeda no texto (ex: "90,00"); o sinal não vem
    // daqui — é resolvido depois via marcadoresSinal + contexto de linha
    // (ex: Nubank, onde só a linha "Total de entradas/saídas" do grupo tem
    // sinal; cada lançamento individual embaixo só mostra o número).
    return {
      regex: /^[\d.,]+$/,
      parse: (raw) => parseNumero(raw.trim(), config),
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

  // default: prefixoSinal — sinal de "+" é opcional (alguns extratos só
  // marcam o "-" no débito e não mostram nada no crédito)
  const re = new RegExp('^[+-]?\\s*' + moeda + '\\s*[\\d.,]+$');
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

function normalizeRanges(range) {
  if (!range) return [];
  return Array.isArray(range[0]) ? range : [range];
}

// Junta, dentro de uma mesma linha, sequências de tokens "parecidos com valor"
// (sinal, símbolo de moeda, número, sufixo C/D) que caem numa mesma coluna-alvo.
// Necessário porque alguns extratos (Stone, Caixa) trazem cada pedacinho do
// valor como um item de texto separado no PDF, mesmo colados visualmente.
function mergeValueTokens(sortedItems, ranges, moeda) {
  if (ranges.length === 0) return sortedItems;
  const isValorLike = (t) =>
    t === '+' || t === '-' || t === 'C' || t === 'D' || t === moeda ||
    /^[\d.,]+$/.test(t) ||
    /^[\d.,]+[CD]$/.test(t); // número e sufixo C/D colados sem espaço (ex: Sicoob: "166,60D")

  const result = [];
  let buffer = null;
  for (const it of sortedItems) {
    const rangeIdx = ranges.findIndex((r) => it.x0 >= r[0] && it.x0 <= r[1]);
    if (rangeIdx >= 0 && isValorLike(it.text)) {
      if (buffer && buffer.rangeIdx === rangeIdx) {
        buffer.items.push(it);
      } else {
        if (buffer) result.push(flushBuffer(buffer));
        buffer = { rangeIdx, items: [it] };
      }
    } else {
      if (buffer) { result.push(flushBuffer(buffer)); buffer = null; }
      result.push(it);
    }
  }
  if (buffer) result.push(flushBuffer(buffer));
  return result;
}

function flushBuffer(buffer) {
  const items = buffer.items;
  return {
    text: items.map((i) => i.text).join(' '),
    x0: items[0].x0,
    top: items[0].top,
  };
}

// pages: array (por página) de arrays de items { text, x0, top }
function parseTransactions(pages, config) {
  // "DD/MM" -> extrato só imprime dia/mês em cada lançamento; o ano vem de
  // uma linha de contexto em outro lugar da página (ex: cabeçalho de mês do
  // C6, "Janeiro 2026 ( 01/01/2026 - ... )"). Regex de contexto default pega
  // qualquer DD/MM/YYYY solto na linha; dá pra sobrescrever com
  // `anoContextoRegex` na config se algum banco precisar de outro padrão.
  const formatoDataCfg = (config.formatoData || 'DD/MM/YYYY').toUpperCase();
  const usaAnoContexto = formatoDataCfg === 'DD/MM';
  // "DD MES YYYY" -> data por extenso com mês abreviado em português (ex:
  // Nubank: "03 JAN 2026"), impressa uma vez por grupo de lançamentos do dia,
  // junto com o rótulo "Total de entradas/saídas" na mesma linha. O parser
  // varre o TEXTO da linha inteira (não token a token) atrás desse padrão.
  const usaContextoLinha = formatoDataCfg === 'DD MES YYYY';
  const MESES_PT = { JAN: '01', FEV: '02', MAR: '03', ABR: '04', MAI: '05', JUN: '06',
    JUL: '07', AGO: '08', SET: '09', OUT: '10', NOV: '11', DEZ: '12' };
  const dataContextoLinhaRegex = /(\d{1,2})\s+(JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ)\s+(\d{4})/i;
  const dateRegex = usaContextoLinha
    ? null
    : usaAnoContexto
      ? /^\d{2}\/\d{2}$/
      : formatoDataCfg.includes('YYYY')
        ? /^\d{2}\/\d{2}\/\d{4}$/
        : /^\d{2}\/\d{2}\/\d{2}$/;
  const anoContextoRegex = config.anoContextoRegex
    ? new RegExp(config.anoContextoRegex)
    : /\d{2}\/\d{2}\/(\d{4})/;
  // "semSinalContexto" -> o valor de cada lançamento não tem sinal; o sinal
  // vem da linha-rótulo mais próxima ACIMA (ex: "Total de saídas" / "Total de
  // entradas" no Nubank), configurada em `marcadoresSinal`: [{texto, sinal}].
  const usaSinalContexto = config.formatoValor === 'semSinalContexto';
  const marcadoresSinal = config.marcadoresSinal || [];
  const ignorar = config.linhasIgnorar || [];
  const tol = config.toleranciaLinha || 3;
  const colunaDebitoCredito = config.formatoValor === 'colunaDebitoCredito';
  const { regex: valorRegex, parse: parseValorFn } = colunaDebitoCredito
    ? {
        // O sinal de fato vem da coluna (débito x crédito); alguns bancos
        // (ex: Santander Consolidado Inteligente) ainda imprimem um "-" de
        // sufixo decorativo só na coluna de débito ("330,00-") — aceito e
        // descarto, sem efeito no sinal (que já vem da coluna).
        regex: /^[\d.,]+-?$/,
        parse: (raw) => parseNumero(raw.trim().replace(/-$/, ''), config),
      }
    : getValorMatcher(config);
  const valorRanges = colunaDebitoCredito
    ? normalizeRanges(config.colDebitoX).concat(normalizeRanges(config.colCreditoX))
    : normalizeRanges(config.colValorX);

  let flat = [];
  let anoContextos = []; // { top, ano } — só usado quando usaAnoContexto
  let dataContextos = []; // { top, data } — só usado quando usaContextoLinha
  let sinalContextos = []; // { top, sinal } — só usado quando usaSinalContexto
  let ended = false;
  let started = false;
  pages.forEach((items, pageIdx) => {
    if (ended) return;
    const offset = pageIdx * 100000;
    const withTop = items
      // `ignorarTopoY`: descarta tudo acima dessa coordenada Y (em pontos,
      // antes do offset de página) em TODA página, não só na primeira — útil
      // pra extratos que repetem um cabeçalho com dados do titular no topo de
      // cada página (ex: Nubank: nome, CNPJ, período aparecem de novo em
      // toda página, e vazariam pra descrição do lançamento mais próximo).
      .filter((raw) => !config.ignorarTopoY || raw.top >= config.ignorarTopoY)
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
      const sortedItems = line.items.slice().sort((a, b) => a.x0 - b.x0);
      const lineText = sortedItems.map((it) => it.text).join(' ');

      // Captura os contextos (ano / data-por-linha / sinal) ANTES de
      // qualquer filtro (marcadorInicio/ignorar), porque a linha que traz o
      // contexto às vezes vem antes do marcadorInicio ou acaba sendo uma
      // linha ignorada (ex: a própria linha "Total de saídas" do Nubank).
      if (usaAnoContexto) {
        const m = lineText.match(anoContextoRegex);
        if (m) anoContextos.push({ top: line.top, ano: m[1] });
      }
      if (usaContextoLinha) {
        const m = lineText.match(dataContextoLinhaRegex);
        if (m) {
          const dia = m[1].padStart(2, '0');
          const mes = MESES_PT[m[2].toUpperCase()];
          if (mes) dataContextos.push({ top: line.top, data: `${dia}/${mes}/${m[3]}` });
        }
      }
      if (usaSinalContexto) {
        for (const marcador of marcadoresSinal) {
          if (includesCollapsed(lineText, marcador.texto)) {
            sinalContextos.push({ top: line.top, sinal: marcador.sinal });
            break;
          }
        }
      }

      if (config.marcadorFim && includesCollapsed(lineText, config.marcadorFim)) {
        ended = true;
        break;
      }
      if (!started) {
        if (includesCollapsed(lineText, config.marcadorInicio)) started = true;
        continue;
      }
      if (ignorar.some((s) => includesCollapsed(lineText, s))) continue;

      const itemsParaFlat = mergeValueTokens(sortedItems, valorRanges, config.moeda || '');
      flat.push(...itemsParaFlat);
    }
  });

  function resolveAno(top) {
    let best = null;
    for (const c of anoContextos) {
      if (c.top <= top && (!best || c.top > best.top)) best = c;
    }
    return (best || anoContextos[0] || {}).ano || '';
  }
  function resolveContexto(lista, top) {
    let best = null;
    for (const c of lista) {
      if (c.top <= top && (!best || c.top > best.top)) best = c;
    }
    return best || lista[0] || null;
  }

  let dateItems = usaContextoLinha
    ? []
    : flat.filter((it) => dateRegex.test(it.text) && inRange(it.x0, config.colDataX));
  if (usaAnoContexto) {
    dateItems = dateItems.map((it) => ({ ...it, text: `${it.text}/${resolveAno(it.top)}` }));
  }

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

  if (usaContextoLinha) {
    // Data e sinal não vêm de proximidade com um token — vêm inteiramente do
    // contexto de linha mais próximo ACIMA de cada valor (ex: Nubank).
    anchors = valorItems.map((v) => {
      const dataCtx = resolveContexto(dataContextos, v.top);
      const sinal = usaSinalContexto ? (resolveContexto(sinalContextos, v.top) || {}).sinal || 1 : 1;
      return {
        top: v.top,
        data: dataCtx ? dataCtx.data : null,
        valor: sinal * parseValorFn(v.text),
        valorRef: v,
      };
    });
  } else if (modoData === 'porGrupo') {
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
