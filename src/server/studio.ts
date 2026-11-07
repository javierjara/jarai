import { readFile, readdir, rm, rename, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cifraTutto } from '../core/cifraturaArchivio';
import { apriDatabase, inTransazione, type Database } from '../core/db';
import { EventStore } from '../core/eventStore';
import { Host, type Motore } from '../core/host';
import { migraResto } from '../core/migrazioneJson';
import { chiaveTesto, decifraArchivio, type PacchettoStudio } from '../shared/archivio';
import type { Evento } from '../shared/protocollo';
import { messaggiVisibili } from '../shared/reducer';
import type { FontiStudio } from './strumenti';

// Lo "studio" sul server privato, per l'assistente di riserva.
//
// Il server non conosce la chiave dello studio. Gliela dà un dispositivo
// collegato (telefono) quando si collega: la si tiene solo in memoria, per il
// tempo in cui serve, poi si dimentica insieme a tutto quello che ne deriva
// (host, testi decifrati). Con la chiave:
// - si legge il pacchetto (pratiche, documenti, memorie) e si costruisce un
//   host come quello del desktop, su un database in memoria;
// - le conversazioni nate qui si salvano cifrate, una per file
//   (conversazioni/<id>.jra), finché il computer dello studio non le importa;
// - i testi dei documenti si decifrano quando l'assistente li legge.
//
// I numeri di sequenza degli eventi non si riusano mai (stato.json, non
// segreto): un telefono che ha già visto il 40 non perde il 41 dopo un riavvio.

export class ErroreStudio extends Error {}

export interface OpzioniStudio {
  /** Cartella dell'archivio: file cifrati, testi, pacchetto. */
  cartellaPratiche: string;
  /** Cartella dati del server: conversazioni cifrate, stato. */
  cartellaDati: string;
  creaMotore: (contesto: ContestoMotore) => Motore;
  /** Dopo quanto tempo senza dispositivi collegati né risposte in corso si dimentica la chiave. */
  dimenticaDopoMs?: number;
  orologio?: () => string;
  registraErrore?: (contesto: string, dettaglio: string) => void;
  /** Dimenticata la chiave: si cancellano anche le sessioni di Claude (in RAM). */
  onDimentica?: () => void;
}

export interface ContestoMotore {
  fonti: (praticaId: string | null, documenti: Array<{ id: string; nome: string; cartella: string }>) => FontiStudio;
  storia: (conversazioneId: string) => ReturnType<typeof messaggiVisibili>;
}

interface Aperto {
  chiave: Uint8Array;
  host: Host;
  db: Database;
  pacchetto: PacchettoStudio;
  /** Conversazioni da riscrivere su disco. */
  daSalvare: Set<string>;
}

const ID = /^[A-Za-z0-9_-]{1,80}$/;

export class StudioServer {
  private aperto: Aperto | null = null;
  private apertura: Promise<Aperto> | null = null;
  private collegati = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private salvataggio: Promise<void> = Promise.resolve();

  constructor(private readonly o: OpzioniStudio) {}

  private get cartellaConversazioni(): string {
    return join(this.o.cartellaDati, 'conversazioni');
  }

  /** Un dispositivo si collega con la chiave: l'host è pronto (o la chiave è sbagliata). */
  async apri(chiave: Uint8Array): Promise<Host> {
    if (this.aperto) {
      if (!uguali(this.aperto.chiave, chiave)) throw new ErroreStudio('Chiave dello studio non valida.');
      return this.aperto.host;
    }
    this.apertura ??= this.costruisci(chiave).finally(() => {
      this.apertura = null;
    });
    const a = await this.apertura;
    if (!uguali(a.chiave, chiave)) throw new ErroreStudio('Chiave dello studio non valida.');
    return a.host;
  }

  /** Conta i dispositivi collegati: senza nessuno, dopo un po' si dimentica tutto. */
  entra(): void {
    this.collegati++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  esce(): void {
    this.collegati = Math.max(0, this.collegati - 1);
    this.programmaOblio();
  }

  get attivo(): boolean {
    return !!this.aperto;
  }

  private programmaOblio(): void {
    if (this.collegati > 0 || !this.aperto) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.dimentica(), this.o.dimenticaDopoMs ?? 10 * 60_000);
  }

