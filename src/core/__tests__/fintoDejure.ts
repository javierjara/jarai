import { createServer, type IncomingMessage, type Server } from 'node:http';

// Un DeJure finto con gli stessi selettori del sito vero: login nel frame SSO,
// risultati disegnati dopo il caricamento, massima e sentenza. Per le prove
// (dejureServer.test.ts) e per provare l'immagine Docker del server.

export const UTENTE = 'avv.prova';
export const PASSWORD = 'segreta';

const pagina = (corpo: string) => `<!doctype html><html lang="it"><head><meta charset="utf-8"></head><body>${corpo}</body></html>`;
const INTESTAZIONE_FUORI = `<header><a href="#" onclick="document.body.insertAdjacentHTML('beforeend','<iframe src=&quot;/logingfl/Login&quot;></iframe>');return false"><img alt="Login"></a></header>`;
const LOGIN = pagina(`<form onsubmit="return false">
  <input id="edit-ssousername" type="text"><input id="edit-password" type="password">
  <button id="edit-submit" type="button" onclick="
    fetch('/accedi', { method: 'POST', body: JSON.stringify({ u: document.getElementById('edit-ssousername').value, p: document.getElementById('edit-password').value }) })
      .then((r) => r.ok ? (top.location.href = '/') : (document.getElementById('esito').textContent = 'Credenziali errate'))">Login</button>
  <p id="esito"></p></form>`);

export function fintoDejure(): { server: Server; userAgent: () => string; consultazioni: () => number } {
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
