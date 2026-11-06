import type {
  Articolo,
  Bozza,
  FonteCitata,
  IdeaProposta,
  LavoroDocumento,
  Modalita,
  PassoPiano,
  Procedura,
  Qualita,
  StatoConversazione,
} from './protocollo/modelli';
import type { Evento, EventoDi } from './protocollo/eventi';

// Reducer condiviso (docs/eventstore-protocollo.md §2): funzioni pure
// (stato, evento) → stato. Le usa l'host per le proiezioni e i client
// (desktop, telefono) per aggiornare la UI. Niente Electron, niente React,
// niente orologio: tutto quello che serve arriva dagli eventi, così
// rileggere lo stesso log dà sempre lo stesso risultato.

export interface MessaggioProiettato {
  id: string;
  ruolo: 'avvocato' | 'assistente';
  testo: string;
  fonti?: FonteCitata[];
  isStreaming?: boolean;
  bozza?: Bozza;
  articolo?: Articolo;
  /** Dispositivo da cui l'avvocato ha scritto (registro Attività, "dal telefono"). */
  dispositivoId?: string;
}

export interface TurnoInCorso {
  turnoId: string;
  qualita: Qualita;
  testoParziale: string;
  attivita: string | null;
  lavori: LavoroDocumento[];
  // Arrivati durante il turno, da agganciare al messaggio finale.
  bozza?: Bozza;
  articolo?: Articolo;
  /** Il testo finale è già arrivato (testo_assistente), manca solo turno_finito. */
  rispostaArrivata: boolean;
}

export interface ConfermaAperta {
  confermaId: string;
  turnoId: string;
  livello: 'conferma' | 'revisione';
  titolo: string;
  anteprima?: string;
}

export interface ProiezioneConversazione {
  id: string;
  modalita: Modalita;
  praticaId: string | null;
  titolo: string;
  procedura: Procedura | null;
  qualita: Qualita;
  stato: StatoConversazione;
  creataIl: string;
  aggiornataIl: string;
  creataDa?: string;
  messaggi: MessaggioProiettato[];
  piano?: PassoPiano[];
  /** Studio digitale: ultima versione dell'articolo proposta dall'assistente. */
  articolo?: Articolo;
  /** Studio digitale: ultime idee proposte. */
  ideeProposte?: IdeaProposta[];
  turno: TurnoInCorso | null;
  conferme: ConfermaAperta[];
  costoUsd: number;
  eliminata: boolean;
  /** Ultimo seq applicato: gli eventi con seq ≤ questo vengono ignorati. */
  ultimoSeq: number;
}

const LUNGHEZZA_TITOLO = 60;
const MESSAGGIO_ERRORE_GENERICO = 'Non sono riuscito a completare la risposta.';
const MESSAGGIO_INTERRUZIONE = 'Richiesta interrotta.';

/** Stesso formato di conParzialeEventuale in src/main/agentRunner.ts. */
function conParziale(parziale: string, messaggio: string): string {
  return parziale ? `${parziale}\n\n⚠ ${messaggio}` : messaggio;
}

function eDelTurno(stato: ProiezioneConversazione, turnoId: string): stato is ProiezioneConversazione & { turno: TurnoInCorso } {
  return stato.turno !== null && stato.turno.turnoId === turnoId;
}

function creaDa(evento: EventoDi<'conversazione_creata'>): ProiezioneConversazione {
  const p = evento.payload;
  return {
    id: evento.conversazioneId ?? '',
    modalita: p.modalita,
    praticaId: p.praticaId,
    titolo: p.titolo,
    procedura: p.procedura,
    qualita: p.qualita,
    stato: 'completata',
    creataIl: evento.creatoIl,
    aggiornataIl: evento.creatoIl,
    ...(evento.dispositivoId ? { creataDa: evento.dispositivoId } : {}),
    messaggi: [],
    turno: null,
    conferme: [],
    costoUsd: 0,
    eliminata: false,
    ultimoSeq: evento.seq ?? 0,
  };
}