  /** Salva quello che c'è da salvare e dimentica chiave, host e testi. */
  async dimentica(forza = false): Promise<boolean> {
    const a = this.aperto;
    if (!a) return true;
    if (!forza && (this.collegati > 0 || a.host.haTurniAperti())) {
      this.programmaOblio();
      return false;
    }
    await this.salva();
    a.chiave.fill(0);
    this.aperto = null;
    this.o.onDimentica?.();
    return true;
  }

  // ─── Conversazioni per il computer dello studio (import) ────────────────

  async conversazioniSalvate(): Promise<Array<{ id: string; dimensione: number; aggiornataIl: string; inCorso: boolean }>> {
    await this.salvataggio;
    const nomi = await readdir(this.cartellaConversazioni).catch(() => [] as string[]);
    const risultato = [];
    for (const nome of nomi) {
      if (!nome.endsWith('.jra')) continue;
      const id = nome.slice(0, -4);
      const s = await stat(join(this.cartellaConversazioni, nome)).catch(() => null);
      if (!s) continue;
      const inCorso = !!this.aperto && !!this.aperto.host.conversazione(id)?.turno;
      risultato.push({ id, dimensione: s.size, aggiornataIl: s.mtime.toISOString(), inCorso });
    }
    return risultato;
  }

  /** Il file cifrato di una conversazione, così com'è: il computer lo decifra da sé. */
  async leggiConversazione(id: string): Promise<Buffer | null> {
    if (!ID.test(id)) return null;
    await this.salvataggio;
    return readFile(join(this.cartellaConversazioni, `${id}.jra`)).catch(() => null);
  }

  /** Importata dal computer: si toglie da qui (e dall'host in memoria, se c'è). */
  async eliminaConversazione(id: string): Promise<void> {
    if (!ID.test(id)) return;
    await rm(join(this.cartellaConversazioni, `${id}.jra`), { force: true });
    const a = this.aperto;
    if (a) {
      a.daSalvare.delete(id);
      // L'host si ricostruisce senza: si dimentica appena possibile.
      if (!a.host.haTurniAperti() && this.collegati === 0) await this.dimentica(true);
    }
  }

  // ─── Interni ───────────────────────────────────────────────────────────

  private async costruisci(ricevuta: Uint8Array): Promise<Aperto> {
    // Copia propria: chi la passa può azzerare la sua appena apri() ritorna.
    const chiave = Uint8Array.from(ricevuta);
    let pacchetto: PacchettoStudio;
    try {
      const cifrato = await readFile(join(this.o.cartellaPratiche, 'pacchetto.jra'));
      pacchetto = JSON.parse(Buffer.from(decifraArchivio(chiave, cifrato)).toString('utf8')) as PacchettoStudio;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ErroreStudio('Il computer dello studio non ha ancora preparato il server: accendilo una volta con il server privato attivo.');
      }
      throw new ErroreStudio('Chiave dello studio non valida.');
    }

    const db = apriDatabase(':memory:');
    const ora = (this.o.orologio ?? (() => new Date().toISOString()))();
    migraResto(db, {
      pratiche: pacchetto.pratiche.map((p) => ({ ...p, documenti: pacchetto.documenti[p.id]?.length ?? 0, aggiornataIl: ora, cartellaPercorso: null })),
      documenti: pacchetto.documenti,
      studio: pacchetto.studio ?? undefined,
    });
    await this.ripristina(db, chiave);

