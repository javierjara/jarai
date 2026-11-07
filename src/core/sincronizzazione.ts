import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import type { Database } from './db';
import type { ElencoRemoto, StatoSincronizzazione } from '../shared/serverPrivato';

// Server privato (JarAI Server): il desktop copia sul server i file dei
// documenti delle pratiche. Il server è uno specchio: un documento tolto in
// studio sparisce anche dal server, il server non tocca mai il desktop.
//
// Ogni file sul server ha una chiave che non rivela nomi di clienti o di
// pratiche (impronta degli id): la stessa funzione serve al desktop per
// caricare e al server per ritrovare il file quando il telefono lo chiede.

/** "a1b2…/c3d4….pdf": impronta di pratica e documento, più l'estensione vera. */
export function chiaveFile(praticaId: string, documentoId: string, percorso: string): string {
  const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);
  const ext = extname(percorso).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  return `${h(`pratica:${praticaId}`)}/${h(`documento:${praticaId}/${documentoId}`)}${ext}`;
}

export const FORMATO_CHIAVE = /^[0-9a-f]{24}\/[0-9a-f]{24}(\.[a-z0-9]{1,7})?$/;

export type { ElencoRemoto, FileRemoto, StatoSincronizzazione } from '../shared/serverPrivato';

interface FileLocale {
  chiave: string;
  percorso: string;
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

  async carica(chiave: string, percorso: string, sha256: string, dimensione: number): Promise<void> {
    await this.chiama(`/sync/file/${chiave}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(dimensione), 'x-sha256': sha256 },
      body: Readable.toWeb(createReadStream(percorso)) as ReadableStream,
      // Node vuole duplex per i corpi in streaming.
      ...({ duplex: 'half' } as object),
    });
  }

  async elimina(chiave: string): Promise<void> {
    await this.chiama(`/sync/file/${chiave}`, { method: 'DELETE' });
  }
}

interface OpzioniSincronizzatore {
  cliente: ClienteArchivio;
  locali: () => FileLocale[];
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
      const locali = this.o.locali();

      // Cosa cambia: impronte dei file locali (solo dei modificati).
      let mancanti = 0;
      const daCaricare: Array<{ chiave: string; percorso: string; sha256: string; dimensione: number }> = [];
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
        if (!r || r.sha256 !== sha256) daCaricare.push({ chiave: l.chiave, percorso: l.percorso, sha256, dimensione: info.size });
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
        await this.o.cliente.carica(f.chiave, f.percorso, f.sha256, f.dimensione);
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