/**
 * Applica un evento alla proiezione di una conversazione.
 * - stato null: solo conversazione_creata fa nascere la proiezione.
 * - eventi di altre conversazioni, duplicati (seq già visto) o di un turno
 *   diverso da quello in corso: ignorati, lo stato torna identico (stesso
 *   oggetto), così React non ridisegna.
 */
export function riduciConversazione(
  stato: ProiezioneConversazione | null,
  evento: Evento,
): ProiezioneConversazione | null {
  if (stato === null) {
    return evento.tipo === 'conversazione_creata' && evento.conversazioneId ? creaDa(evento) : null;
  }
  if (evento.conversazioneId !== stato.id) return stato;
  if (evento.seq !== null && evento.seq <= stato.ultimoSeq) return stato;

  const prossimo = applica(stato, evento);
  if (prossimo === stato) return stato;
  return evento.seq !== null ? { ...prossimo, ultimoSeq: evento.seq, aggiornataIl: evento.creatoIl } : prossimo;
}

function applica(stato: ProiezioneConversazione, evento: Evento): ProiezioneConversazione {
  switch (evento.tipo) {
    case 'conversazione_creata':
    case 'entita_cambiata':
      return stato;

    case 'conversazione_rinominata':
      return { ...stato, titolo: evento.payload.titolo };

    case 'conversazione_eliminata':
      return { ...stato, eliminata: true, turno: null, conferme: [] };

    case 'messaggio_utente': {
      const messaggio: MessaggioProiettato = {
        id: evento.payload.messaggioId,
        ruolo: 'avvocato',
        testo: evento.payload.testo,
        ...(evento.dispositivoId ? { dispositivoId: evento.dispositivoId } : {}),
      };
      // Come oggi in ConversazioneView: senza titolo, il titolo è l'inizio
      // della prima domanda.
      const titolo = stato.titolo || evento.payload.testo.slice(0, LUNGHEZZA_TITOLO);
      return { ...stato, titolo, messaggi: [...stato.messaggi, messaggio] };
    }

    case 'turno_iniziato':
      return {
        ...stato,
        stato: 'in_corso',
        qualita: evento.payload.qualita,
        turno: {
          turnoId: evento.payload.turnoId,
          qualita: evento.payload.qualita,
          testoParziale: '',
          attivita: null,
          lavori: [],
          rispostaArrivata: false,
        },
      };

    case 'attivita':
      if (!eDelTurno(stato, evento.payload.turnoId)) return stato;
      return { ...stato, turno: { ...stato.turno, attivita: evento.payload.testo } };

    case 'testo_delta':
      if (!eDelTurno(stato, evento.payload.turnoId)) return stato;
      // Come oggi: appena arriva testo, la riga "Sto leggendo…" sparisce.
      return {
        ...stato,
        turno: { ...stato.turno, attivita: null, testoParziale: stato.turno.testoParziale + evento.payload.testo },
      };

    case 'lavori':
      if (!eDelTurno(stato, evento.payload.turnoId)) return stato;
      return { ...stato, turno: { ...stato.turno, lavori: evento.payload.lavori } };

    case 'piano':
      return { ...stato, piano: evento.payload.passi };

    case 'bozza_versione':
      if (!eDelTurno(stato, evento.payload.turnoId)) return stato;
      return { ...stato, turno: { ...stato.turno, bozza: evento.payload.bozza } };

    case 'articolo':
      if (!eDelTurno(stato, evento.payload.turnoId)) return stato;
      // Come oggi in useStudioDigitale: l'articolo compare subito
      // nell'editor e dà il titolo alla conversazione.
      return {
        ...stato,
        titolo: evento.payload.articolo.titolo,
        articolo: evento.payload.articolo,
        turno: { ...stato.turno, articolo: evento.payload.articolo },
      };

    case 'idee':
      if (!eDelTurno(stato, evento.payload.turnoId)) return stato;
      return { ...stato, ideeProposte: evento.payload.idee };

    case 'testo_assistente': {
      if (!eDelTurno(stato, evento.payload.turnoId)) return stato;
      const { turno } = stato;
      const messaggio: MessaggioProiettato = {
        id: evento.payload.messaggioId,
        ruolo: 'assistente',
        testo: evento.payload.testo,
        ...(evento.payload.fonti ? { fonti: evento.payload.fonti } : {}),
        ...(turno.bozza ? { bozza: turno.bozza } : {}),
        ...(turno.articolo ? { articolo: turno.articolo } : {}),
      };
      return {
        ...stato,
        messaggi: [...stato.messaggi, messaggio],
        turno: { ...turno, testoParziale: '', attivita: null, bozza: undefined, articolo: undefined, rispostaArrivata: true },
      };
    }

    case 'conferma_richiesta':
      if (!eDelTurno(stato, evento.payload.turnoId)) return stato;
      return {
        ...stato,
        stato: 'attesa',
        conferme: [
          ...stato.conferme,
          {
            confermaId: evento.payload.confermaId,
            turnoId: evento.payload.turnoId,
            livello: evento.payload.livello,
            titolo: evento.payload.titolo,
            ...(evento.payload.anteprima !== undefined ? { anteprima: evento.payload.anteprima } : {}),
          },
        ],
      };

    case 'conferma_risposta': {
      const conferme = stato.conferme.filter((c) => c.confermaId !== evento.payload.confermaId);
      if (conferme.length === stato.conferme.length) return stato;
      const statoConv: StatoConversazione = conferme.length === 0 && stato.turno ? 'in_corso' : stato.stato;
      return { ...stato, conferme, stato: statoConv };
    }

    case 'turno_finito': {
      if (!eDelTurno(stato, evento.payload.turnoId)) return stato;
      const { turno } = stato;
      const p = evento.payload;
      const costoUsd = stato.costoUsd + (p.costoUsd ?? 0);
      const chiuso = { ...stato, turno: null, conferme: [], costoUsd };

      if (p.esito === 'ok') {
        // Caso anomalo (risposta finita senza testo finale): non si perde
        // quello che è arrivato in streaming.
        if (!turno.rispostaArrivata && (p.testoParziale ?? turno.testoParziale)) {
          return {
            ...chiuso,
            stato: 'completata',
            messaggi: [...stato.messaggi, messaggioDiChiusura(turno, p.testoParziale ?? turno.testoParziale)],
          };
        }
        return { ...chiuso, stato: 'completata' };
      }

      // errore / interrotto: un solo messaggio con il parziale (se c'è) e il
      // motivo. Il parziale del payload vale più di quello in memoria: chi
      // rilegge il log dopo un riavvio non ha mai visto i testo_delta.
      const parziale = turno.rispostaArrivata ? '' : (p.testoParziale ?? turno.testoParziale);
      const motivo = p.messaggioErrore ?? (p.esito === 'interrotto' ? MESSAGGIO_INTERRUZIONE : MESSAGGIO_ERRORE_GENERICO);
      return {
        ...chiuso,
        stato: 'interrotta',
        messaggi: [...stato.messaggi, messaggioDiChiusura(turno, conParziale(parziale, motivo))],
      };
    }
  }
}

