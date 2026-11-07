// Prova DeJure vero con lo stesso codice del server (src/server/dejure.ts,
// Chromium headless), dal Mac. Utente e password si digitano qui, non si
// vedono e non si salvano; il profilo del browser è temporaneo.
// Uso: pnpm prova:dejure ["parole chiave"]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DejureServer } from '../src/server/dejure';

const CHROME = process.env.JARAI_CHROMIUM ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function chiedi(domanda: string, nascosta = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (nascosta) {
    const scrivi = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput.bind(rl);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => scrivi(s.startsWith(domanda) ? domanda : '');
  }
  return new Promise((r) =>
    rl.question(domanda, (v) => {
      rl.close();
      if (nascosta) process.stdout.write('\n');
      r(v);
    }),
  );
}

const ricerca = process.argv[2] ?? 'art. 2051 c.c. caso fortuito';
const utente = (await chiedi('Utente DeJure: ')).trim();
const password = await chiedi('Password DeJure (non si vede): ', true);
const cartella = mkdtempSync(join(tmpdir(), 'jarai-prova-dejure-'));
const d = new DejureServer({ eseguibile: CHROME, cartella });
d.imposta({ utente, password });
try {
  let t = Date.now();
  const r = await d.cliente.cerca(ricerca, 5);
  console.log(`\nRicerca «${ricerca}»: ${r.risultati.length} risultati in ${((Date.now() - t) / 1000).toFixed(1)} s${r.conteggi ? ` (totali: ${r.conteggi})` : ''}`);
  for (const x of r.risultati) console.log(`  - [${x.id}] ${x.estremi}`);
  const primo = r.risultati[0];
  if (primo) {
    t = Date.now();
    const m = await d.cliente.leggi(primo.id, false);
    console.log(`\nMassima: «${m.titolo}» — ${m.testo.length} caratteri in ${((Date.now() - t) / 1000).toFixed(1)} s${m.idTestoIntegrale ? ', con sentenza integrale' : ''}`);
    if (m.idTestoIntegrale) {
      t = Date.now();
      const s = await d.cliente.leggi(primo.id, true);
      console.log(`Sentenza: «${s.titolo}» — ${s.testo.length} caratteri in ${((Date.now() - t) / 1000).toFixed(1)} s${s.troncato ? ' (troncata)' : ''}`);
    }
  }
  console.log('\nDeJure funziona con il Chromium headless del server.');
} catch (err) {
  console.error(`\nErrore: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await d.dimentica();
  rmSync(cartella, { recursive: true, force: true });
}
