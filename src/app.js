pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const selectBanco = document.getElementById('selectBanco');
const selectModelo = document.getElementById('selectModelo');
const modeloDescricao = document.getElementById('modeloDescricao');
const previewImg = document.getElementById('previewImg');
const previewFallback = document.getElementById('previewFallback');
const fileInput = document.getElementById('fileInput');
const dropzoneText = document.getElementById('dropzoneText');
const avisoCompatibilidade = document.getElementById('avisoCompatibilidade');
const btnConverter = document.getElementById('btnConverter');
const statusEl = document.getElementById('status');
const resultadoSection = document.getElementById('resultado');
const tabelaBody = document.querySelector('#tabelaResultado tbody');
const totalLinhasEl = document.getElementById('totalLinhas');

let registro = [];
let arquivoSelecionado = null;
// Cache das páginas do PDF já extraídas do arquivo atual, pra não ler o PDF
// de novo (custa caro) toda vez que o usuário troca o modelo selecionado.
let paginasCache = null;
let paginasCacheArquivo = null;

function setStatus(msg) {
  statusEl.textContent = msg;
}

function atualizarBotao() {
  btnConverter.disabled = !(arquivoSelecionado && selectModelo.value);
}

async function carregarRegistro() {
  const resp = await fetch('configs/bancos.json');
  registro = await resp.json();
  const bancos = [...new Set(registro.map((r) => r.banco))];
  selectBanco.innerHTML = bancos.map((b) => `<option value="${b}">${b}</option>`).join('');
  atualizarModelos();
}

function atualizarModelos() {
  const banco = selectBanco.value;
  const opcoes = registro.filter((r) => r.banco === banco);
  selectModelo.innerHTML = opcoes
    .map((o) => `<option value="${o.id}">${o.modelo}</option>`)
    .join('');
  atualizarPreview();
}

function itemSelecionado() {
  return registro.find((r) => r.id === selectModelo.value);
}

function atualizarPreview() {
  const item = itemSelecionado();
  if (!item) return;
  previewImg.hidden = false;
  previewFallback.hidden = true;
  previewImg.onerror = () => {
    previewImg.hidden = true;
    previewFallback.hidden = false;
  };
  previewImg.src = item.imagem;
  atualizarBotao();
}

selectBanco.addEventListener('change', atualizarModelos);
selectModelo.addEventListener('change', () => {
  atualizarPreview();
  conferirCompatibilidade();
});

fileInput.addEventListener('change', () => {
  arquivoSelecionado = fileInput.files[0] || null;
  dropzoneText.textContent = arquivoSelecionado
    ? arquivoSelecionado.name
    : 'Toque para escolher o PDF';
  paginasCache = null;
  paginasCacheArquivo = null;
  atualizarBotao();
  conferirCompatibilidade();
});

async function extrairPaginas(arrayBuffer) {
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.map((it) => ({
      text: it.str,
      x0: it.transform[4],
      top: viewport.height - it.transform[5],
    }));
    pages.push(items);
  }
  return pages;
}

