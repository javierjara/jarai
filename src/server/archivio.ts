import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import { FORMATO_CHIAVE, type ElencoRemoto } from '../core/sincronizzazione';

// JarAI Server, lato archivio: riceve dal desktop dello studio i file delle
// pratiche (src/core/sincronizzazione.ts) e li tiene in /pratiche/<chiave>.
// L'indice (dimensione, impronta) sta in SQLite. Il limite di spazio arriva
// dal CRM (licenza) o dall'ambiente.

export const MAX_FILE = 2 * 1024 ** 3;

export interface OpzioniArchivio {
  db: DatabaseSync;
  cartella: string;
  licenza: string;
  /** Byte disponibili; null = senza limite. */
  limite: () => Promise<number | null>;
  orologio?: () => string;
}

export function preparaDb(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS archivio_file (
    chiave TEXT PRIMARY KEY,
    dimensione INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    aggiornato_il TEXT NOT NULL
  )`);
}

function rispondi(res: ServerResponse, stato: number, corpo: unknown): void {
  const testo = JSON.stringify(corpo);
  res.writeHead(stato, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(testo) });
  res.end(testo);
}

function autorizzato(req: IncomingMessage, licenza: string): boolean {
  const dato = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
  const a = createHash('sha256').update(dato).digest();
  const b = createHash('sha256').update(licenza).digest();
  return licenza.length > 0 && timingSafeEqual(a, b);
}

export class Archivio {
  constructor(private readonly o: OpzioniArchivio) {
    preparaDb(o.db);
  }

  usati(): number {
    return (this.o.db.prepare('SELECT COALESCE(SUM(dimensione), 0) AS n FROM archivio_file').get() as { n: number }).n;
  }

  async elenco(): Promise<ElencoRemoto> {
    const file = this.o.db.prepare('SELECT chiave, dimensione, sha256 FROM archivio_file ORDER BY chiave').all() as unknown as ElencoRemoto['file'];
    return { file, usati: this.usati(), limite: await this.o.limite() };
  }

  /** Dove sta il file di una chiave (per l'host del server, documento.leggi). */
  percorso(chiave: string): string {
    if (!FORMATO_CHIAVE.test(chiave)) throw new Error('chiave non valida');
    return join(this.o.cartella, chiave);
  }

  /** Gestisce /sync/*; false se la richiesta non è dell'archivio. */
  async gestisci(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!url.pathname.startsWith('/sync/')) return false;
    if (!autorizzato(req, this.o.licenza)) {
      rispondi(res, 401, { errore: 'Licenza non riconosciuta.' });
      return true;
    }
    if (url.pathname === '/sync/elenco' && req.method === 'GET') {
      rispondi(res, 200, await this.elenco());
      return true;
    }
    const m = /^\/sync\/file\/(.+)$/.exec(url.pathname);
    const chiave = m ? decodeURIComponent(m[1]) : '';
    if (!m || !FORMATO_CHIAVE.test(chiave)) {
      rispondi(res, 404, { errore: 'Non trovato.' });
      return true;
    }
    if (req.method === 'PUT') await this.carica(chiave, req, res);
    else if (req.method === 'DELETE') {
      await rm(this.percorso(chiave), { force: true });
      this.o.db.prepare('DELETE FROM archivio_file WHERE chiave = ?').run(chiave);
      rispondi(res, 200, { ok: true });
    } else rispondi(res, 405, { errore: 'Metodo non ammesso.' });
    return true;
  }

  private async carica(chiave: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const dimensione = Number(req.headers['content-length']);
    const atteso = String(req.headers['x-sha256'] ?? '');
    if (!Number.isSafeInteger(dimensione) || dimensione < 0) return rispondi(res, 411, { errore: 'Dimensione del file mancante.' });
    if (dimensione > MAX_FILE) return rispondi(res, 413, { errore: 'File troppo grande per il server privato (massimo 2 GB).' });
    if (!/^[0-9a-f]{64}$/.test(atteso)) return rispondi(res, 400, { errore: 'Impronta del file mancante.' });

    // Spazio: conta il file che si sostituisce.
    const limite = await this.o.limite();
    const precedente = (this.o.db.prepare('SELECT dimensione FROM archivio_file WHERE chiave = ?').get(chiave) as { dimensione: number } | undefined)?.dimensione ?? 0;
    if (limite !== null && this.usati() - precedente + dimensione > limite) {
      return rispondi(res, 507, { errore: 'Spazio esaurito sul server privato: aumenta il limite dal CRM o togli documenti dalle pratiche.' });
    }

    const finale = this.percorso(chiave);
    const temporaneo = `${finale}.${randomBytes(6).toString('hex')}.parziale`;
    await mkdir(dirname(finale), { recursive: true, mode: 0o700 });
    const h = createHash('sha256');
    let ricevuti = 0;
    const conta = new Transform({
      transform(pezzo: Buffer, _enc, cb) {
        ricevuti += pezzo.length;
        if (ricevuti > dimensione) return cb(new Error('troppi byte'));
        h.update(pezzo);
        cb(null, pezzo);
      },
    });
    try {
      await pipeline(req, conta, createWriteStream(temporaneo, { mode: 0o600 }));
      if (ricevuti !== dimensione || h.digest('hex') !== atteso) throw new Error('file arrivato incompleto');
      await rename(temporaneo, finale);
    } catch {
      await rm(temporaneo, { force: true });
      if (!res.headersSent) rispondi(res, 400, { errore: 'Il file è arrivato incompleto: riprovo al prossimo giro.' });
      return;
    }
    this.o.db
      .prepare(
        `INSERT INTO archivio_file (chiave, dimensione, sha256, aggiornato_il) VALUES (?, ?, ?, ?)
         ON CONFLICT(chiave) DO UPDATE SET dimensione = excluded.dimensione, sha256 = excluded.sha256, aggiornato_il = excluded.aggiornato_il`,
      )
      .run(chiave, dimensione, atteso, (this.o.orologio ?? (() => new Date().toISOString()))());
    rispondi(res, 200, { ok: true });
  }
}
