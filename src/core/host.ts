import { open, type FileHandle } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  bustaSchema,
  VERSIONE_PROTOCOLLO,
  type Articolo,
  type Busta,
  type Comando,
  type Documento,
  type EsitoComando,
  type FileEsportato,
  type FormatoBozza,
  type Evento,
  type IdeaProposta,
  type LavoroDocumento,
  type Modalita,
  type PezzoDocumento,
  type Qualita,
  type Richiesta,
} from '../shared/protocollo';
import {
  ELENCO_VUOTO,
  ricostruisciConversazione,
  riduciConversazione,
  riduciElenco,
  type ProiezioneConversazione,
  type ProiezioneElenco,
} from '../shared/reducer';
import { inTransazione, type Database } from './db';
import {
  documentiPratica,
  eliminaDatiConversazioneSito,
  eliminaPratica,
  leggiEntita,
  salvaDatiConversazioneSito,
  salvaDocumenti,
  salvaIdee,
  salvaImpostazione,
  salvaPratica,
} from './entita';
import { EventStore, type EventoNuovo } from './eventStore';
import { MIGRAZIONE_RESTO, migrazioneFatta } from './migrazioneJson';

/**
 * Byte per pezzo di documento.leggi: in base64 e cifrato resta sotto i
 * 512 KB per messaggio, comodo per il relay anche su reti lente.
 */
export const PEZZO_DOCUMENTO = 384 * 1024;

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
  '.rtf': 'application/rtf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.eml': 'message/rfc822',
  '.msg': 'application/vnd.ms-outlook',
  '.p7m': 'application/pkcs7-mime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
};

function mimeDi(percorso: string): string {
  return MIME[extname(percorso).toLowerCase()] ?? 'application/octet-stream';
}

// Host (docs/eventstore-protocollo.md §2): l'unico che scrive lo stato delle
// conversazioni. Riceve comandi da qualsiasi client (finestra Electron oggi,
// telefono e desktop remoto domani), li trasforma in eventi nel log e li
// inoltra agli abbonati. Non sa niente di Electron: l'agente Claude gli
// arriva da fuori come Motore, e il trasporto (IPC, WebSocket) chiama
// gestisciBusta e abbona.

// ─── Il motore che risponde (oggi src/main/agentRunner.ts) ───────────────

export type EventoMotore =
  | { tipo: 'delta'; testo: string }
  | { tipo: 'attivita'; testo: string }
  | { tipo: 'lavori'; lavori: LavoroDocumento[] }
  | { tipo: 'bozza'; titolo: string; contenuto: string }
  | { tipo: 'articolo'; articolo: Articolo }
  | { tipo: 'idee'; idee: IdeaProposta[] }
  | { tipo: 'sessione'; sessionId: string }
  | { tipo: 'completato'; testo: string; costoUsd?: number }
  /**
   * messaggio: solo il motivo, in italiano, senza il testo parziale.
   * scartaParziale: quello arrivato in streaming non era una risposta (es.
   * l'errore grezzo del CLI "Not logged in"): non va mostrato.
   */
  | { tipo: 'errore'; messaggio: string; scartaParziale?: boolean };

export interface RichiestaMotore {
  conversazioneId: string;
  modalita: Modalita;
  testo: string;
  qualita: Qualita;
  praticaId: string | null;
  /** Documenti della pratica, da jarai.db (vuoto prima della migrazione: il motore può cercarli altrove). */
  documenti: Documento[];
  /** Sessione dell'SDK da riprendere: c'è anche dopo un riavvio. */
  resume?: string;
}

export interface Motore {
  esegui(richiesta: RichiestaMotore, emetti: (evento: EventoMotore) => void): Promise<void>;
  ferma(conversazioneId: string): void;
}

// ─── Host ────────────────────────────────────────────────────────────────

export interface OpzioniHost {
  orologio?: () => string;
  nuovoId?: () => string;
  /** Per gli errori interni: mai contenuto delle pratiche, solo il motivo tecnico. */
  registraErrore?: (contesto: string, dettaglio: string) => void;
  /** Word/PDF di una bozza (sul desktop: docx e stampa di Chromium). */
  esportaBozza?: (bozza: { titolo: string; contenuto: string }, formato: FormatoBozza) => Promise<Uint8Array>;
  /**
   * Dove sta davvero il file di un documento. Sul desktop è il percorso
   * registrato; su JarAI Server le cartelle delle pratiche sono altrove
   * (es. /pratiche) e il server lo traduce.
   */
  risolviPercorso?: (percorso: string) => string;
}

