import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DejureServer } from '../../server/dejure';

// DeJure sul server: il codice comune (core/dejure.ts) su Chromium headless
// (server/dejure.ts), contro un DeJure finto in locale con gli stessi
// selettori del sito vero: login nel frame SSO, ricerca, massima, sentenza.
// Serve un Chrome/Chromium: JARAI_CHROMIUM, oppure Google Chrome sul Mac.

const CHROME = process.env.JARAI_CHROMIUM ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UTENTE = 'avv.prova';
const PASSWORD = 'segreta';

const pagina = (corpo: string) => `<!doctype html><html lang="it"><head><meta charset="utf-8"></head><body>${corpo}</body></html>`;
const INTESTAZIONE_FUORI = `<header><a href="#" onclick="document.body.insertAdjacentHTML('beforeend','<iframe src=&quot;/logingfl/Login&quot;></iframe>');return false"><img alt="Login"></a></header>`;
const LOGIN = pagina(`<form onsubmit="return false">
  <input id="edit-ssousername" type="text"><input id="edit-password" type="password">
  <button id="edit-submit" type="button" onclick="
    fetch('/accedi', { method: 'POST', body: JSON.stringify({ u: document.getElementById('edit-ssousername').value, p: document.getElementById('edit-password').value }) })
      .then((r) => r.ok ? (top.location.href = '/') : (document.getElementById('esito').textContent = 'Credenziali errate'))">Login</button>
  <p id="esito"></p></form>`);

function fintoDejure(): { server: Server; userAgent: () => string; consultazioni: () => number } {
  let ua = '';
  let consultazioni = 0;
  const collegato = (req: IncomingMessage) => /(?:^|;\s*)s=ok/.test(req.headers.cookie ?? '');
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    ua = req.headers['user-agent'] ?? '';
    const html = (corpo: string) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(pagina(corpo));
    if (url.pathname === '/accedi' && req.method === 'POST') {
      let dati = '';
      req.on('data', (c) => (dati += c));
      req.on('end', () => {
        const { u, p } = JSON.parse(dati) as { u: string; p: string };
        if (u === UTENTE && p === PASSWORD) res.writeHead(200, { 'set-cookie': 's=ok; Path=/' }).end('ok');
        else res.writeHead(401).end();
      });
      return;
    }
    if (url.pathname === '/logingfl/Login') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(LOGIN);
    if (!collegato(req)) return html(`${INTESTAZIONE_FUORI}<main>Benvenuto</main>`);
    if (url.pathname === '/') return html(`<input placeholder="Cerca massime e sentenze">`);
    if (url.pathname === '/ricerca') {
      consultazioni++;
      const q = url.searchParams.get('searchText') ?? '';
      if (q.includes('niente')) return html(`<input placeholder="Cerca massime e sentenze"><p>Nessun risultato</p>`);
      // Risultati disegnati dopo il caricamento, come la SPA vera.
      return html(`<input placeholder="Cerca massime e sentenze"><div>Sinonimi suggeriti\n</div><div id="r"></div><script>
        setTimeout(() => {
          document.getElementById('r').innerHTML = '<div>57</div><div>Massime</div><div>Pertinenza:</div>'
            + '<div class="contenuto-ricerca-articoli"><div class="titolo-portali-ricerca"><a href="/dettaglio/111">Responsabilità del custode: caso fortuito</a></div><div class="descrizione-articolo-ricerca">Cass. civ., Sez. III, 01/02/2024, n. 1234</div><div class="testo-libri">Responsabilità civile</div></div>';
        }, 400);
      </script>`);
    }
    if (url.pathname === '/dettaglio/111') {
      consultazioni++;
      return html(`<div class="sopratitolo-dettaglio">Cass. civ., Sez. III, 01/02/2024, n. 1234</div><h1 class="titolo-dettaglio">Responsabilità del custode</h1>
        <p>Il caso fortuito esclude la responsabilità ex art. 2051 c.c.</p>\n<div>Appunta</div><div>Stampa</div>
        <button onclick="location.href='/dettaglio/222'">Sentenza</button>`);
    }
    if (url.pathname === '/dettaglio/222') {
      return html(`<h1 class="titolo-dettaglio">Sentenza n. 1234/2024</h1><div class="tipoud-main-col">FATTO: il ricorrente cadeva.</div><div class="tipoud-main-col">DIRITTO: il ricorso è infondato.</div>`);
    }
    res.writeHead(404).end();
  });
  return { server, userAgent: () => ua, consultazioni: () => consultazioni };
}

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