function messaggioDiChiusura(turno: TurnoInCorso, testo: string): MessaggioProiettato {
  return {
    id: `${turno.turnoId}:fine`,
    ruolo: 'assistente',
    testo,
    // Una bozza proposta prima dell'errore non va persa (oggi si perde).
    ...(turno.bozza ? { bozza: turno.bozza } : {}),
    ...(turno.articolo ? { articolo: turno.articolo } : {}),
  };
}

/**
 * Messaggi da disegnare: quelli definitivi più, durante lo streaming, la
 * risposta che si sta scrivendo (isStreaming), come oggi in ConversazioneView.
 */
export function messaggiVisibili(stato: ProiezioneConversazione): MessaggioProiettato[] {
  const t = stato.turno;
  if (!t || !t.testoParziale) return stato.messaggi;
  return [...stato.messaggi, { id: `${t.turnoId}:streaming`, ruolo: 'assistente', testo: t.testoParziale, isStreaming: true }];
}

/** Ricostruisce una conversazione da zero applicando gli eventi in ordine. */
export function ricostruisciConversazione(eventi: Iterable<Evento>): ProiezioneConversazione | null {
  let stato: ProiezioneConversazione | null = null;
  for (const e of eventi) stato = riduciConversazione(stato, e);
  return stato;
}

