import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { cifra, dimensioneCifrata, improntaOpaca } from './cifraturaArchivio';
import type { Database } from './db';
import type { ElencoRemoto, StatoSincronizzazione } from '../shared/serverPrivato';

// Server privato (JarAI Server): il desktop copia sul server i file dei
// documenti delle pratiche. Il server è uno specchio: un documento tolto in
// studio sparisce anche dal server, il server non tocca mai il desktop.
//
// Ogni file sul server ha una chiave che non rivela nomi di clienti o di
// pratiche (impronta degli id): la stessa funzione serve al desktop per
// caricare e al server per ritrovare il file quando il telefono lo chiede.

// La chiave di un file sul server (impronta degli id + estensione) è la stessa
// sul desktop, sul server e sul telefono: src/shared/archivio.ts.
export { chiaveFile, FORMATO_CHIAVE } from '../shared/archivio';
import { chiaveFile, chiaveTesto, type PacchettoStudio } from '../shared/archivio';
import { leggiEntita } from './entita';

export type { ElencoRemoto, FileRemoto, StatoSincronizzazione } from '../shared/serverPrivato';

interface FileLocale {
  chiave: string;
  percorso: string;
}

/**
 * I testi già estratti dal computer (indice dei testi), accanto ai file:
 * l'assistente di riserva sul server li legge senza rifare OCR e conversioni.
 * percorsoTesto dà il file dell'indice per un documento, null se non ancora letto.
 */
export async function testiDaSincronizzare(
  db: Database,
  percorsoTesto: (percorsoFile: string, nome: string) => Promise<string | null>,
): Promise<FileLocale[]> {
  const righe = db
    .prepare(
      `SELECT d.pratica_id AS praticaId, d.id AS documentoId, d.percorso AS percorso, d.nome AS nome
       FROM documento d JOIN pratica p ON p.id = d.pratica_id
       WHERE p.eliminata_il IS NULL AND d.percorso IS NOT NULL AND d.percorso <> ''`,
    )
    .all() as Array<{ praticaId: string; documentoId: string; percorso: string; nome: string }>;
  const file: FileLocale[] = [];
  for (const r of righe) {
    const testo = await percorsoTesto(r.percorso, r.nome).catch(() => null);
    if (testo) file.push({ chiave: chiaveTesto(r.praticaId, r.documentoId), percorso: testo });
  }
  return file;
}

/** Il pacchetto dello studio per il server privato (src/shared/archivio.ts). */
export function costruisciPacchetto(
  db: Database,
  extra: { memorie: Record<string, unknown>; dejure: PacchettoStudio['dejure']; ora: string },
): PacchettoStudio {
  const e = leggiEntita(db, () => null);
  return {
    v: 1,
    creatoIl: extra.ora,
    studio: e?.studio ?? null,
    pratiche: (e?.pratiche ?? []).map(({ id, nome, cliente, controparte, ambito, note }) => ({ id, nome, cliente, controparte, ambito, note })),
    documenti: Object.fromEntries(
      Object.entries(e?.documenti ?? {}).map(([pid, docs]) => [
        pid,
        docs.map(({ id, nome, tipo, cartella, pagine, data, percorso }) => ({ id, nome, tipo, cartella, pagine, data, percorso })),
      ]),
    ),
    memorie: extra.memorie,
    dejure: extra.dejure,
  };
}

/** I file da tenere sul server: i documenti con un file, delle pratiche non eliminate. */
export function fileDaSincronizzare(db: Database): FileLocale[] {
  const righe = db
    .prepare(
      `SELECT d.pratica_id AS praticaId, d.id AS documentoId, d.percorso AS percorso
       FROM documento d JOIN pratica p ON p.id = d.pratica_id
       WHERE p.eliminata_il IS NULL AND d.percorso IS NOT NULL AND d.percorso <> ''`,
    )
    .all() as Array<{ praticaId: string; documentoId: string; percorso: string }>;
  const visti = new Set<string>();
  const file: FileLocale[] = [];
  for (const r of righe) {
    const chiave = chiaveFile(r.praticaId, r.documentoId, r.percorso);
    if (visti.has(chiave)) continue;
    visti.add(chiave);
    file.push({ chiave, percorso: r.percorso });
  }
  return file;
}

