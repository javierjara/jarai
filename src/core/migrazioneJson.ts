import type { Articolo, Bozza, Evento, FonteCitata, PassoPiano, Procedura } from '../shared/protocollo';
import { ricostruisciConversazione } from '../shared/reducer';
import { inTransazione, type Database } from './db';
import { EventStore, type EventoNuovo } from './eventStore';

// Migrazione da jarai-dati.json (src/main/store.ts) a jarai.db
// (docs/eventstore-protocollo.md §7). Chi chiama legge e valida il JSON con
// lo schema di store.ts e passa qui il risultato: src/core non importa dal
// main (che dipende da Electron). Le interfacce sotto descrivono solo i campi
// che servono, così TypeScript verifica la compatibilità nel punto di chiamata.

interface MessaggioLegacy {
  id: string;
  ruolo: 'avvocato' | 'assistente';
  testo: string;
  fonti?: FonteCitata[];
  isStreaming?: boolean;
  bozza?: Bozza;
  articolo?: Articolo;
}

type StatoLegacy = 'in_corso' | 'attesa' | 'completata' | 'interrotta';

export interface ConversazioneLegacy {
  id: string;
  praticaId: string;
  titolo: string;
  procedura: Procedura;
  stato: StatoLegacy;
  aggiornataIl: string;
  piano?: PassoPiano[];
  messaggi: MessaggioLegacy[];
}

export interface ConversazioneSitoLegacy {
  id: string;
  titolo: string;
  stato: StatoLegacy;
  aggiornataIl: string;
  messaggi: MessaggioLegacy[];
  [campo: string]: unknown;
}

export interface DatiLegacy {
  pratiche: Array<{
    id: string;
    nome: string;
    cliente: string;
    controparte?: string;
    ambito: string;
    note?: string;
    documenti: number;
    aggiornataIl: string;
    cartellaPercorso: string | null;
  }>;
  documenti: Record<
    string,
    Array<{ id: string; nome: string; tipo: string; pagine?: number; data: string; cartella: string; dimensione?: number; percorso?: string }>
  >;
  /** Facoltativo: dal passo 4 il JSON salvato non le contiene più. */
  conversazioni?: ConversazioneLegacy[];
  studio?: { nome: string; avvocato: string };
  studioDigitale?: ConversazioneSitoLegacy[];
  ideeSito?: Array<{ id: string; [campo: string]: unknown }>;
  preferenzeSito?: Record<string, unknown>;
}

export interface RiepilogoMigrazione {
  pratiche: number;
  documenti: number;
  conversazioni: number;
  conversazioniSito: number;
  idee: number;
  eventi: number;
}

/** Id usato da ConversazioneView per le conversazioni senza pratica. */
const SENZA_PRATICA = 'senza-pratica';

/**
 * Trasforma una conversazione salvata nel vecchio formato negli eventi che
 * l'avrebbero prodotta. Pura: stessi dati, stessi eventi.
 */
export function eventiDaConversazioneLegacy(
  conv: ConversazioneLegacy | ConversazioneSitoLegacy,
  modalita: 'pratica' | 'studio-digitale',
): EventoNuovo[] {
  const conversazioneId = conv.id;
  const creatoIl = conv.aggiornataIl;
  const ev = (e: Omit<EventoNuovo, 'conversazioneId' | 'creatoIl'>) => ({ ...e, conversazioneId, creatoIl }) as EventoNuovo;

  const praticaId =
    modalita === 'pratica' && 'praticaId' in conv && conv.praticaId && conv.praticaId !== SENZA_PRATICA
      ? (conv.praticaId as string)
      : null;
  const procedura = modalita === 'pratica' && 'procedura' in conv ? (conv.procedura as Procedura) : null;

  const eventi: EventoNuovo[] = [
    ev({
      tipo: 'conversazione_creata',
      payload: { modalita, praticaId, titolo: conv.titolo, procedura, qualita: 'Standard' },
    }),
  ];
  const piano = 'piano' in conv ? (conv.piano as PassoPiano[] | undefined) : undefined;
  if (piano?.length) eventi.push(ev({ tipo: 'piano', payload: { passi: piano } }));

  const ultimo = conv.messaggi.length - 1;
  conv.messaggi.forEach((m, i) => {
    if (m.ruolo === 'avvocato') {
      eventi.push(ev({ tipo: 'messaggio_utente', payload: { messaggioId: m.id, testo: m.testo } }));
      return;
    }
    const turnoId = `migrato-${m.id}`;
    eventi.push(ev({ tipo: 'turno_iniziato', payload: { turnoId, qualita: 'Standard' } }));
    if (m.bozza) {
      eventi.push(ev({ tipo: 'bozza_versione', payload: { turnoId, bozzaId: `${turnoId}-bozza`, numero: 1, bozza: m.bozza } }));
    }
    if (m.articolo) eventi.push(ev({ tipo: 'articolo', payload: { turnoId, articolo: m.articolo } }));

    // Risposta rimasta a metà (app chiusa durante lo streaming) o ultima
    // risposta di una conversazione interrotta: si chiude come errore con
    // il testo esatto del messaggio, così il testo non cambia e lo stato
    // della conversazione resta "interrotta".
    if (m.isStreaming || (i === ultimo && conv.stato === 'interrotta')) {
      eventi.push(ev({ tipo: 'turno_finito', payload: { turnoId, esito: 'errore', messaggioErrore: m.testo } }));
    } else {
      eventi.push(
        ev({
          tipo: 'testo_assistente',
          payload: { turnoId, messaggioId: m.id, testo: m.testo, ...(m.fonti ? { fonti: m.fonti } : {}) },
        }),
      );
      eventi.push(ev({ tipo: 'turno_finito', payload: { turnoId, esito: 'ok' } }));
    }
  });

  // L'articolo dà il titolo alla conversazione e la prima domanda lo riempie
  // se vuoto: se il titolo salvato è diverso (rinominato a mano), si rimette.
  const ricostruita = ricostruisciConversazione(eventi.map((e, n) => ({ ...e, seq: n + 1, creatoIl }) as Evento));
  if (ricostruita && ricostruita.titolo !== conv.titolo && conv.titolo) {
    eventi.push(ev({ tipo: 'conversazione_rinominata', payload: { titolo: conv.titolo } }));
  }
  return eventi;
}

