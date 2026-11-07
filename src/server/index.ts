import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Archivio } from './archivio';

// JarAI Server (deploy/README.md): un container per studio, dietro il Caddy
// condiviso. Primo pezzo: l'archivio delle pratiche sincronizzato dal
// desktop. L'host con l'assistente arriverà qui, sullo stesso processo.
//
// Ambiente:
//   JARAI_LICENZA       licenza dello studio (credenziale del desktop)
//   JARAI_DATI          cartella dati (default /var/lib/jarai)
//   JARAI_PRATICHE      cartella dei file (default /pratiche)
//   JARAI_LIMITE_GB     limite di spazio; se manca lo chiede al proxy (CRM)
//   JARAI_PROXY_URL     default https://jarai-proxy.jarai-antonio.workers.dev
//   PORT                default 8787

const licenza = process.env.JARAI_LICENZA ?? '';
if (!licenza) {
  console.error('JARAI_LICENZA mancante: il server non parte.');
  process.exit(1);
}
const dati = process.env.JARAI_DATI ?? '/var/lib/jarai';
const pratiche = process.env.JARAI_PRATICHE ?? '/pratiche';
const proxy = process.env.JARAI_PROXY_URL ?? 'https://jarai-proxy.jarai-antonio.workers.dev';
mkdirSync(dati, { recursive: true, mode: 0o700 });
mkdirSync(pratiche, { recursive: true, mode: 0o700 });

const GB = 1024 ** 3;
let limiteCache: { valore: number | null; scade: number } | null = null;

/** Limite dal CRM (licenza → serverGb), rinfrescato ogni 10 minuti. */
async function limite(): Promise<number | null> {
  const daAmbiente = Number(process.env.JARAI_LIMITE_GB);
  if (process.env.JARAI_LIMITE_GB && Number.isFinite(daAmbiente)) return daAmbiente * GB;
  if (limiteCache && limiteCache.scade > Date.now()) return limiteCache.valore;
  try {
    const r = await fetch(`${proxy}/v1/license`, { headers: { 'x-api-key': licenza } });
    const d = r.ok ? ((await r.json()) as { serverGb?: number | null }) : null;
    const valore = typeof d?.serverGb === 'number' ? d.serverGb * GB : null;
    limiteCache = { valore, scade: Date.now() + 10 * 60_000 };
    return valore;
  } catch {
    // Proxy irraggiungibile: si tiene l'ultimo valore noto.
    return limiteCache?.valore ?? null;
  }
}

const archivio = new Archivio({ db: new DatabaseSync(join(dati, 'archivio.db')), cartella: pratiche, licenza, limite });

const server = createServer((req, res) => {
  if (req.url === '/salute') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  archivio
    .gestisci(req, res)
    .then((gestita) => {
      if (!gestita) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"errore":"Non trovato."}');
      }
    })
    .catch((err) => {
      console.error('richiesta', req.method, req.url, err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"errore":"Errore del server."}');
    });
});
// Upload lunghi su reti lente: niente timeout di richiesta.
server.requestTimeout = 0;
server.listen(Number(process.env.PORT ?? 8787), () => console.log(`JarAI Server in ascolto su ${process.env.PORT ?? 8787}`));