export interface Origine {
  dispositivoId?: string;
  utenteId?: string;
}

interface TurnoAttivo {
  turnoId: string;
  parziale: string;
  numeroBozza: number;
  fermato: boolean;
  chiuso: boolean;
}

export const MESSAGGI = {
  occupata: "L'assistente sta ancora rispondendo in questa conversazione: aspetta la fine o fermalo.",
  nonTrovata: 'Questa conversazione non esiste più.',
  confermaScaduta: 'Questa richiesta di conferma non è più valida.',
  senzaEsito: 'La risposta si è interrotta senza un esito. Riprova.',
  chiusuraApp: 'Risposta interrotta: JarAI è stato chiuso prima della fine.',
  erroreInterno: 'Si è verificato un problema interno. Riprova.',
  praticaNonTrovata: 'Questa pratica non esiste più.',
  datiNonPronti: 'I dati dello studio non sono ancora pronti: riavvia JarAI.',
} as const;

export class Host {
  private readonly store: EventStore;
  private readonly orologio: () => string;
  private readonly nuovoId: () => string;
  private readonly registraErrore: (contesto: string, dettaglio: string) => void;
  private readonly esportaBozza: OpzioniHost['esportaBozza'];
  private readonly risolviPercorso: (percorso: string) => string;
  private elenco: ProiezioneElenco = ELENCO_VUOTO;
  private readonly cache = new Map<string, ProiezioneConversazione>();
  private readonly abbonati = new Set<(evento: Evento) => void>();
  private readonly turni = new Map<string, TurnoAttivo>();

  constructor(
    private readonly db: Database,
    private readonly motore: Motore,
    opzioni: OpzioniHost = {},
  ) {
    this.orologio = opzioni.orologio ?? (() => new Date().toISOString());
    this.nuovoId = opzioni.nuovoId ?? (() => crypto.randomUUID());
    this.registraErrore = opzioni.registraErrore ?? (() => undefined);
    this.esportaBozza = opzioni.esportaBozza;
    this.risolviPercorso = opzioni.risolviPercorso ?? ((p) => p);
    this.store = new EventStore(db, this.orologio);

    for (let seq = 0; ; ) {
      const pagina = this.store.dopo(seq, 5000);
      if (pagina.length === 0) break;
      for (const e of pagina) this.elenco = riduciElenco(this.elenco, e);
      seq = pagina[pagina.length - 1].seq!;
    }
    this.chiudiTurniRimasti();
  }

  // ─── Trasporto ─────────────────────────────────────────────────────────

  /** Punto d'ingresso unico per ogni trasporto: valida, esegue, risponde. */
  async gestisciBusta(input: unknown, origine: Origine = {}): Promise<Busta> {
    const parsed = bustaSchema.safeParse(input);
    const id = typeof input === 'object' && input && 'id' in input ? String((input as { id: unknown }).id) : '';
    if (!parsed.success) {
      return { v: VERSIONE_PROTOCOLLO, tipo: 'risposta', id, esito: { ok: false, errore: 'Richiesta non valida.' } };
    }
    const busta = parsed.data;
    if (busta.tipo === 'comando') {
      return { v: VERSIONE_PROTOCOLLO, tipo: 'risposta', id: busta.id, esito: await this.esegui(busta.comando, origine) };
    }
    if (busta.tipo === 'richiesta' && busta.richiesta.tipo === 'bozza.esporta') {
      return { v: VERSIONE_PROTOCOLLO, tipo: 'risposta', id: busta.id, esito: await this.esporta(busta.richiesta) };
    }
    if (busta.tipo === 'richiesta' && busta.richiesta.tipo === 'documento.leggi') {
      return { v: VERSIONE_PROTOCOLLO, tipo: 'risposta', id: busta.id, esito: await this.leggiDocumento(busta.richiesta) };
    }
    if (busta.tipo === 'richiesta') {
      return { v: VERSIONE_PROTOCOLLO, tipo: 'risposta', id: busta.id, esito: { ok: true, dati: this.richiedi(busta.richiesta) } };
    }
    // Risposte ed eventi vanno dall'host ai client, non viceversa.
    return { v: VERSIONE_PROTOCOLLO, tipo: 'risposta', id, esito: { ok: false, errore: 'Richiesta non valida.' } };
  }

