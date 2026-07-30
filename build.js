// Gera as versões ofuscadas de js/pdfParser.js e js/app.js a partir de src/.
// Rode `npm run build` antes de cada deploy — o que fica em js/ é o que o
// navegador do usuário final baixa; o que fica em src/ é só pra edição local
// e NÃO deve subir pro Vercel (ver .vercelignore).
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');
const { minify } = require('terser');

const HEADER = `/*!
 * Extrato → Excel — © ${new Date().getFullYear()} Diego. Todos os direitos reservados.
 * Uso, cópia ou redistribuição deste código sem autorização não são permitidos.
 * Build gerado automaticamente — código-fonte legível não é distribuído.
 */\n`;

const arquivos = ['pdfParser.js', 'app.js'];

async function build() {
  fs.mkdirSync(path.join(__dirname, 'js'), { recursive: true });

  for (const nome of arquivos) {
    const srcPath = path.join(__dirname, 'src', nome);
    const code = fs.readFileSync(srcPath, 'utf8');

    // 1) minifica primeiro (remove comentários, encurta nomes locais)
    const minified = await minify(code, { mangle: true, compress: true });

    // 2) ofusca em cima do minificado (renomeia identificadores, embaralha
    //    strings, achata o controle de fluxo) — dificulta leitura, não é
    //    reversível de forma trivial por "Ver código-fonte"
    const obfuscated = JavaScriptObfuscator.obfuscate(minified.code, {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.75,
      deadCodeInjection: true,
      deadCodeInjectionThreshold: 0.3,
      stringArray: true,
      stringArrayEncoding: ['base64'],
      stringArrayThreshold: 0.75,
      identifierNamesGenerator: 'hexadecimal',
      renameGlobals: false, // preserva window.ExtratoParser (usado pelo app.js)
      selfDefending: true,
    }).getObfuscatedCode();

    const outPath = path.join(__dirname, 'js', nome);
    fs.writeFileSync(outPath, HEADER + obfuscated);
    console.log(`ok: src/${nome} -> js/${nome} (${code.length} -> ${obfuscated.length} bytes)`);
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
