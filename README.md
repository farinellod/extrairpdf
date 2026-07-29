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
   - `linhasIgnorar`: textos de linhas a pular (saldo, cabeçalho, rodapé)
   - `colDataX` / `colValorX`: faixa de posição horizontal (em pontos) onde
     ficam a data e o valor — dá pra descobrir isso abrindo o PDF e testando
     valores, ou me mandando o PDF de exemplo pra eu calibrar
   - `moeda`, `separadorDecimal`, `separadorMilhar`
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

## Rodando localmente

Como o `fetch()` dos arquivos de config precisa de um servidor (não abre
direto do `file://`), suba um servidor estático simples na pasta:

```bash
npx serve .
# ou
python3 -m http.server 8000
```

## Deploy na Vercel (gratuito)

Sem necessidade de build ou variável de ambiente — é um site estático puro.

- **Opção 1 (mais simples):** crie um repositório no GitHub com estes
  arquivos, entre em vercel.com → "Add New Project" → importe o repositório.
  A Vercel detecta que não há framework e serve os arquivos estáticos direto.
- **Opção 2 (sem GitHub):** instale a CLI (`npm i -g vercel`) e rode `vercel`
  dentro da pasta do projeto.

## Limitações conhecidas / próximos passos

- O parser foi validado com um extrato real da Cresol (21 lançamentos, todos
  batendo). Cada novo banco/modelo precisa ser calibrado e testado com um
  PDF de exemplo antes de confiar 100% no resultado.
- PDFs escaneados (imagem, sem texto selecionável) não funcionam — precisaria
  de OCR, que está fora do escopo deste site 100% client-side.
