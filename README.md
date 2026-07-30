# Extrato → Excel

Site estático (sem servidor, sem custo) que converte um extrato bancário em PDF
para uma planilha Excel com as colunas **Data, Descrição, Valor**.

Todo o processamento roda **dentro do navegador** (PDF.js lê o PDF, SheetJS gera
o `.xlsx`) — o arquivo do extrato nunca é enviado para nenhum servidor. Por ser
um site 100% estático, o deploy na Vercel entra tranquilamente no plano
gratuito (não existe função serverless rodando, então não há custo por
execução).

## Estrutura

```
index.html            página única (seletor de banco/modelo, upload, botão)
style.css
js/
  pdfParser.js         parser genérico, guiado pelo arquivo de config
  app.js               liga a UI: carrega configs, roda o pdf.js, gera o Excel
configs/
  bancos.json          registro: quais bancos/modelos aparecem no seletor
  cresol1.json         config testada com um extrato real da Cresol
  cresol2.example.json template para um 2º layout da Cresol (ainda não validado)
images/
  cresol1.png          prévia do modelo (para o usuário confirmar visualmente)
```

## Como funciona o parser

Extratos em PDF costumam ter duas colunas (descrição à esquerda, data/valor à
direita), então não dá pra usar regex linha a linha — o texto não sai na
ordem de leitura. O `pdfParser.js`:

1. Pega a posição (x, y) de cada trecho de texto do PDF (via `pdf.js`)
2. Agrupa em "linhas" por proximidade vertical
3. Ignora linhas de cabeçalho/rodapé/saldo (`linhasIgnorar` na config)
4. Acha as linhas "âncora": as que têm data (dentro de `colDataX`) e valor
   com sinal (dentro de `colValorX`)
5. Anexa a cada âncora as linhas de descrição mais próximas (cobre descrição
   que quebra em 2-3 linhas)

## Adicionando um novo banco ou modelo

1. Duplique `configs/cresol1.json` (ou `cresol2.example.json`) com um novo
   nome, por exemplo `configs/bb1.json`
2. Ajuste os campos olhando um extrato real desse banco:
   - `marcadorInicio`: texto que marca o início da lista de lançamentos
   - `marcadorFim` (opcional): texto que marca o fim (ex: um resumo/saldo que
     vem depois da tabela, como no extrato do Santander)
   - `linhasIgnorar`: textos de linhas a pular (saldo, cabeçalho, rodapé)
   - `colDataX` / `colValorX`: faixa de posição horizontal (em pontos) onde
     ficam a data e o valor
   - `colDescricaoX` (opcional, recomendado): faixa de posição da coluna de
     descrição — evita que outras colunas (tipo "Documento" ou "Saldo")
     vazem para dentro da descrição
   - `formatoValor`: como o valor aparece no extrato —
     - `"prefixoSinal"` (padrão): `+ R$ 1.000,00` / `- R$ 800,00` (Cresol)
     - `"sinalOpcional"`: `840,95` (crédito) / `-77,50` (débito), sem moeda
       (Santander, Itaú, Sicredi novo). `colValorX` também aceita uma lista de
       faixas — `[[335,400],[430,480]]` — quando o valor pode cair em mais de
       uma coluna (ex: Bradesco, que tem Crédito e Débito em colunas
       separadas mas cada uma já traz o sinal certo no texto)
     - `"sufixoCD"`: `R$ 1.800,00D` / `R$ 181,65C` — D de débito, C de
       crédito, no final do valor (Sicoob — ver observação abaixo)
     - `"colunaDebitoCredito"`: duas colunas separadas SEM sinal nenhum no
       texto — o sinal vem de qual coluna bateu. Precisa de `colDebitoX` e
       `colCreditoX` em vez de `colValorX` (ex: Sicredi formato antigo)
   - `modoData`: `"porTransacao"` (padrão) pega a data mais próxima de cada
     lançamento; `"porGrupo"` usa a última data vista antes daquele
     lançamento, para extratos que só imprimem a data uma vez por dia (ex:
     Bradesco)
   - `formatoData`: `"DD/MM/YYYY"` (padrão) ou `"DD/MM/AA"` (ano com 2 dígitos,
     ex: Stone) ou `"DD/MM"` (sem ano nenhum na linha do lançamento — o ano é
     descoberto a partir de uma linha de contexto em outro ponto da página,
     ex: C6, que só imprime o ano no cabeçalho de cada mês — "Janeiro 2026 (
     01/01/2026 - 31/01/2026 )". Nesse modo o parser varre toda linha (mesmo
     antes do `marcadorInicio` ou linhas que serão ignoradas) procurando um
     `DD/MM/YYYY` solto e usa o ano da ocorrência mais recente acima de cada
     lançamento. Dá pra trocar o padrão de busca com `anoContextoRegex` se
     algum banco usar outro formato de cabeçalho)
   - `moeda`, `separadorDecimal`, `separadorMilhar`
   - dá pra descobrir os valores de `colDataX`/`colValorX`/`colDescricaoX`
     abrindo o PDF e testando, ou me mandando o PDF de exemplo pra eu calibrar
3. Adicione uma imagem de prévia em `images/` (um print da página 1, por
   exemplo) e registre tudo em `configs/bancos.json`:

```json
{
  "id": "bb1",
  "banco": "Banco do Brasil",
  "modelo": "Modelo 1",
  "config": "configs/bb1.json",
  "imagem": "images/bb1.png",
  "descricao": "Extrato conta corrente BB — padrão 2026"
}
```

Se um banco tiver vários layouts (extrato antigo vs. novo, PF vs. PJ etc.),
é só criar `bb1`, `bb2`, `bb3` do mesmo jeito — igual já está feito para
`cresol1` / `cresol2`.

