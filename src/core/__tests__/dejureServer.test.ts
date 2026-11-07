import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DejureServer } from '../../server/dejure';
import { fintoDejure, PASSWORD, UTENTE } from './fintoDejure';

// DeJure sul server: il codice comune (core/dejure.ts) su Chromium headless
// (server/dejure.ts), contro un DeJure finto in locale (fintoDejure.ts).
// Serve un Chrome/Chromium: JARAI_CHROMIUM, oppure Google Chrome sul Mac.

const CHROME = process.env.JARAI_CHROMIUM ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
describe.skipIf(!existsSync(CHROME))('DeJure sul server (Chromium headless)', () => {
  const finto = fintoDejure();
  let base = '';
  let cartella = '';

  beforeAll(async () => {
    await new Promise<void>((r) => finto.server.listen(0, '127.0.0.1', r));
    const indirizzo = finto.server.address();
    base = `http://127.0.0.1:${typeof indirizzo === 'object' && indirizzo ? indirizzo.port : 0}`;
    cartella = mkdtempSync(join(tmpdir(), 'jarai-dejure-prova-'));
  });
  afterAll(() => {
    finto.server.close();
    rmSync(cartella, { recursive: true, force: true });
  });

  it('fa il login da sé, cerca, legge massima e sentenza; poi dimentica tutto', async () => {
    const d = new DejureServer({ eseguibile: CHROME, cartella, base });
    expect(d.disponibile).toBe(false);
    d.imposta({ utente: UTENTE, password: PASSWORD });
    expect(d.disponibile).toBe(true);

    const ricerca = await d.cliente.cerca('art. 2051 caso fortuito', 5);
    expect(ricerca.risultati).toEqual([
      { id: '111', estremi: 'Cass. civ., Sez. III, 01/02/2024, n. 1234', titolo: 'Responsabilità del custode: caso fortuito', materia: 'Responsabilità civile' },
    ]);
    expect(ricerca.conteggi).toBe('57 Massime');
    expect(finto.userAgent()).not.toMatch(/Headless/i);
    expect(readdirSync(cartella).some((n) => n.startsWith('jarai-dejure-'))).toBe(true);

    const massima = await d.cliente.leggi('111', false);
    expect(massima.titolo).toContain('Responsabilità del custode');
    expect(massima.testo).toContain('caso fortuito esclude');
    expect(massima.testo).not.toContain('Appunta');
    expect(massima.idTestoIntegrale).toBe('111');

    const sentenza = await d.cliente.leggi('111', true);
    expect(sentenza.id).toBe('222');
    expect(sentenza.testo).toBe('FATTO: il ricorrente cadeva.\n\nDIRITTO: il ricorso è infondato.');

    expect((await d.cliente.cerca('niente da trovare', 5)).risultati).toEqual([]);

    await d.dimentica();
    expect(d.disponibile).toBe(false);
    // Profilo del browser (cookie DeJure) cancellato.
    expect(readdirSync(cartella).filter((n) => n.startsWith('jarai-dejure-'))).toEqual([]);
    await expect(d.cliente.cerca('art. 2051', 5)).rejects.toThrow('DeJure non è collegato sul computer dello studio.');
    await d.dimentica();
  }, 120_000);

  it('password sbagliata: messaggio chiaro', async () => {
    const d = new DejureServer({ eseguibile: CHROME, cartella, base });
    d.imposta({ utente: UTENTE, password: 'sbagliata' });
    await expect(d.cliente.cerca('art. 2051', 5)).rejects.toThrow('DeJure non ha accettato utente e password.');
    await d.dimentica();
  }, 120_000);
});
