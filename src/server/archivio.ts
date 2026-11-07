import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
// I file arrivano già cifrati dal desktop (src/core/cifraturaArchivio.ts):
// qui si controlla solo che lo siano e che siano arrivati interi.
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
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
//
// I telefoni collegati scaricano i file così come sono (cifrati: la chiave la
// ricevono dal computer dello studio, il server non la conosce) con un token
// di sola lettura per telefono. I token li registra e li toglie il desktop:
//   PUT    /sync/telefoni/<id>     { impronta }      (licenza)
//   POST   /sync/telefoni/attivi   { id: [...] }     (licenza) gli altri si tolgono
//   GET    /telefono/file/<chiave>                   (Bearer <id>.<token>)
// Il "pacchetto" dello studio (elenco delle pratiche, memorie, credenziali
// DeJure: src/shared/archivio.ts), cifrato come i file, arriva con
//   PUT    /sync/pacchetto                           (licenza)

export const MAX_FILE = 2 * 1024 ** 3;

export interface OpzioniArchivio {
  db: DatabaseSync;
  cartella: string;
  licenza: string;
  /** Byte disponibili; null = senza limite. */
  limite: () => Promise<number | null>;
  orologio?: () => string;
  /** Dopo ogni file caricato o tolto (per riferire lo stato al CRM). */
  onCambio?: () => void;
  /** Arrivato un pacchetto nuovo dal desktop. */
  onPacchetto?: () => void;
}

