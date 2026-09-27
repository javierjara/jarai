// Prepara i pacchetti nativi Windows prima di `electron-builder --win`.
//
// L'installer Windows si costruisce anche dal Mac, ma lì npm salta le
// optionalDependencies con "os": ["win32"]: l'app finiva impacchettata senza
// claude.exe (chat e verifica: "Serve un componente aggiuntivo", anche con
// Claude Code installato sul PC) e senza canvas (niente OCR dei PDF).
// Qui si scarica il tarball della versione esatta richiesta dal pacchetto
// padre e lo si estrae in node_modules, senza toccare il resto dell'albero
// (un `npm install --os=win32` rimuoverebbe i binari macOS usati in sviluppo).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const radice = join(import.meta.dirname, '..');
const moduli = join(radice, 'node_modules');

const binari = [
  { padre: '@anthropic-ai/claude-agent-sdk', pacchetto: '@anthropic-ai/claude-agent-sdk-win32-x64', file: 'claude.exe' },
  { padre: '@napi-rs/canvas', pacchetto: '@napi-rs/canvas-win32-x64-msvc', file: 'skia.win32-x64-msvc.node' },
];

const leggiJson = (percorso) => JSON.parse(readFileSync(percorso, 'utf-8'));

for (const { padre, pacchetto, file } of binari) {
  const pkgPadre = leggiJson(join(moduli, padre, 'package.json'));
  const versione = pkgPadre.optionalDependencies?.[pacchetto] ?? pkgPadre.version;
  const destinazione = join(moduli, pacchetto);
  const pkgPresente = join(destinazione, 'package.json');

  if (existsSync(join(destinazione, file)) && leggiJson(pkgPresente).version === versione) {
    console.log(`✓ ${pacchetto}@${versione} già presente`);
    continue;
  }

  console.log(`↓ ${pacchetto}@${versione}`);
  const temp = mkdtempSync(join(tmpdir(), 'jarai-win-'));
  try {
    const tarball = execFileSync('npm', ['pack', `${pacchetto}@${versione}`, '--silent'], { cwd: temp, encoding: 'utf-8' })
      .trim()
      .split('\n')
      .pop();
    rmSync(destinazione, { recursive: true, force: true });
    mkdirSync(destinazione, { recursive: true });
    execFileSync('tar', ['-xzf', join(temp, tarball), '-C', destinazione, '--strip-components=1']);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  if (!existsSync(join(destinazione, file))) {
    console.error(`✗ ${pacchetto}: manca ${file} dopo l'estrazione`);
    process.exit(1);
  }
  console.log(`✓ ${pacchetto}@${versione} pronto`);
}