async function impronta(percorso: string): Promise<string> {
  const h = createHash('sha256');
  for await (const pezzo of createReadStream(percorso)) h.update(pezzo as Buffer);
  return h.digest('hex');
}

export class ErroreServer extends Error {
  constructor(
    message: string,
    readonly stato?: number,
  ) {
    super(message);
  }
}

/** Le chiamate al server, con la licenza dello studio come credenziale. */
export class ClienteArchivio {
  constructor(
    private readonly url: string,
    private readonly licenza: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async chiama(percorso: string, init: RequestInit = {}): Promise<Response> {
    let r: Response;
    try {
      r = await this.fetchFn(`${this.url.replace(/\/$/, '')}${percorso}`, {
        ...init,
        headers: { authorization: `Bearer ${this.licenza}`, ...(init.headers ?? {}) },
      });
    } catch {
      throw new ErroreServer('Il server privato non risponde: controlla la connessione a internet.');
    }
    if (r.ok) return r;
    const testo = await r.text().catch(() => '');
    let messaggio = testo;
    try {
      messaggio = (JSON.parse(testo) as { errore?: string }).errore ?? testo;
    } catch {
      // risposta non JSON
    }
    if (r.status === 401) throw new ErroreServer('Il server privato non riconosce la licenza di questo studio.', 401);
    if (r.status === 507) throw new ErroreServer(messaggio || 'Spazio esaurito sul server privato.', 507);
    throw new ErroreServer(messaggio || `Il server privato ha risposto con un errore (${r.status}).`, r.status);
  }

  async elenco(): Promise<ElencoRemoto> {
    return (await this.chiama('/sync/elenco')).json() as Promise<ElencoRemoto>;
  }

  /** Carica il file cifrato con la chiave dello studio: il server non lo può leggere. */
  async carica(chiave: string, percorso: string, impronta: string, dimensione: number, chiaveStudio: Uint8Array): Promise<void> {
    await this.chiama(`/sync/file/${chiave}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(dimensioneCifrata(dimensione)),
        'x-impronta': impronta,
      },
      body: Readable.toWeb(createReadStream(percorso).pipe(cifra(chiaveStudio))) as ReadableStream,
      // Node vuole duplex per i corpi in streaming.
      ...({ duplex: 'half' } as object),
    });
  }

  /** Il pacchetto dello studio (elenco, memorie…), già cifrato con la chiave dello studio. */
  async caricaPacchetto(cifrato: Uint8Array): Promise<void> {
    await this.chiama('/sync/pacchetto', {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: cifrato as unknown as BodyInit,
    });
  }

  async elimina(chiave: string): Promise<void> {
    await this.chiama(`/sync/file/${chiave}`, { method: 'DELETE' });
  }

  /** Un telefono collegato potrà scaricare i file (cifrati) con questo token. */
  async registraTelefono(id: string, token: string): Promise<void> {
    await this.chiama(`/sync/telefoni/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ impronta: createHash('sha256').update(token).digest('hex') }),
    });
  }

  async revocaTelefono(id: string): Promise<void> {
    await this.chiama(`/sync/telefoni/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /** I telefoni ancora collegati: il server toglie gli altri (revoche fatte mentre era irraggiungibile). */
  async telefoniAttivi(id: string[]): Promise<void> {
    await this.chiama('/sync/telefoni/attivi', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  }
}

interface OpzioniSincronizzatore {
  cliente: ClienteArchivio;
  /** Chiave dello studio (32 byte): resta su questo computer. */
  chiave: Uint8Array;
  locali: () => FileLocale[] | Promise<FileLocale[]>;
  onStato: (stato: StatoSincronizzazione) => void;
  orologio?: () => string;
  registraErrore?: (contesto: string, dettaglio: string) => void;
}

/**
 * Un giro di sincronizzazione: elenco remoto, poi carica i file nuovi o
 * cambiati e cancella quelli che in studio non ci sono più. Un file che
 * manca sul desktop (spostato) non blocca gli altri: si conta tra i mancanti.
 */
export class Sincronizzatore {
  private ultimaRiuscita: string | null = null;
  private inCorso: Promise<void> | null = null;
  private ancora = false;
  // Impronte già calcolate: si ricalcolano solo se cambiano dimensione o data.
  private readonly impronte = new Map<string, { dimensione: number; modificato: number; sha256: string }>();
  stato: StatoSincronizzazione = { tipo: 'in_attesa' };

  constructor(private readonly o: OpzioniSincronizzatore) {}

  /** Avvia un giro; se uno è già in corso, ne fa un altro appena finisce. */
  sincronizza(): Promise<void> {
    if (this.inCorso) {
      this.ancora = true;
      return this.inCorso;
    }
    this.inCorso = (async () => {
      do {
        this.ancora = false;
        await this.giro();
      } while (this.ancora);
    })().finally(() => {
      this.inCorso = null;
    });
    return this.inCorso;
  }

  private imposta(s: StatoSincronizzazione): void {
    this.stato = s;
    this.o.onStato(s);
  }

  private ora(): string {
    return (this.o.orologio ?? (() => new Date().toISOString()))();
  }

  private async giro(): Promise<void> {
    let remoto: ElencoRemoto | null = null;
    try {
      remoto = await this.o.cliente.elenco();
      const remoti = new Map(remoto.file.map((f) => [f.chiave, f]));
      const locali = await this.o.locali();

      // Cosa cambia: impronte dei file locali (solo dei modificati).
      let mancanti = 0;
      const daCaricare: Array<{ chiave: string; percorso: string; impronta: string; dimensione: number }> = [];
      for (const l of locali) {
        let info;
        try {
          info = await stat(l.percorso);
        } catch {
          mancanti++;
          continue;
        }
        const nota = this.impronte.get(l.percorso);
        const sha256 =
          nota && nota.dimensione === info.size && nota.modificato === info.mtimeMs ? nota.sha256 : await impronta(l.percorso).catch(() => null);
        if (!sha256) {
          mancanti++;
          continue;
        }
        this.impronte.set(l.percorso, { dimensione: info.size, modificato: info.mtimeMs, sha256 });
        const r = remoti.get(l.chiave);
        const opaca = improntaOpaca(this.o.chiave, sha256);
        if (!r || r.impronta !== opaca) daCaricare.push({ chiave: l.chiave, percorso: l.percorso, impronta: opaca, dimensione: info.size });
      }
      const chiaviLocali = new Set(locali.map((l) => l.chiave));
      const daEliminare = remoto.file.filter((f) => !chiaviLocali.has(f.chiave));

      // Prima si libera spazio, poi si carica.
      for (const f of daEliminare) await this.o.cliente.elimina(f.chiave);

      const byteTotali = daCaricare.reduce((s, f) => s + f.dimensione, 0);
      let byteFatti = 0;
      for (let i = 0; i < daCaricare.length; i++) {
        this.imposta({ tipo: 'in_corso', fatti: i, totale: daCaricare.length, byteFatti, byteTotali });
        const f = daCaricare[i];
        await this.o.cliente.carica(f.chiave, f.percorso, f.impronta, f.dimensione, this.o.chiave);
        byteFatti += f.dimensione;
      }

      const finale = daCaricare.length || daEliminare.length ? await this.o.cliente.elenco() : remoto;
      this.ultimaRiuscita = this.ora();
      this.imposta({
        tipo: 'sincronizzata',
        quando: this.ultimaRiuscita,
        file: finale.file.length,
        usati: finale.usati,
        limite: finale.limite,
        mancanti,
      });
    } catch (err) {
      const messaggio = err instanceof Error ? err.message : String(err);
      if (!(err instanceof ErroreServer)) this.o.registraErrore?.('sincronizzazione', messaggio);
      this.imposta({
        tipo: 'errore',
        messaggio: err instanceof ErroreServer ? messaggio : 'La sincronizzazione si è interrotta: riprovo tra poco.',
        quando: this.ora(),
        ultimaRiuscita: this.ultimaRiuscita,
        ...(remoto ? { usati: remoto.usati, limite: remoto.limite } : {}),
      });
    }
  }
}