// ─── Elenco (sidebar, schermata "In attesa" del telefono) ──────────────────

export interface RiepilogoConversazione {
  id: string;
  modalita: Modalita;
  praticaId: string | null;
  titolo: string;
  stato: StatoConversazione;
  aggiornataIl: string;
  attivita: string | null;
  confermeAperte: number;
  turnoId: string | null;
}

export interface ProiezioneElenco {
  conversazioni: Record<string, RiepilogoConversazione>;
  ultimoSeq: number;
}

export const ELENCO_VUOTO: ProiezioneElenco = { conversazioni: {}, ultimoSeq: 0 };

/**
 * Proiezione leggera di tutte le conversazioni: niente messaggi, solo quello
 * che serve agli elenchi. Una conversazione eliminata sparisce.
 */
export function riduciElenco(stato: ProiezioneElenco, evento: Evento): ProiezioneElenco {
  if (evento.seq !== null && evento.seq <= stato.ultimoSeq) return stato;
  const conSeq = (s: ProiezioneElenco): ProiezioneElenco =>
    evento.seq !== null ? { ...s, ultimoSeq: evento.seq } : s;

  const id = evento.conversazioneId;
  if (id === null) return conSeq(stato);

  if (evento.tipo === 'conversazione_creata') {
    const p = evento.payload;
    return conSeq({
      ...stato,
      conversazioni: {
        ...stato.conversazioni,
        [id]: {
          id,
          modalita: p.modalita,
          praticaId: p.praticaId,
          titolo: p.titolo,
          stato: 'completata',
          aggiornataIl: evento.creatoIl,
          attivita: null,
          confermeAperte: 0,
          turnoId: null,
        },
      },
    });
  }

  const r = stato.conversazioni[id];
  if (!r) return conSeq(stato);

  if (evento.tipo === 'conversazione_eliminata') {
    const { [id]: _eliminata, ...resto } = stato.conversazioni;
    return conSeq({ ...stato, conversazioni: resto });
  }

  const nuovo = aggiornaRiepilogo(r, evento);
  if (nuovo === r) return conSeq(stato);
  const conData = evento.seq !== null ? { ...nuovo, aggiornataIl: evento.creatoIl } : nuovo;
  return conSeq({ ...stato, conversazioni: { ...stato.conversazioni, [id]: conData } });
}

function aggiornaRiepilogo(r: RiepilogoConversazione, evento: Evento): RiepilogoConversazione {
  switch (evento.tipo) {
    case 'conversazione_rinominata':
      return { ...r, titolo: evento.payload.titolo };
    case 'messaggio_utente':
      return r.titolo ? r : { ...r, titolo: evento.payload.testo.slice(0, LUNGHEZZA_TITOLO) };
    case 'articolo':
      return { ...r, titolo: evento.payload.articolo.titolo };
    case 'turno_iniziato':
      return { ...r, stato: 'in_corso', turnoId: evento.payload.turnoId, attivita: null, confermeAperte: 0 };
    case 'attivita':
      return r.turnoId === evento.payload.turnoId ? { ...r, attivita: evento.payload.testo } : r;
    case 'testo_delta':
      return r.turnoId === evento.payload.turnoId && r.attivita !== null ? { ...r, attivita: null } : r;
    case 'conferma_richiesta':
      return r.turnoId === evento.payload.turnoId ? { ...r, stato: 'attesa', confermeAperte: r.confermeAperte + 1 } : r;
    case 'conferma_risposta': {
      if (r.confermeAperte === 0) return r;
      const confermeAperte = r.confermeAperte - 1;
      return { ...r, confermeAperte, stato: confermeAperte === 0 && r.turnoId ? 'in_corso' : r.stato };
    }
    case 'turno_finito':
      if (r.turnoId !== evento.payload.turnoId) return r;
      return {
        ...r,
        stato: evento.payload.esito === 'ok' ? 'completata' : 'interrotta',
        turnoId: null,
        attivita: null,
        confermeAperte: 0,
      };
    default:
      return r;
  }
}