function baixarExcel(transacoes, nomeArquivo) {
  const dados = transacoes.map((t) => ({
    Data: t.data,
    Descrição: t.descricao,
    Valor: t.valor,
  }));
  const ws = XLSX.utils.json_to_sheet(dados);
  ws['!cols'] = [{ wch: 12 }, { wch: 55 }, { wch: 16 }];

  // Formato contábil (moeda com sinal) na coluna Valor (C), a partir da linha 2
  const formatoContabil =
    '_-"R$" * #,##0.00_-;-"R$" * #,##0.00_-;_-"R$" * "-"??_-;_-@_-';
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let row = range.s.r + 1; row <= range.e.r; row++) {
    const addr = XLSX.utils.encode_cell({ r: row, c: 2 });
    const cell = ws[addr];
    if (cell) {
      cell.t = 'n';
      cell.z = formatoContabil;
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Lançamentos');
  XLSX.writeFile(wb, nomeArquivo);
}

function renderTabela(transacoes) {
  tabelaBody.innerHTML = transacoes
    .map((t) => {
      const cls = t.valor >= 0 ? 'valor-credito' : 'valor-debito';
      return `<tr><td>${t.data}</td><td>${t.descricao}</td><td class="${cls}">${t.valor.toFixed(2)}</td></tr>`;
    })
    .join('');
  totalLinhasEl.textContent = transacoes.length;
  resultadoSection.hidden = false;
}

// Testa as colunas esperadas de todos os outros modelos cadastrados contra
// a página 1 do PDF e devolve o de maior pontuação (só entre os compatíveis).
// Usado quando o modelo selecionado não bate, pra sugerir o certo.
async function sugerirModelo(pages, idAtual) {
  let melhor = null;
  for (const cand of registro) {
    if (cand.id === idAtual) continue;
    try {
      const cfg = await fetch(cand.config).then((r) => r.json());
      const res = window.ExtratoParser.validarModelo(pages, cfg);
      if (res.aplicavel && res.compativel && (!melhor || res.score > melhor.score)) {
        melhor = { ...cand, score: res.score };
      }
    } catch (e) {
      // config desse candidato falhou ao carregar — ignora e segue tentando os outros
    }
  }
  return melhor;
}

function esconderAviso() {
  avisoCompatibilidade.hidden = true;
  avisoCompatibilidade.textContent = '';
  avisoCompatibilidade.classList.remove('aviso-ok');
}

function mostrarAviso(msg, { ok = false } = {}) {
  avisoCompatibilidade.textContent = msg;
  avisoCompatibilidade.hidden = false;
  avisoCompatibilidade.classList.toggle('aviso-ok', ok);
}

// Garante que as páginas do PDF atual estão extraídas e em cache — só lê o
// arquivo de novo se ele mudou desde a última chamada.
async function obterPaginas() {
  if (paginasCache && paginasCacheArquivo === arquivoSelecionado) return paginasCache;
  const arrayBuffer = await arquivoSelecionado.arrayBuffer();
  paginasCache = await extrairPaginas(arrayBuffer);
  paginasCacheArquivo = arquivoSelecionado;
  return paginasCache;
}

// Roda assim que um PDF é escolhido (ou o modelo é trocado com um PDF já
// escolhido): confere se o arquivo bate com o modelo selecionado e, se não
// bater, procura nos demais modelos cadastrados por um que bata melhor —
// escrevendo a sugestão embaixo do upload, antes mesmo de clicar em Converter.
let conferenciaEmAndamento = 0;
async function conferirCompatibilidade() {
  const item = itemSelecionado();
  if (!item || !arquivoSelecionado) {
    esconderAviso();
    return;
  }

  const minhaConferencia = ++conferenciaEmAndamento;
  try {
    mostrarAviso('Conferindo se o PDF é compatível com o modelo selecionado…');
    const config = await fetch(item.config).then((r) => r.json());
    const pages = await obterPaginas();
    if (minhaConferencia !== conferenciaEmAndamento) return; // usuário já trocou algo, descarta

    const validacao = window.ExtratoParser.validarModelo(pages, config);
    if (!validacao.aplicavel) {
      esconderAviso();
      return;
    }
    if (validacao.compativel) {
      mostrarAviso(`PDF compatível com o modelo "${item.modelo}" (${item.banco}).`, { ok: true });
      return;
    }

    const sugestao = await sugerirModelo(pages, item.id);
    if (minhaConferencia !== conferenciaEmAndamento) return;

    if (sugestao) {
      mostrarAviso(
        `Este PDF não parece ser do modelo "${item.modelo}" (${item.banco}). Tente o modelo "${sugestao.modelo}" (${sugestao.banco}).`
      );
    } else {
      mostrarAviso(
        `Aviso: não encontrei todas as colunas esperadas do modelo "${item.modelo}" (faltando: ${validacao.faltando.join(', ') || '—'}).`
      );
    }
  } catch (e) {
    // Leitura do PDF/config falhou aqui — deixa o clique em Converter reportar o erro
    esconderAviso();
  }
}

btnConverter.addEventListener('click', async () => {
  const item = itemSelecionado();
  if (!item || !arquivoSelecionado) return;

  btnConverter.disabled = true;
  setStatus('Lendo configuração do modelo…');
  try {
    const config = await fetch(item.config).then((r) => r.json());

    setStatus('Lendo o PDF…');
    const pages = await obterPaginas();

    setStatus('Identificando lançamentos…');
    const transacoes = window.ExtratoParser.parseTransactions(pages, config);

    if (transacoes.length === 0) {
      setStatus('Não encontrei lançamentos com este modelo. Confira se o modelo selecionado é o certo.');
      return;
    }

    renderTabela(transacoes);

    const nomeBase = arquivoSelecionado.name.replace(/\.pdf$/i, '');
    baixarExcel(transacoes, `${nomeBase}.xlsx`);
    setStatus(`Pronto — ${transacoes.length} lançamentos exportados.`);
  } catch (err) {
    console.error(err);
    setStatus('Deu erro ao processar este PDF: ' + err.message);
  } finally {
    atualizarBotao();
  }
});

carregarRegistro();