    const daSalvare = new Set<string>();
    let host!: Host;
    const contesto: ContestoMotore = {
      fonti: (praticaId, documenti) => ({
        documenti: documenti as FontiStudio['documenti'],
        memoria: praticaId ? (pacchetto.memorie[praticaId] ?? null) : null,
        testo: async (documentoId) => (praticaId ? this.testo(chiave, praticaId, documentoId) : null),
      }),
      storia: (id) => {
        const c = host.conversazione(id);
        return c ? messaggiVisibili(c) : [];
      },
    };
    host = new Host(db, this.o.creaMotore(contesto), { orologio: this.o.orologio, registraErrore: this.o.registraErrore });
    const aperto: Aperto = { chiave, host, db, pacchetto, daSalvare };
    host.abbona((e) => {
      if (e.seq === null || !e.conversazioneId) return;
      daSalvare.add(e.conversazioneId);
      this.salva();
    });
    this.aperto = aperto;
    this.programmaOblio();
    return aperto;
  }

  /** Testo estratto di un documento, decifrato in memoria. */
  private async testo(chiave: Uint8Array, praticaId: string, documentoId: string): Promise<string | null> {
    try {
      const cifrato = await readFile(join(this.o.cartellaPratiche, chiaveTesto(praticaId, documentoId)));
      return (JSON.parse(Buffer.from(decifraArchivio(chiave, cifrato)).toString('utf8')) as { testo: string }).testo;
    } catch {
      return null;
    }
  }

  /** Le conversazioni salvate tornano nel database in memoria, con i loro seq. */
  private async ripristina(db: Database, chiave: Uint8Array): Promise<void> {
    const nomi = await readdir(this.cartellaConversazioni).catch(() => [] as string[]);
    const tutti: Evento[] = [];
    for (const nome of nomi) {
      if (!nome.endsWith('.jra')) continue;
      try {
        const { eventi } = JSON.parse(Buffer.from(decifraArchivio(chiave, await readFile(join(this.cartellaConversazioni, nome)))).toString('utf8')) as {
          eventi: Evento[];
        };
        tutti.push(...eventi);
      } catch (err) {
        this.o.registraErrore?.('ripristino', `${nome}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    tutti.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const stato = await this.leggiStato();
    inTransazione(db, () => {
      const evento = db.prepare(
        'INSERT INTO evento (seq, conversazione_id, tipo, payload, utente_id, dispositivo_id, creato_il) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      const conversazione = db.prepare('INSERT OR IGNORE INTO conversazione (id, modalita, pratica_id, creata_il) VALUES (?, ?, ?, ?)');
      for (const e of tutti) {
        evento.run(e.seq, e.conversazioneId, e.tipo, JSON.stringify(e.payload), e.utenteId ?? null, e.dispositivoId ?? null, e.creatoIl);
        if (e.tipo === 'conversazione_creata') {
          const p = e.payload as { modalita: string; praticaId: string | null };
          conversazione.run(e.conversazioneId, p.modalita, p.praticaId, e.creatoIl);
        }
      }
      // Mai sotto un seq già usato (anche di conversazioni importate e tolte).
      const massimo = Math.max(stato.ultimoSeq, tutti.at(-1)?.seq ?? 0);
      db.prepare("DELETE FROM sqlite_sequence WHERE name = 'evento'").run();
      db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('evento', ?)").run(massimo);
    });
  }

  private async leggiStato(): Promise<{ ultimoSeq: number }> {
    try {
      return JSON.parse(await readFile(join(this.o.cartellaDati, 'stato.json'), 'utf8')) as { ultimoSeq: number };
    } catch {
      return { ultimoSeq: 0 };
    }
  }

  /** Riscrive (cifrate) le conversazioni cambiate. Una scrittura alla volta. */
  salva(): Promise<void> {
    this.salvataggio = this.salvataggio.then(async () => {
      const a = this.aperto;
      if (!a || a.daSalvare.size === 0) return;
      const ids = [...a.daSalvare];
      a.daSalvare.clear();
      await mkdir(this.cartellaConversazioni, { recursive: true, mode: 0o700 });
      const store = new EventStore(a.db);
      for (const id of ids) {
        const eventi = store.perConversazione(id);
        const finale = join(this.cartellaConversazioni, `${id}.jra`);
        const tmp = `${finale}.parziale`;
        await writeFile(tmp, await cifraTutto(a.chiave, Buffer.from(JSON.stringify({ id, eventi }))), { mode: 0o600 });
        await rename(tmp, finale);
      }
      await writeFile(join(this.o.cartellaDati, 'stato.json'), JSON.stringify({ ultimoSeq: store.ultimoSeq() }));
    }).catch((err) => this.o.registraErrore?.('salvataggio', err instanceof Error ? err.message : String(err)));
    return this.salvataggio;
  }
}

function uguali(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
