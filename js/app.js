pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const selectBanco = document.getElementById('selectBanco');
const selectModelo = document.getElementById('selectModelo');
const modeloDescricao = document.getElementById('modeloDescricao');
const previewImg = document.getElementById('previewImg');
const previewFallback = document.getElementById('previewFallback');
const fileInput = document.getElementById('fileInput');
const dropzoneText = document.getElementById('dropzoneText');
const btnConverter = document.getElementById('btnConverter');
const statusEl = document.getElementById('status');
const resultadoSection = document.getElementById('resultado');
const tabelaBody = document.querySelector('#tabelaResultado tbody');
const totalLinhasEl = document.getElementById('totalLinhas');

let registro = [];
let arquivoSelecionado = null;

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
  modeloDescricao.textContent = item.descricao || '';
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
selectModelo.addEventListener('change', atualizarPreview);

fileInput.addEventListener('change', () => {
  arquivoSelecionado = fileInput.files[0] || null;
  dropzoneText.textContent = arquivoSelecionado
    ? arquivoSelecionado.name
    : 'Toque para escolher o PDF';
  atualizarBotao();
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
  ws['!cols'] = [{ wch: 12 }, { wch: 55 }, { wch: 14 }];
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

btnConverter.addEventListener('click', async () => {
  const item = itemSelecionado();
  if (!item || !arquivoSelecionado) return;

  btnConverter.disabled = true;
  setStatus('Lendo configuração do modelo…');
  try {
    const config = await fetch(item.config).then((r) => r.json());

    setStatus('Lendo o PDF…');
    const arrayBuffer = await arquivoSelecionado.arrayBuffer();
    const pages = await extrairPaginas(arrayBuffer);

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