## Sinal, moeda e sufixo em pedaços separados

Em alguns extratos (Stone, Caixa) o PDF guarda o sinal, o "R$" e o número como
três palavras separadas, mesmo colados visualmente (ex: `-` `R$` `0,24`, ou
`3,87` `D`). O parser junta automaticamente qualquer sequência desses
pedacinhos que caia dentro da(s) faixa(s) de `colValorX` (ou
`colDebitoX`/`colCreditoX`) antes de tentar casar com o formato configurado —
não precisa fazer nada de especial no config além de acertar a faixa de
coluna.

## Formato do Excel gerado

A coluna Valor sai já em formato contábil do Excel (moeda com sinal,
`R$ 1.234,56` / `-R$ 1.234,56`), configurado em `js/app.js` na função
`baixarExcel`.

## Proteção do código (antes de monetizar)

Por enquanto o projeto continua sem login/cobrança, mas com algumas camadas
pra dificultar cópia — nenhuma delas é 100% à prova de alguém decidido (é
código que roda no navegador, sempre vai ser possível inspecionar em algum
nível), mas juntas evitam a cópia casual:

- **`src/` é o código-fonte editável** (`pdfParser.js`, `app.js`) — é aqui
  que você mexe quando for adicionar um banco novo ou corrigir algo.
- **`js/` é gerado automaticamente** rodando `npm install && npm run build`
  — o `build.js` minifica (`terser`) e depois ofusca (`javascript-obfuscator`:
  nomes de variável viram hex, strings ficam codificadas, fluxo de controle
  é embaralhado) o conteúdo de `src/` e grava em `js/`. **É o `js/` que o
  `index.html` carrega e que o navegador do usuário final baixa.**
- **`.vercelignore`** garante que `src/`, `build.js`, `package.json` e
  `node_modules/` não sejam publicados no deploy — só o `js/` já ofuscado
  vai pro ar.
- **Deixe o repositório do GitHub como privado.** O `.vercelignore` evita
  que o Vercel *sirva* o código-fonte, mas se o repositório for público
  qualquer um ainda enxerga `src/` inteiro pelo próprio GitHub. Repositório
  privado + `.vercelignore` juntos resolvem isso.
- **`LICENSE`**: deixa explícito que não é código aberto — sem isso, o
  default legal é ambíguo; com o arquivo, fica claro que cópia/redistribuição
  não é permitida.

**Sempre que mexer em algo dentro de `src/`, rode `npm run build` de novo
antes de fazer o deploy** — senão o `js/` publicado fica desatualizado.

## Rodando localmente

Como o `fetch()` dos arquivos de config precisa de um servidor (não abre
direto do `file://`), suba um servidor estático simples na pasta:

```bash
npx serve .
# ou
python3 -m http.server 8000
```

## Deploy na Vercel (gratuito)

Sem necessidade de build automático na Vercel (o `js/` já vai pronto no
repositório) — só não esqueça de rodar `npm run build` localmente sempre que
mexer em algo dentro de `src/`, **antes** de fazer o deploy (ver seção
"Proteção do código" acima).

- **Opção 1 (mais simples):** crie um repositório **privado** no GitHub com
  estes arquivos, entre em vercel.com → "Add New Project" → importe o
  repositório. A Vercel detecta que não há framework e serve os arquivos
  estáticos direto.
- **Opção 2 (sem GitHub):** instale a CLI (`npm i -g vercel`) e rode `vercel`
  dentro da pasta do projeto.

## Limitações conhecidas / próximos passos

- O parser foi validado com extratos reais de: Cresol (21 lançamentos),
  Santander (488), Itaú (58), Bradesco (527), Sicredi nos dois formatos
  (442 no formato antigo, 65 no novo), Caixa (97), Stone (400), Santander
  modelo 2 (73) e C6 Bank (919) — em todos, a soma dos valores reconcilia
  com a variação de saldo do próprio extrato (no C6, entradas/saídas batem
  exatamente com os totais que o próprio extrato imprime em cada um dos 6
  cabeçalhos de mês).
- **C6 tem duas colunas de data** (Data lançamento / Data contábil) e nenhuma
  das duas traz o ano — só o dia/mês. O config `c61.json` usa a coluna "Data
  lançamento" (a mais à esquerda) e descobre o ano pelo cabeçalho de cada mês
  (ver `formatoData: "DD/MM"` acima). Se preferir usar a "Data contábil" em
  vez da "Data lançamento", troque `colDataX` de `[30, 70]` para `[85, 120]`
  em `configs/c61.json`.
- Cada novo banco/modelo precisa ser calibrado e testado com um PDF de
  exemplo antes de confiar 100% no resultado.
- **Cabeçalho às vezes é imagem, não texto.** O extrato do Bradesco, por
  exemplo, tem o nome da empresa/CNPJ dentro de uma imagem (não dá pra achar
  a posição pelas coordenadas do PDF). Nesse caso, gerar a prévia e rodar OCR
  (`pytesseract`) só na imagem renderizada pra achar a caixa certa antes de
  redigir.
- **PDFs de imagem não funcionam.** Um extrato Sicoob enviado como teste veio
  sem nenhum texto selecionável — é uma imagem (print da tela do internet
  banking, não um PDF "de verdade"). Nesse caso não tem como ler posição de
  texto, e OCR seria necessário — só que OCR é bem menos confiável pra
  números financeiros e sairia do escopo "roda rápido no navegador". Antes de
  ir pra esse caminho, vale checar se o Sicoob oferece algum outro tipo de
  exportação (extrato em outro layout, CSV ou OFX) na área de internet
  banking — costuma ser bem mais confiável que OCR.