export function preparaDb(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS archivio_file (
    chiave TEXT PRIMARY KEY,
    dimensione INTEGER NOT NULL,
    impronta TEXT NOT NULL,
    aggiornato_il TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS archivio_telefono (
    id TEXT PRIMARY KEY,
    impronta TEXT NOT NULL,
    registrato_il TEXT NOT NULL
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

const ID_TELEFONO = /^[A-Za-z0-9_-]{16,64}$/;
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

async function leggiJson(req: IncomingMessage, massimo = 64 * 1024): Promise<unknown> {
  let testo = '';
  for await (const pezzo of req) {
    testo += pezzo;
    if (testo.length > massimo) throw new Error('richiesta troppo grande');
  }
  return JSON.parse(testo || '{}');
}

export class Archivio {
  constructor(private readonly o: OpzioniArchivio) {
    preparaDb(o.db);
  }

  /** Numero di file e data dell'ultimo caricamento. */
  riepilogo(): { file: number; ultimoCaricamento: string | null } {
    const r = this.o.db.prepare('SELECT COUNT(*) AS n, MAX(aggiornato_il) AS ultimo FROM archivio_file').get() as { n: number; ultimo: string | null };
    return { file: r.n, ultimoCaricamento: r.ultimo };
  }

  usati(): number {
    return (this.o.db.prepare('SELECT COALESCE(SUM(dimensione), 0) AS n FROM archivio_file').get() as { n: number }).n;
  }

  async elenco(): Promise<ElencoRemoto> {
    const file = this.o.db.prepare('SELECT chiave, dimensione, impronta FROM archivio_file ORDER BY chiave').all() as unknown as ElencoRemoto['file'];
    return { file, usati: this.usati(), limite: await this.o.limite() };
  }

  /** Dove sta il file di una chiave (per l'host del server, documento.leggi). */
  percorso(chiave: string): string {
    if (!FORMATO_CHIAVE.test(chiave)) throw new Error('chiave non valida');
    return join(this.o.cartella, chiave);
  }

  /** Dove sta il pacchetto dello studio (cifrato). */
  percorsoPacchetto(): string {
    return join(this.o.cartella, 'pacchetto.jra');
  }

  /** Riceve un contenuto cifrato (JRA1) e lo scrive per intero o per niente. */
  private async ricevi(req: IncomingMessage, res: ServerResponse, finale: string, massimo: number): Promise<void> {
    const temporaneo = `${finale}.${randomBytes(6).toString('hex')}.parziale`;
    let ricevuti = 0;
    let inizio = Buffer.alloc(0);
    const controlla = new Transform({
      transform(pezzo: Buffer, _enc, cb) {
        if (inizio.length < 4) {
          inizio = Buffer.concat([inizio, pezzo]).subarray(0, 4);
          if (inizio.length === 4 && inizio.toString('latin1') !== 'JRA1') return cb(new Error('non cifrato'));
        }
        ricevuti += pezzo.length;
        if (ricevuti > massimo) return cb(new Error('troppo grande'));
        cb(null, pezzo);
      },
    });
    try {
      await mkdir(dirname(finale), { recursive: true, mode: 0o700 });
      await pipeline(req, controlla, createWriteStream(temporaneo, { mode: 0o600 }));
      if (inizio.toString('latin1') !== 'JRA1') throw new Error('non cifrato');
      await rename(temporaneo, finale);
      this.o.onPacchetto?.();
      rispondi(res, 200, { ok: true });
    } catch {
      await rm(temporaneo, { force: true });
      if (!res.headersSent) rispondi(res, 400, { errore: 'Contenuto non valido.' });
    }
  }

  /** Il telefono di questo token, se registrato dal desktop. */
  private telefono(req: IncomingMessage): string | null {
    const m = /^Bearer ([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{32,128})$/.exec(req.headers.authorization ?? '');
    if (!m) return null;
    const riga = this.o.db.prepare('SELECT impronta FROM archivio_telefono WHERE id = ?').get(m[1]) as { impronta: string } | undefined;
    // Confronto a tempo costante (si confrontano impronte di uguale lunghezza).
    const atteso = Buffer.from(riga?.impronta ?? sha256hex('nessuno'), 'hex');
    const dato = Buffer.from(sha256hex(m[2]), 'hex');
    return timingSafeEqual(atteso, dato) && riga ? m[1] : null;
  }

  /** Gestisce /sync/* e /telefono/*; false se la richiesta non è dell'archivio. */
  async gestisci(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/telefono/')) {
      await this.perTelefono(url, req, res);
      return true;
    }
    if (!url.pathname.startsWith('/sync/')) return false;
    if (!autorizzato(req, this.o.licenza)) {
      rispondi(res, 401, { errore: 'Licenza non riconosciuta.' });
      return true;
    }
    if (url.pathname === '/sync/elenco' && req.method === 'GET') {
      rispondi(res, 200, await this.elenco());
      return true;
    }
    if (url.pathname === '/sync/pacchetto' && req.method === 'PUT') {
      await this.ricevi(req, res, this.percorsoPacchetto(), 50 * 1024 ** 2);
      return true;
    }
    if (url.pathname.startsWith('/sync/telefoni/')) {
      await this.gestisciTelefoni(url, req, res);
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
      this.o.onCambio?.();
      rispondi(res, 200, { ok: true });
    } else rispondi(res, 405, { errore: 'Metodo non ammesso.' });
    return true;
  }

  private async gestisciTelefoni(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let corpo: { impronta?: unknown; id?: unknown };
    try {
      corpo = (await leggiJson(req)) as typeof corpo;
    } catch {
      return rispondi(res, 400, { errore: 'Richiesta non valida.' });
    }
    if (url.pathname === '/sync/telefoni/attivi' && req.method === 'POST') {
      const attivi = Array.isArray(corpo.id) ? corpo.id.filter((x): x is string => typeof x === 'string' && ID_TELEFONO.test(x)) : null;
      if (!attivi) return rispondi(res, 400, { errore: 'Elenco dei telefoni mancante.' });
      const tutti = this.o.db.prepare('SELECT id FROM archivio_telefono').all() as Array<{ id: string }>;
      const tieni = new Set(attivi);
      let tolti = 0;
      for (const { id } of tutti) {
        if (!tieni.has(id)) {
          this.o.db.prepare('DELETE FROM archivio_telefono WHERE id = ?').run(id);
          tolti++;
        }
      }
      return rispondi(res, 200, { ok: true, tolti });
    }
    const id = decodeURIComponent(url.pathname.slice('/sync/telefoni/'.length));
    if (!ID_TELEFONO.test(id)) return rispondi(res, 404, { errore: 'Non trovato.' });
    if (req.method === 'PUT') {
      if (typeof corpo.impronta !== 'string' || !/^[0-9a-f]{64}$/.test(corpo.impronta)) return rispondi(res, 400, { errore: 'Impronta mancante.' });
      this.o.db
        .prepare(
          `INSERT INTO archivio_telefono (id, impronta, registrato_il) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET impronta = excluded.impronta, registrato_il = excluded.registrato_il`,
        )
        .run(id, corpo.impronta, (this.o.orologio ?? (() => new Date().toISOString()))());
      return rispondi(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      this.o.db.prepare('DELETE FROM archivio_telefono WHERE id = ?').run(id);
      return rispondi(res, 200, { ok: true });
    }
    rispondi(res, 405, { errore: 'Metodo non ammesso.' });
  }

  /** Il telefono scarica un file (cifrato) dell'archivio. Solo lettura. */
  private async perTelefono(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.telefono(req)) return rispondi(res, 401, { errore: 'Telefono non autorizzato: ricollegalo dal computer dello studio.' });
    const m = /^\/telefono\/file\/(.+)$/.exec(url.pathname);
    const chiave = m ? decodeURIComponent(m[1]) : '';
    if (!m || !FORMATO_CHIAVE.test(chiave)) return rispondi(res, 404, { errore: 'Non trovato.' });
    if (req.method !== 'GET') return rispondi(res, 405, { errore: 'Metodo non ammesso.' });
    const registrato = this.o.db.prepare('SELECT dimensione FROM archivio_file WHERE chiave = ?').get(chiave) as { dimensione: number } | undefined;
    const percorso = this.percorso(chiave);
    const info = registrato ? await stat(percorso).catch(() => null) : null;
    if (!registrato || !info) return rispondi(res, 404, { errore: 'Questo documento non è ancora sul server: il computer dello studio lo caricherà al prossimo giro.' });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': info.size, 'cache-control': 'no-store' });
    await pipeline(createReadStream(percorso), res).catch(() => res.destroy());
  }

  private async carica(chiave: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const dimensione = Number(req.headers['content-length']);
    const impronta = String(req.headers['x-impronta'] ?? '');
    if (!Number.isSafeInteger(dimensione) || dimensione < 0) return rispondi(res, 411, { errore: 'Dimensione del file mancante.' });
    if (dimensione > MAX_FILE) return rispondi(res, 413, { errore: 'File troppo grande per il server privato (massimo 2 GB).' });
    if (!/^[0-9a-f]{64}$/.test(impronta)) return rispondi(res, 400, { errore: 'Impronta del file mancante.' });

    // Spazio: conta il file che si sostituisce.
    const limite = await this.o.limite();
    const precedente = (this.o.db.prepare('SELECT dimensione FROM archivio_file WHERE chiave = ?').get(chiave) as { dimensione: number } | undefined)?.dimensione ?? 0;
    if (limite !== null && this.usati() - precedente + dimensione > limite) {
      return rispondi(res, 507, { errore: 'Spazio esaurito sul server privato: aumenta il limite dal CRM o togli documenti dalle pratiche.' });
    }

    const finale = this.percorso(chiave);
    const temporaneo = `${finale}.${randomBytes(6).toString('hex')}.parziale`;
    await mkdir(dirname(finale), { recursive: true, mode: 0o700 });
    let ricevuti = 0;
    let inizio = Buffer.alloc(0);
    const conta = new Transform({
      transform(pezzo: Buffer, _enc, cb) {
        // Un file in chiaro non deve mai finire sul server.
        if (inizio.length < 4) {
          inizio = Buffer.concat([inizio, pezzo]).subarray(0, 4);
          if (inizio.length === 4 && inizio.toString('latin1') !== 'JRA1') return cb(new Error('file non cifrato'));
        }
        ricevuti += pezzo.length;
        if (ricevuti > dimensione) return cb(new Error('troppi byte'));
        cb(null, pezzo);
      },
    });
    try {
      await pipeline(req, conta, createWriteStream(temporaneo, { mode: 0o600 }));
      if (ricevuti !== dimensione || inizio.toString('latin1') !== 'JRA1') throw new Error('file arrivato incompleto');
      await rename(temporaneo, finale);
    } catch {
      await rm(temporaneo, { force: true });
      if (!res.headersSent) rispondi(res, 400, { errore: 'Il file è arrivato incompleto: riprovo al prossimo giro.' });
      return;
    }
    this.o.db
      .prepare(
        `INSERT INTO archivio_file (chiave, dimensione, impronta, aggiornato_il) VALUES (?, ?, ?, ?)
         ON CONFLICT(chiave) DO UPDATE SET dimensione = excluded.dimensione, impronta = excluded.impronta, aggiornato_il = excluded.aggiornato_il`,
      )
      .run(chiave, dimensione, impronta, (this.o.orologio ?? (() => new Date().toISOString()))());
    this.o.onCambio?.();
    rispondi(res, 200, { ok: true });
  }
}
