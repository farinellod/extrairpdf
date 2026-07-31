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
let registroAtivo = []; // subconjunto de `registro` exibido nos seletores —
                         // igual a `registro` no caso normal, mas fica
                         // restrito aos candidatos quando a detecção
                         // automática encontra mais de um modelo compatível.
let configsPorId = {};
let arquivoSelecionado = null;
let paginasPromise = null; // cache da extração (pages) do PDF atual, pra não
                            // reprocessar o mesmo arquivo duas vezes (uma na
                            // detecção automática, outra ao converter).

function setStatus(msg) {
  statusEl.textContent = msg;
}

function atualizarBotao() {
  btnConverter.disabled = !(arquivoSelecionado && selectModelo.value);
}

async function carregarRegistro() {
  const resp = await fetch('configs/bancos.json');
  registro = await resp.json();

  // Carrega todos os configs de uma vez (são arquivos pequenos) — usados
  // tanto pela detecção automática do modelo quanto, depois, ao converter,
  // sem precisar buscar de novo.
  const entradas = await Promise.all(
    registro.map((r) => fetch(r.config).then((resp2) => resp2.json()).then((cfg) => [r.id, cfg]))
  );
  configsPorId = Object.fromEntries(entradas);

  preencherSeletorCompleto();
}

function preencherSeletor(itens) {
  registroAtivo = itens;
  const bancos = [...new Set(itens.map((r) => r.banco))];
  selectBanco.innerHTML = bancos.map((b) => `<option value="${b}">${b}</option>`).join('');
  atualizarModelos();
}

function preencherSeletorCompleto() {
  preencherSeletor(registro);
}

function atualizarModelos() {
  const banco = selectBanco.value;
  const opcoes = registroAtivo.filter((r) => r.banco === banco);
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

selectBanco.addEventListener('change', () => {
  // Se a lista estava restrita aos candidatos da detecção automática e o
  // usuário mesmo assim mexeu no seletor, é sinal de que quer escolher outra
  // coisa — libera a lista completa de novo.
  registroAtivo = registro;
  atualizarModelos();
});
selectModelo.addEventListener('change', atualizarPreview);

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

// Extrai o PDF selecionado uma única vez e reaproveita o resultado — tanto a
// detecção automática (no fileInput) quanto o clique em "Converter" chamam
// isso, mas só o primeiro de fato processa o arquivo.
function obterPaginas() {
  if (!paginasPromise) {
    paginasPromise = arquivoSelecionado.arrayBuffer().then(extrairPaginas);
  }
  return paginasPromise;
}

fileInput.addEventListener('change', async () => {
  arquivoSelecionado = fileInput.files[0] || null;
  paginasPromise = null; // arquivo novo, invalida a extração anterior
  dropzoneText.textContent = arquivoSelecionado ? arquivoSelecionado.name : 'Toque para escolher o PDF';
  atualizarBotao();

  if (!arquivoSelecionado) {
    preencherSeletorCompleto();
    setStatus('');
    return;
  }

  setStatus('Analisando PDF…');
  try {
    const pages = await obterPaginas();
    const registroComConfig = registro.map((r) => ({ ...r, config: configsPorId[r.id] }));
    const candidatos = window.ExtratoParser.detectarModelo(pages, registroComConfig);

    if (candidatos.length === 1) {
      const [achado] = candidatos;
      preencherSeletorCompleto();
      selectBanco.value = achado.banco;
      atualizarModelos();
      selectModelo.value = achado.id;
      atualizarPreview();
      setStatus(`Modelo detectado automaticamente: ${achado.banco} — ${achado.modelo}. Confira a prévia e, se estiver certo, é só converter.`);
    } else if (candidatos.length > 1) {
      preencherSeletor(candidatos);
      setStatus(`Encontrei ${candidatos.length} modelos compatíveis com este PDF — confirme qual é o certo abaixo.`);
    } else {
      preencherSeletorCompleto();
      setStatus('Não consegui reconhecer o modelo automaticamente — selecione o banco e o modelo manualmente.');
    }
  } catch (err) {
    console.error(err);
    preencherSeletorCompleto();
    setStatus('Não consegui analisar o PDF automaticamente — selecione o banco e o modelo manualmente.');
  }
});

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

btnConverter.addEventListener('click', async () => {
  const item = itemSelecionado();
  if (!item || !arquivoSelecionado) return;

  btnConverter.disabled = true;
  try {
    const config = configsPorId[item.id];

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