  /** Ogni evento, persistito o transitorio, appena accade. */
  abbona(fn: (evento: Evento) => void): () => void {
    this.abbonati.add(fn);
    return () => this.abbonati.delete(fn);
  }

  // ─── Letture ───────────────────────────────────────────────────────────

  richiedi(r: Richiesta): unknown {
    switch (r.tipo) {
      case 'snapshot.entita':
        return { entita: leggiEntita(this.db, (id) => this.conversazione(id)) };
      case 'snapshot.elenco':
        return { elenco: this.elenco };
      case 'snapshot.conversazione':
        return { conversazione: this.conversazione(r.conversazioneId) };
      case 'eventi.dopo':
        return { eventi: this.store.dopo(r.seq, r.limite) };
      case 'abbona':
        // Con IPC la finestra riceve già tutto; un trasporto remoto userà
        // l'elenco per filtrare.
        return {};
      case 'bozza.esporta':
      case 'documento.leggi':
        return {}; // asincrone: le gestiscono esporta() e leggiDocumento()
    }
  }

  private async esporta(r: Extract<Richiesta, { tipo: 'bozza.esporta' }>): Promise<EsitoComando | { ok: true; dati: FileEsportato }> {
    if (!this.esportaBozza) return { ok: false, errore: 'Esportazione non disponibile su questo computer.' };
    try {
      const byte = await this.esportaBozza({ titolo: r.titolo, contenuto: r.contenuto }, r.formato);
      const base = (r.titolo.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Bozza').slice(0, 80);
      const word = r.formato === 'word';
      return {
        ok: true,
        dati: {
          nome: `${base}.${word ? 'docx' : 'pdf'}`,
          mime: word ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf',
          base64: Buffer.from(byte).toString('base64'),
        },
      };
    } catch (err) {
      this.registraErrore('esporta', err instanceof Error ? err.message : String(err));
      return { ok: false, errore: 'Non sono riuscito a preparare il documento.' };
    }
  }

  private async leggiDocumento(r: Extract<Richiesta, { tipo: 'documento.leggi' }>): Promise<EsitoComando | { ok: true; dati: PezzoDocumento }> {
    const doc = this.db
      .prepare('SELECT nome, percorso FROM documento WHERE pratica_id = ? AND id = ?')
      .get(r.praticaId, r.documentoId) as { nome: string; percorso: string | null } | undefined;
    if (!doc) return { ok: false, errore: 'Questo documento non è più nella pratica.' };
    if (!doc.percorso) return { ok: false, errore: 'Questo documento non ha un file sul computer.' };
    let file: FileHandle | null = null;
    try {
      const percorso = this.risolviPercorso(doc.percorso);
      file = await open(percorso, 'r');
      const { size } = await file.stat();
      const da = Math.min(r.da, size);
      const buffer = Buffer.alloc(Math.min(PEZZO_DOCUMENTO, size - da));
      const { bytesRead } = buffer.length ? await file.read(buffer, 0, buffer.length, da) : { bytesRead: 0 };
      return {
        ok: true,
        dati: {
          nome: basename(percorso),
          mime: mimeDi(percorso),
          dimensione: size,
          da,
          base64: buffer.subarray(0, bytesRead).toString('base64'),
          fine: da + bytesRead >= size,
        },
      };
    } catch (err) {
      const codice = (err as NodeJS.ErrnoException).code;
      if (codice === 'ENOENT') return { ok: false, errore: 'Il file non si trova più sul computer: forse è stato spostato o rinominato.' };
      this.registraErrore('documento', err instanceof Error ? err.message : String(err));
      return { ok: false, errore: 'Non riesco a leggere il documento.' };
    } finally {
      await file?.close();
    }
  }

  conversazione(id: string): ProiezioneConversazione | null {
    const inCache = this.cache.get(id);
    if (inCache) return inCache;
    const c = ricostruisciConversazione(this.store.perConversazione(id));
    if (!c || c.eliminata) return null;
    // Turno in corso: il testo già scritto non è nel log, sta in memoria.
    const t = this.turni.get(id);
    const conParziale = t && c.turno?.turnoId === t.turnoId ? { ...c, turno: { ...c.turno, testoParziale: t.parziale } } : c;
    this.cache.set(id, conParziale);
    return conParziale;
  }

  // ─── Comandi ───────────────────────────────────────────────────────────

  async esegui(comando: Comando, origine: Origine = {}): Promise<EsitoComando> {
    // Comando già eseguito (il client l'ha rimandato dopo una riconnessione).
    if (this.store.comandoEseguito(comando.comandoId)) return { ok: true, seq: this.store.ultimoSeq() };
    try {
      return this.eseguiNuovo(comando, origine);
    } catch (err) {
      this.registraErrore(`comando ${comando.tipo}`, err instanceof Error ? (err.stack ?? err.message) : String(err));
      return { ok: false, errore: MESSAGGI.erroreInterno };
    }
  }

  private eseguiNuovo(comando: Comando, origine: Origine): EsitoComando {
    const { comandoId } = comando;
    const da = { ...(origine.dispositivoId ? { dispositivoId: origine.dispositivoId } : {}), ...(origine.utenteId ? { utenteId: origine.utenteId } : {}) };

    switch (comando.tipo) {
      case 'conversazione.crea': {
        const a = comando.argomenti;
        if (this.elenco.conversazioni[a.conversazioneId]) return this.ok();
        return this.ok(this.scriviInTransazione(() => this.creaConversazione(a, da), comandoId));
      }

      case 'conversazione.invia': {
        const a = comando.argomenti;
        const r = this.elenco.conversazioni[a.conversazioneId];
        if (!r) return { ok: false, errore: MESSAGGI.nonTrovata };
        if (r.turnoId || this.turni.has(a.conversazioneId)) return { ok: false, errore: MESSAGGI.occupata };
        const turnoId = this.nuovoId();
        const scritti = this.scrivi(
          [
            { tipo: 'messaggio_utente', conversazioneId: a.conversazioneId, ...da, payload: { messaggioId: this.nuovoId(), testo: a.testo } },
            { tipo: 'turno_iniziato', conversazioneId: a.conversazioneId, ...da, payload: { turnoId, qualita: a.qualita } },
          ],
          comandoId,
        );
        void this.avviaTurno({
          conversazioneId: a.conversazioneId,
          modalita: r.modalita,
          testo: a.testoAgente ?? a.testo,
          qualita: a.qualita,
          praticaId: r.praticaId,
          turnoId,
        });
        return this.ok(scritti);
      }

      case 'conversazione.ferma': {
        const t = this.turni.get(comando.argomenti.conversazioneId);
        if (t) {
          t.fermato = true;
          this.motore.ferma(comando.argomenti.conversazioneId);
        }
        // Niente eventi: li scrive la fine del turno. Si ricorda il comando.
        this.store.appendi([], { comandoId });
        return this.ok();
      }

      case 'conversazione.rinomina': {
        const { conversazioneId, titolo } = comando.argomenti;
        if (!this.elenco.conversazioni[conversazioneId]) return { ok: false, errore: MESSAGGI.nonTrovata };
        return this.ok(this.scrivi([{ tipo: 'conversazione_rinominata', conversazioneId, ...da, payload: { titolo } }], comandoId));
      }

      case 'conversazione.cambiaProcedura': {
        const { conversazioneId, procedura } = comando.argomenti;
        if (!this.elenco.conversazioni[conversazioneId]) return { ok: false, errore: MESSAGGI.nonTrovata };
        return this.ok(this.scrivi([{ tipo: 'procedura_cambiata', conversazioneId, ...da, payload: { procedura } }], comandoId));
      }

      case 'conversazione.elimina': {
        const { conversazioneId } = comando.argomenti;
        if (!this.elenco.conversazioni[conversazioneId]) return this.ok();
        return this.ok(this.scriviInTransazione(() => this.eliminaConversazione(conversazioneId, da), comandoId));
      }

      case 'conversazione.rispondiConferma': {
        const { conversazioneId, confermaId, esito, nota } = comando.argomenti;
        const c = this.conversazione(conversazioneId);
        if (!c?.conferme.some((k) => k.confermaId === confermaId)) return { ok: false, errore: MESSAGGI.confermaScaduta };
        return this.ok(
          this.scrivi(
            [{ tipo: 'conferma_risposta', conversazioneId, ...da, payload: { confermaId, esito, ...(nota ? { nota } : {}) } }],
            comandoId,
          ),
        );
      }

      // ─── Entità (passo 5) ───
      case 'pratica.salva':
      case 'pratica.elimina':
      case 'documenti.salva':
      case 'studio.salva':
      case 'preferenzeSito.salva':
      case 'idee.salva':
      case 'conversazioneSito.salva':
      case 'conversazioneSito.elimina':
        // Prima della migrazione le entità stanno ancora nel JSON: scriverle
        // qui farebbe fallire la migrazione (chiavi già presenti).
        if (!migrazioneFatta(this.db, MIGRAZIONE_RESTO)) return { ok: false, errore: MESSAGGI.datiNonPronti };
        return this.eseguiEntita(comando, da);
    }
  }

  private eseguiEntita(comando: Comando, da: Pick<EventoNuovo, 'dispositivoId' | 'utenteId'>): EsitoComando {
    const ora = this.orologio();
    const cambiata = (
      entita: Extract<Evento, { tipo: 'entita_cambiata' }>['payload']['entita'],
      id: string,
      azione: 'creata' | 'aggiornata' | 'eliminata',
    ): EventoNuovo => ({ tipo: 'entita_cambiata', conversazioneId: null, ...da, payload: { entita, id, azione } });
    const praticaEsiste = (id: string) => this.db.prepare('SELECT 1 FROM pratica WHERE id = ?').get(id) !== undefined;

    switch (comando.tipo) {
      case 'pratica.salva': {
        const p = comando.argomenti.pratica;
        const nuova = !praticaEsiste(p.id);
        return this.ok(this.scriviInTransazione(() => (salvaPratica(this.db, p), [cambiata('pratica', p.id, nuova ? 'creata' : 'aggiornata')]), comando.comandoId));
      }
      case 'pratica.elimina': {
        const { praticaId } = comando.argomenti;
        if (!praticaEsiste(praticaId)) return this.ok();
        return this.ok(this.scriviInTransazione(() => (eliminaPratica(this.db, praticaId), [cambiata('pratica', praticaId, 'eliminata')]), comando.comandoId));
      }
      case 'documenti.salva': {
        const { praticaId, documenti } = comando.argomenti;
        if (!praticaEsiste(praticaId)) return { ok: false, errore: MESSAGGI.praticaNonTrovata };
        return this.ok(
          this.scriviInTransazione(() => (salvaDocumenti(this.db, praticaId, documenti), [cambiata('documento', praticaId, 'aggiornata')]), comando.comandoId),
        );
      }
      case 'studio.salva':
        return this.ok(
          this.scriviInTransazione(() => (salvaImpostazione(this.db, 'studio', comando.argomenti.studio, ora), [cambiata('studio', 'studio', 'aggiornata')]), comando.comandoId),
        );
      case 'preferenzeSito.salva':
        return this.ok(
          this.scriviInTransazione(
            () => (salvaImpostazione(this.db, 'preferenzeSito', comando.argomenti.preferenze, ora), [cambiata('preferenze', 'preferenzeSito', 'aggiornata')]),
            comando.comandoId,
          ),
        );
      case 'idee.salva':
        return this.ok(this.scriviInTransazione(() => (salvaIdee(this.db, comando.argomenti.idee), [cambiata('idea', '*', 'aggiornata')]), comando.comandoId));
      case 'conversazioneSito.salva': {
        const { dati } = comando.argomenti;
        return this.ok(
          this.scriviInTransazione(() => {
            // L'articolo nasce nella finestra: la conversazione si crea qui
            // se non c'è ancora (l'invio della prima domanda la ritrova).
            const nuova = this.elenco.conversazioni[dati.id]
              ? []
              : this.creaConversazione(
                  { conversazioneId: dati.id, modalita: 'studio-digitale', praticaId: null, titolo: dati.titolo, procedura: null, qualita: 'Standard' },
                  da,
                );
            salvaDatiConversazioneSito(this.db, dati);
            return [...nuova, cambiata('conversazione_sito', dati.id, nuova.length ? 'creata' : 'aggiornata')];
          }, comando.comandoId),
        );
      }
      case 'conversazioneSito.elimina': {
        const { conversazioneId } = comando.argomenti;
        return this.ok(
          this.scriviInTransazione(() => {
            eliminaDatiConversazioneSito(this.db, conversazioneId);
            const eliminata = this.elenco.conversazioni[conversazioneId] ? this.eliminaConversazione(conversazioneId, da) : [];
            return [...eliminata, cambiata('conversazione_sito', conversazioneId, 'eliminata')];
          }, comando.comandoId),
        );
      }
      default:
        return { ok: false, errore: MESSAGGI.erroreInterno };
    }
  }

  /** Scrive la riga della conversazione e restituisce l'evento da registrare. */
  private creaConversazione(
    a: Extract<Comando, { tipo: 'conversazione.crea' }>['argomenti'],
    da: Pick<EventoNuovo, 'dispositivoId' | 'utenteId'>,
  ): EventoNuovo[] {
    this.db
      .prepare('INSERT OR IGNORE INTO conversazione (id, modalita, pratica_id, creata_il) VALUES (?, ?, ?, ?)')
      .run(a.conversazioneId, a.modalita, a.praticaId, this.orologio());
    return [
      {
        tipo: 'conversazione_creata',
        conversazioneId: a.conversazioneId,
        ...da,
        payload: { modalita: a.modalita, praticaId: a.praticaId, titolo: a.titolo, procedura: a.procedura, qualita: a.qualita },
      },
    ];
  }

  /** Ferma un'eventuale risposta in corso, segna la riga e restituisce l'evento. */
  private eliminaConversazione(conversazioneId: string, da: Pick<EventoNuovo, 'dispositivoId' | 'utenteId'>): EventoNuovo[] {
    const t = this.turni.get(conversazioneId);
    if (t) {
      t.fermato = true;
      this.motore.ferma(conversazioneId);
    }
    this.db.prepare('UPDATE conversazione SET eliminata_il = ? WHERE id = ?').run(this.orologio(), conversazioneId);
    this.cache.delete(conversazioneId);
    return [{ tipo: 'conversazione_eliminata', conversazioneId, ...da, payload: {} }];
  }

  // ─── Turno dell'assistente ───────────────────────────────────────────────

  private async avviaTurno(r: Omit<RichiestaMotore, 'resume' | 'documenti'> & { turnoId: string }): Promise<void> {
    const { conversazioneId, turnoId } = r;
    const t: TurnoAttivo = { turnoId, parziale: '', numeroBozza: 0, fermato: false, chiuso: false };
    this.turni.set(conversazioneId, t);
    const riga = this.db.prepare('SELECT sdk_session_id FROM conversazione WHERE id = ?').get(conversazioneId) as
      | { sdk_session_id: string | null }
      | undefined;

    const chiudi = (evento: EventoNuovo[]) => {
      if (t.chiuso) return;
      t.chiuso = true;
      this.scriviSicuro(evento);
    };

    const emetti = (e: EventoMotore) => {
      if (t.chiuso) return;
      switch (e.tipo) {
        case 'delta':
          t.parziale += e.testo;
          this.pubblica([this.transitorio({ tipo: 'testo_delta', conversazioneId, payload: { turnoId, testo: e.testo } })]);
          return;
        case 'lavori':
          this.pubblica([this.transitorio({ tipo: 'lavori', conversazioneId, payload: { turnoId, lavori: e.lavori } })]);
          return;
        case 'attivita':
          this.scriviSicuro([{ tipo: 'attivita', conversazioneId, payload: { turnoId, testo: e.testo } }]);
          return;
        case 'bozza':
          this.scriviSicuro([
            {
              tipo: 'bozza_versione',
              conversazioneId,
              payload: { turnoId, bozzaId: `${turnoId}-bozza`, numero: ++t.numeroBozza, bozza: { titolo: e.titolo, contenuto: e.contenuto } },
            },
          ]);
          return;
        case 'articolo':
          this.scriviSicuro([{ tipo: 'articolo', conversazioneId, payload: { turnoId, articolo: e.articolo } }]);
          return;
        case 'idee':
          this.scriviSicuro([{ tipo: 'idee', conversazioneId, payload: { turnoId, idee: e.idee } }]);
          return;
        case 'sessione':
          this.db.prepare('UPDATE conversazione SET sdk_session_id = ? WHERE id = ?').run(e.sessionId, conversazioneId);
          return;
        case 'completato':
          chiudi([
            { tipo: 'testo_assistente', conversazioneId, payload: { turnoId, messaggioId: this.nuovoId(), testo: e.testo } },
            { tipo: 'turno_finito', conversazioneId, payload: { turnoId, esito: 'ok', ...(e.costoUsd !== undefined ? { costoUsd: e.costoUsd } : {}) } },
          ]);
          return;
        case 'errore':
          if (e.scartaParziale) t.parziale = '';
          chiudi([this.fineConErrore(conversazioneId, t, e.messaggio)]);
          return;
      }
    };

    const documenti = r.praticaId ? documentiPratica(this.db, r.praticaId) : [];
    try {
      await this.motore.esegui(
        { ...r, documenti, ...(riga?.sdk_session_id ? { resume: riga.sdk_session_id } : {}) },
        (e) => {
          try {
            emetti(e);
          } catch (err) {
            this.registraErrore('evento del motore', err instanceof Error ? (err.stack ?? err.message) : String(err));
          }
        },
      );
    } catch (err) {
      this.registraErrore('motore', err instanceof Error ? (err.stack ?? err.message) : String(err));
    } finally {
      // Il motore ha finito senza dire come: il turno non resta mai aperto.
      chiudi([this.fineConErrore(conversazioneId, t, MESSAGGI.senzaEsito)]);
      this.turni.delete(conversazioneId);
    }
  }

  private fineConErrore(conversazioneId: string, t: TurnoAttivo, messaggio: string): EventoNuovo {
    return {
      tipo: 'turno_finito',
      conversazioneId,
      payload: {
        turnoId: t.turnoId,
        esito: t.fermato ? 'interrotto' : 'errore',
        messaggioErrore: messaggio,
        // Sempre presente, anche vuoto: decide l'host. Senza, il client
        // userebbe il testo ricevuto in diretta, che può essere da scartare.
        testoParziale: t.parziale,
      },
    };
  }

  /** All'avvio: un turno rimasto aperto (app chiusa o crash) viene chiuso. */
  private chiudiTurniRimasti(): void {
    for (const r of Object.values(this.elenco.conversazioni)) {
      if (!r.turnoId) continue;
      this.scriviSicuro([
        {
          tipo: 'turno_finito',
          conversazioneId: r.id,
          payload: { turnoId: r.turnoId, esito: 'interrotto', messaggioErrore: MESSAGGI.chiusuraApp },
        },
      ]);
    }
  }

  // ─── Scrittura e pubblicazione ──────────────────────────────────────────

  /**
   * Scritture nelle tabelle ed eventi nella stessa transazione; gli
   * abbonati li ricevono solo dopo il commit, mai per una scrittura annullata.
   */
  private scriviInTransazione(fn: () => EventoNuovo[], comandoId: string): Evento[] {
    const eventi = inTransazione(this.db, () => this.store.appendi(fn(), { comandoId }).eventi);
    this.pubblica(eventi);
    return eventi;
  }

  private scrivi(nuovi: EventoNuovo[], comandoId?: string): Evento[] {
    const { eventi } = this.store.appendi(nuovi, comandoId ? { comandoId } : {});
    this.pubblica(eventi);
    return eventi;
  }

  /** Scrittura dentro il turno: un errore non deve fermare l'agente. */
  private scriviSicuro(nuovi: EventoNuovo[]): void {
    try {
      this.scrivi(nuovi);
    } catch (err) {
      this.registraErrore('scrittura evento', err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
  }

  private transitorio(e: EventoNuovo): Evento {
    return { ...e, seq: null, creatoIl: this.orologio() } as Evento;
  }

  private pubblica(eventi: Evento[]): void {
    for (const e of eventi) {
      this.elenco = riduciElenco(this.elenco, e);
      const id = e.conversazioneId;
      if (id) {
        const c = this.cache.get(id);
        if (c) {
          const nuovo = riduciConversazione(c, e);
          if (nuovo && !nuovo.eliminata) this.cache.set(id, nuovo);
          else this.cache.delete(id);
        }
      }
      for (const fn of this.abbonati) {
        try {
          fn(e);
        } catch (err) {
          this.registraErrore('abbonato', err instanceof Error ? err.message : String(err));
        }
      }
    }
  }

  private ok(eventi: Evento[] = []): EsitoComando {
    return { ok: true, seq: eventi.at(-1)?.seq ?? this.store.ultimoSeq() };
  }
}