// La migrazione avviene in due parti, ognuna con il suo segno "fatto" in
// impostazione: le conversazioni delle pratiche passano a jarai.db con il
// passo 4 (host), pratiche, documenti e Studio digitale con il passo 5.
export const MIGRAZIONE_CONVERSAZIONI = 'migrazione.conversazioniPratica';
export const MIGRAZIONE_RESTO = 'migrazione.resto';

export function migrazioneFatta(db: Database, parte: string): boolean {
  return db.prepare('SELECT 1 FROM impostazione WHERE chiave = ?').get(parte) !== undefined;
}

function segnaFatta(db: Database, parte: string, ora: string): void {
  db.prepare('INSERT INTO impostazione (chiave, valore, aggiornata_il) VALUES (?, ?, ?)').run(parte, JSON.stringify(ora), ora);
}

type Opzioni = { orologio?: () => string };

/**
 * Prima parte: le conversazioni delle pratiche. In una sola transazione;
 * dopo aver scritto ogni conversazione la ricostruisce dal log e la
 * confronta con l'originale: alla prima differenza annulla tutto, così
 * l'app resta sul JSON e non si perde niente.
 */
export function migraConversazioniPratica(
  db: Database,
  conversazioni: readonly ConversazioneLegacy[],
  opzioni: Opzioni = {},
): Pick<RiepilogoMigrazione, 'conversazioni' | 'eventi'> {
  const orologio = opzioni.orologio ?? (() => new Date().toISOString());
  return inTransazione(db, () => {
    if (migrazioneFatta(db, MIGRAZIONE_CONVERSAZIONI)) throw new Error('Migrazione delle conversazioni già fatta.');
    const eventi = scriviConversazioni(db, new EventStore(db, orologio), conversazioni.map((c) => ({ c, modalita: 'pratica' as const })));
    segnaFatta(db, MIGRAZIONE_CONVERSAZIONI, orologio());
    return { conversazioni: conversazioni.length, eventi };
  });
}

/** Seconda parte: pratiche, documenti, impostazioni, idee e Studio digitale. */
export function migraResto(db: Database, dati: DatiLegacy, opzioni: Opzioni = {}): Omit<RiepilogoMigrazione, 'conversazioni'> {
  const orologio = opzioni.orologio ?? (() => new Date().toISOString());
  return inTransazione(db, () => {
    if (migrazioneFatta(db, MIGRAZIONE_RESTO)) throw new Error('Migrazione di pratiche e Studio digitale già fatta.');
    const ora = orologio();
    const impostazione = db.prepare('INSERT INTO impostazione (chiave, valore, aggiornata_il) VALUES (?, ?, ?)');
    if (dati.studio) impostazione.run('studio', JSON.stringify(dati.studio), ora);
    if (dati.preferenzeSito) impostazione.run('preferenzeSito', JSON.stringify(dati.preferenzeSito), ora);

    const pratica = db.prepare(
      `INSERT INTO pratica (id, nome, cliente, controparte, ambito, note, documenti, cartella_percorso, aggiornata_il)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of dati.pratiche) {
      pratica.run(p.id, p.nome, p.cliente, p.controparte ?? null, p.ambito, p.note ?? null, p.documenti, p.cartellaPercorso, p.aggiornataIl);
    }

    const documento = db.prepare(
      `INSERT INTO documento (pratica_id, id, nome, tipo, pagine, data, cartella, dimensione, percorso)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const idPratiche = new Set(dati.pratiche.map((p) => p.id));
    let documenti = 0;
    for (const [praticaId, elenco] of Object.entries(dati.documenti)) {
      // Documenti di una pratica che non esiste più: nel JSON potevano
      // restare orfani, qui la chiave esterna li rifiuterebbe.
      if (!idPratiche.has(praticaId)) continue;
      for (const d of elenco) {
        documento.run(praticaId, d.id, d.nome, d.tipo, d.pagine ?? null, d.data, d.cartella, d.dimensione ?? null, d.percorso ?? null);
        documenti++;
      }
    }

    const idea = db.prepare('INSERT INTO idea (id, dati) VALUES (?, ?)');
    for (const i of dati.ideeSito ?? []) idea.run(i.id, JSON.stringify(i));

    const sito = (dati.studioDigitale ?? []).map((c) => ({ c, modalita: 'studio-digitale' as const }));
    const eventi = scriviConversazioni(db, new EventStore(db, orologio), sito);
    segnaFatta(db, MIGRAZIONE_RESTO, orologio());
    return {
      pratiche: dati.pratiche.length,
      documenti,
      conversazioniSito: sito.length,
      idee: dati.ideeSito?.length ?? 0,
      eventi,
    };
  });
}

/** Le due parti insieme, in una sola transazione. */
export function migraDaJson(db: Database, dati: DatiLegacy, opzioni: Opzioni = {}): RiepilogoMigrazione {
  return inTransazione(db, () => {
    const a = migraConversazioniPratica(db, dati.conversazioni ?? [], opzioni);
    const b = migraResto(db, dati, opzioni);
    return { ...b, conversazioni: a.conversazioni, eventi: a.eventi + b.eventi };
  });
}

function scriviConversazioni(
  db: Database,
  store: EventStore,
  elenco: Array<{ c: ConversazioneLegacy | ConversazioneSitoLegacy; modalita: 'pratica' | 'studio-digitale' }>,
): number {
  const conversazione = db.prepare('INSERT INTO conversazione (id, modalita, pratica_id, creata_il) VALUES (?, ?, ?, ?)');
  const datiSito = db.prepare('INSERT INTO conversazione_sito (id, dati) VALUES (?, ?)');
  // Ordine cronologico: il seq globale segue, per quanto possibile, il tempo.
  const ordinate = [...elenco].sort((a, b) => a.c.aggiornataIl.localeCompare(b.c.aggiornataIl));
  let eventi = 0;
  for (const { c, modalita } of ordinate) {
    const nuovi = eventiDaConversazioneLegacy(c, modalita);
    const creata = nuovi[0];
    const praticaId = creata.tipo === 'conversazione_creata' ? creata.payload.praticaId : null;
    conversazione.run(c.id, modalita, praticaId, c.aggiornataIl);
    if (modalita === 'studio-digitale') {
      const { messaggi: _messaggi, stato: _stato, ...editoriale } = c as ConversazioneSitoLegacy;
      datiSito.run(c.id, JSON.stringify(editoriale));
    }
    eventi += store.appendi(nuovi).eventi.length;
    verificaConversazione(store, c);
  }
  return eventi;
}

/** Ricostruisce la conversazione dal log e la confronta con l'originale. */
function verificaConversazione(store: EventStore, originale: ConversazioneLegacy | ConversazioneSitoLegacy): void {
  const r = ricostruisciConversazione(store.perConversazione(originale.id));
  const errore = (dettaglio: string) =>
    // Niente contenuto delle pratiche nel messaggio: finisce nei log.
    new Error(`Migrazione: la conversazione ${originale.id} non corrisponde all'originale (${dettaglio}).`);

  if (!r) throw errore('non ricostruita');
  if (r.titolo !== originale.titolo) throw errore('titolo');
  if (r.messaggi.length !== originale.messaggi.length) throw errore(`messaggi ${r.messaggi.length} invece di ${originale.messaggi.length}`);
  originale.messaggi.forEach((m, i) => {
    const n = r.messaggi[i];
    if (n.ruolo !== m.ruolo) throw errore(`ruolo del messaggio ${i + 1}`);
    if (n.testo !== m.testo) throw errore(`testo del messaggio ${i + 1}`);
    if (!uguali(n.fonti, m.fonti)) throw errore(`fonti del messaggio ${i + 1}`);
    if (!uguali(n.bozza, m.bozza)) throw errore(`bozza del messaggio ${i + 1}`);
    if (!uguali(n.articolo, m.articolo)) throw errore(`articolo del messaggio ${i + 1}`);
  });
  const piano = 'piano' in originale ? (originale.piano as PassoPiano[] | undefined) : undefined;
  if (piano?.length && !uguali(r.piano, piano)) throw errore('piano');
}

/** Uguaglianza profonda che ignora l'ordine delle chiavi (zod le riordina). */
function uguali(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonico(a ?? null)) === JSON.stringify(canonico(b ?? null));
}

function canonico(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonico);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, canonico(x)]),
    );
  }
  return v;
}
