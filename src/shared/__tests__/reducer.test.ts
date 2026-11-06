import { describe, expect, it } from 'vitest';
import { bustaSchema, comandoSchema, eTransitorio, eventoSchema, type Evento } from '../protocollo';
import {
  ELENCO_VUOTO,
  messaggiVisibili,
  ricostruisciConversazione,
  riduciConversazione,
  riduciElenco,
  type MessaggioProiettato,
  type ProiezioneConversazione,
} from '../reducer';

// ─── Traccia di un turno, nel formato degli eventi di oggi (agentRunner) ───

type EventoAgenteOggi =
  | { tipo: 'delta'; testo: string }
  | { tipo: 'attivita'; testo: string }
  | { tipo: 'bozza'; titolo: string; contenuto: string }
  | { tipo: 'completato'; testo: string }
  // Come oggi: il main incolla già il parziale nel messaggio (conParzialeEventuale).
  | { tipo: 'errore'; messaggio: string; motivo: string };

interface MessaggioOggi {
  ruolo: 'avvocato' | 'assistente';
  testo: string;
  isStreaming?: boolean;
  bozza?: { titolo: string; contenuto: string };
}

/**
 * Oracolo: la logica di oggi di ConversazioneView.tsx (onEvento + invia),
 * senza React. Serve a dimostrare che il reducer dà lo stesso risultato.
 */
function vistaDiOggi(domanda: string, traccia: EventoAgenteOggi[]): MessaggioOggi[] {
  let messaggi: MessaggioOggi[] = [{ ruolo: 'avvocato', testo: domanda }];
  let bozza: MessaggioOggi['bozza'];
  for (const e of traccia) {
    if (e.tipo === 'attivita') continue;
    if (e.tipo === 'bozza') {
      bozza = { titolo: e.titolo, contenuto: e.contenuto };
      continue;
    }
    const ultimo = messaggi[messaggi.length - 1];
    if (e.tipo === 'delta') {
      messaggi =
        ultimo?.ruolo === 'assistente' && ultimo.isStreaming
          ? [...messaggi.slice(0, -1), { ...ultimo, testo: ultimo.testo + e.testo }]
          : [...messaggi, { ruolo: 'assistente', testo: e.testo, isStreaming: true }];
    } else if (e.tipo === 'completato') {
      messaggi =
        ultimo?.ruolo === 'assistente' && ultimo.isStreaming
          ? [...messaggi.slice(0, -1), { ...ultimo, testo: e.testo, isStreaming: false, bozza }]
          : [...messaggi, { ruolo: 'assistente', testo: e.testo, bozza }];
    } else {
      messaggi =
        ultimo?.ruolo === 'assistente' && ultimo.isStreaming && !ultimo.testo
          ? [...messaggi.slice(0, -1), { ...ultimo, testo: e.messaggio, isStreaming: false }]
          : [...messaggi, { ruolo: 'assistente', testo: e.messaggio }];
    }
  }
  return messaggi;
}

/** Quello che farà l'host (PR 4): traduce la stessa traccia in eventi del protocollo. */
function eventiDaTraccia(conversazioneId: string, domanda: string, traccia: EventoAgenteOggi[]): Evento[] {
  let seq = 0;
  const ora = (n: number) => `2026-11-06T10:00:${String(n).padStart(2, '0')}.000Z`;
  const persistito = <E extends Omit<Evento, 'seq' | 'creatoIl' | 'conversazioneId'>>(e: E) =>
    ({ ...e, seq: ++seq, creatoIl: ora(seq), conversazioneId }) as unknown as Evento;
  const transitorio = <E extends Omit<Evento, 'seq' | 'creatoIl' | 'conversazioneId'>>(e: E) =>
    ({ ...e, seq: null, creatoIl: ora(seq), conversazioneId }) as unknown as Evento;

  const turnoId = 't1';
  let parziale = '';
  let numeroBozza = 0;
  const eventi: Evento[] = [
    persistito({
      tipo: 'conversazione_creata',
      payload: { modalita: 'pratica', praticaId: 'p1', titolo: '', procedura: 'Analisi & Redazione', qualita: 'Standard' },
    }),
    persistito({ tipo: 'messaggio_utente', payload: { messaggioId: 'm1', testo: domanda } }),
    persistito({ tipo: 'turno_iniziato', payload: { turnoId, qualita: 'Standard' } }),
  ];
  for (const e of traccia) {
    if (e.tipo === 'attivita') eventi.push(persistito({ tipo: 'attivita', payload: { turnoId, testo: e.testo } }));
    if (e.tipo === 'delta') {
      parziale += e.testo;
      eventi.push(transitorio({ tipo: 'testo_delta', payload: { turnoId, testo: e.testo } }));
    }
    if (e.tipo === 'bozza')
      eventi.push(
        persistito({
          tipo: 'bozza_versione',
          payload: { turnoId, bozzaId: 'b1', numero: ++numeroBozza, bozza: { titolo: e.titolo, contenuto: e.contenuto } },
        }),
      );
    if (e.tipo === 'completato') {
      eventi.push(persistito({ tipo: 'testo_assistente', payload: { turnoId, messaggioId: 'm2', testo: e.testo } }));
      eventi.push(persistito({ tipo: 'turno_finito', payload: { turnoId, esito: 'ok', costoUsd: 0.12 } }));
    }
    if (e.tipo === 'errore')
      eventi.push(
        persistito({
          tipo: 'turno_finito',
          payload: { turnoId, esito: 'errore', messaggioErrore: e.motivo, ...(parziale ? { testoParziale: parziale } : {}) },
        }),
      );
  }
  return eventi;
}

const confrontabili = (m: Array<MessaggioOggi | MessaggioProiettato>) =>
  m.map(({ ruolo, testo, bozza, isStreaming }) => ({ ruolo, testo, ...(bozza ? { bozza } : {}), ...(isStreaming ? { isStreaming } : {}) }));

const soloPersistiti = (eventi: Evento[]) => eventi.filter((e) => !eTransitorio(e.tipo));

// ─── Tracce realistiche ───────────────────────────────────────────────────

const DOMANDA = 'Quali sono le scadenze nella causa Rossi c. Bianchi?';

const RISPOSTA_NORMALE: EventoAgenteOggi[] = [
  { tipo: 'attivita', testo: 'Sto leggendo un documento della pratica…' },
  { tipo: 'delta', testo: 'Leggo i documenti. ' },
  { tipo: 'attivita', testo: 'Sto cercando nei documenti…' },
  { tipo: 'delta', testo: 'Le scadenze sono ' },
  { tipo: 'delta', testo: 'tre.' },
  // Il risultato finale dell'SDK è il solo ultimo testo, non tutti i delta.
  { tipo: 'completato', testo: 'Le scadenze sono tre: 12/1, 3/2 e 20/3.' },
];

const CON_BOZZA: EventoAgenteOggi[] = [
  { tipo: 'delta', testo: 'Preparo la comparsa.' },
  { tipo: 'bozza', titolo: 'Comparsa di costituzione', contenuto: '# Comparsa\n\nTesto…' },
  { tipo: 'completato', testo: 'Ho preparato la bozza: verifica le date.' },
];

const ERRORE_SENZA_TESTO: EventoAgenteOggi[] = [
  { tipo: 'attivita', testo: 'Sto leggendo…' },
  { tipo: 'errore', messaggio: 'Non riesco a raggiungere Claude.', motivo: 'Non riesco a raggiungere Claude.' },
];

const ERRORE_A_META: EventoAgenteOggi[] = [
  { tipo: 'delta', testo: 'Le scadenze sono' },
  {
    tipo: 'errore',
    messaggio: 'Le scadenze sono\n\n⚠ Non riesco a raggiungere Claude.',
    motivo: 'Non riesco a raggiungere Claude.',
  },
];

// ─── Test ─────────────────────────────────────────────────────────────────

describe('riduciConversazione: stesso risultato della vista di oggi', () => {
  it.each([
    ['risposta normale con attività e streaming', RISPOSTA_NORMALE],
    ['risposta con bozza', CON_BOZZA],
    ['errore prima di qualsiasi testo', ERRORE_SENZA_TESTO],
  ])('%s', (_nome, traccia) => {
    const stato = ricostruisciConversazione(eventiDaTraccia('c1', DOMANDA, traccia));
    expect(stato).not.toBeNull();
    expect(confrontabili(stato!.messaggi)).toEqual(confrontabili(vistaDiOggi(DOMANDA, traccia)));
  });

  it('errore a metà risposta: un solo messaggio, non il parziale due volte (correzione voluta)', () => {
    const oggi = vistaDiOggi(DOMANDA, ERRORE_A_META);
    // Oggi: resta il messaggio in streaming (mai chiuso) e sotto ne arriva
    // un altro con lo stesso testo più l'errore.
    expect(confrontabili(oggi)).toEqual([
      { ruolo: 'avvocato', testo: DOMANDA },
      { ruolo: 'assistente', testo: 'Le scadenze sono', isStreaming: true },
      { ruolo: 'assistente', testo: 'Le scadenze sono\n\n⚠ Non riesco a raggiungere Claude.' },
    ]);

    const stato = ricostruisciConversazione(eventiDaTraccia('c1', DOMANDA, ERRORE_A_META))!;
    expect(confrontabili(stato.messaggi)).toEqual([
      { ruolo: 'avvocato', testo: DOMANDA },
      { ruolo: 'assistente', testo: 'Le scadenze sono\n\n⚠ Non riesco a raggiungere Claude.' },
    ]);
    expect(stato.stato).toBe('interrotta');
  });

  it('una bozza proposta prima di un errore non va persa (correzione voluta)', () => {
    const traccia: EventoAgenteOggi[] = [
      { tipo: 'bozza', titolo: 'Atto', contenuto: 'Testo' },
      { tipo: 'errore', messaggio: 'Richiesta interrotta.', motivo: 'Richiesta interrotta.' },
    ];
    expect(vistaDiOggi(DOMANDA, traccia).at(-1)?.bozza).toBeUndefined();
    const stato = ricostruisciConversazione(eventiDaTraccia('c1', DOMANDA, traccia))!;
    expect(stato.messaggi.at(-1)?.bozza).toEqual({ titolo: 'Atto', contenuto: 'Testo' });
  });
});

describe('rilettura del log (dopo un riavvio, o un telefono che si collega dopo)', () => {
  it.each([
    ['risposta normale', RISPOSTA_NORMALE],
    ['bozza', CON_BOZZA],
    ['errore a metà', ERRORE_A_META],
  ])('%s: senza gli eventi transitori si arriva allo stesso stato', (_n, traccia) => {
    const tutti = eventiDaTraccia('c1', DOMANDA, traccia);
    const dalVivo = ricostruisciConversazione(tutti)!;
    const dalLog = ricostruisciConversazione(soloPersistiti(tutti))!;
    expect(dalLog.messaggi).toEqual(dalVivo.messaggi);
    expect(dalLog.stato).toBe(dalVivo.stato);
    expect(dalLog.ultimoSeq).toBe(dalVivo.ultimoSeq);
  });

  it('applicare due volte gli stessi eventi non cambia niente (riconnessione con sovrapposizione)', () => {
    const eventi = soloPersistiti(eventiDaTraccia('c1', DOMANDA, RISPOSTA_NORMALE));
    const una = ricostruisciConversazione(eventi)!;
    let due: ProiezioneConversazione | null = una;
    for (const e of eventi) due = riduciConversazione(due, e);
    expect(due).toBe(una);
  });
});

describe('dettagli del turno', () => {
  const eventi = eventiDaTraccia('c1', DOMANDA, RISPOSTA_NORMALE);
  const finoA = (n: number) => ricostruisciConversazione(eventi.slice(0, n))!;

  it('durante lo streaming la risposta in corso è visibile e "Sto…" sparisce', () => {
    // creata, domanda, turno, attività, delta
    const s = finoA(5);
    expect(s.stato).toBe('in_corso');
    expect(s.turno?.attivita).toBeNull();
    expect(messaggiVisibili(s).at(-1)).toMatchObject({ ruolo: 'assistente', testo: 'Leggo i documenti. ', isStreaming: true });
    expect(s.messaggi).toHaveLength(1);
  });

  it("l'attività compare finché non arriva testo", () => {
    const s = finoA(4);
    expect(s.turno?.attivita).toBe('Sto leggendo un documento della pratica…');
    expect(messaggiVisibili(s)).toHaveLength(1);
  });

  it('a fine turno: titolo dalla domanda, stato completata, costo sommato', () => {
    const s = ricostruisciConversazione(eventi)!;
    expect(s.titolo).toBe(DOMANDA.slice(0, 60));
    expect(s.stato).toBe('completata');
    expect(s.turno).toBeNull();
    expect(s.costoUsd).toBeCloseTo(0.12);
  });

  it('eventi di altre conversazioni o di un turno vecchio non toccano lo stato', () => {
    const s = ricostruisciConversazione(eventi)!;
    const estraneo = { ...eventi[1], conversazioneId: 'altra', seq: 999 } as Evento;
    expect(riduciConversazione(s, estraneo)).toBe(s);
    const deltaVecchio: Evento = {
      tipo: 'testo_delta',
      seq: null,
      creatoIl: 'x',
      conversazioneId: 'c1',
      payload: { turnoId: 't1', testo: 'ritardatario' },
    };
    expect(riduciConversazione(s, deltaVecchio)).toBe(s);
  });

  it('prima di conversazione_creata non esiste niente', () => {
    expect(riduciConversazione(null, eventi[1])).toBeNull();
  });
});

describe('conferme (Approva / Rifiuta)', () => {
  const base = soloPersistiti(eventiDaTraccia('c1', DOMANDA, [])).slice(0, 3);
  const richiesta: Evento = {
    tipo: 'conferma_richiesta',
    seq: 10,
    creatoIl: 'x',
    conversazioneId: 'c1',
    payload: { confermaId: 'k1', turnoId: 't1', livello: 'conferma', titolo: 'Salvare la bozza?' },
  };
  const risposta: Evento = {
    tipo: 'conferma_risposta',
    seq: 11,
    creatoIl: 'y',
    conversazioneId: 'c1',
    dispositivoId: 'iphone-giulia',
    payload: { confermaId: 'k1', esito: 'approvata' },
  };

  it('la richiesta mette la conversazione in attesa, la risposta la fa ripartire', () => {
    const inAttesa = ricostruisciConversazione([...base, richiesta])!;
    expect(inAttesa.stato).toBe('attesa');
    expect(inAttesa.conferme).toHaveLength(1);
    const ripartita = riduciConversazione(inAttesa, risposta)!;
    expect(ripartita.stato).toBe('in_corso');
    expect(ripartita.conferme).toHaveLength(0);
  });
});

describe('Studio digitale', () => {
  it("l'articolo dà il titolo, va nell'editor e nel messaggio finale", () => {
    const articolo = {
      titolo: 'Assegno di mantenimento: cosa cambia',
      slug: 'assegno-mantenimento',
      metaTitolo: 'Assegno di mantenimento',
      metaDescrizione: 'Cosa cambia nel 2026',
      categorie: ['Famiglia'],
      contenuto: '## Testo',
    };
    let seq = 0;
    const ev = (e: Record<string, unknown>) => ({ seq: ++seq, creatoIl: 'x', conversazioneId: 's1', ...e }) as Evento;
    const stato = ricostruisciConversazione([
      ev({ tipo: 'conversazione_creata', payload: { modalita: 'studio-digitale', praticaId: null, titolo: '', procedura: null, qualita: 'Standard' } }),
      ev({ tipo: 'messaggio_utente', payload: { messaggioId: 'm1', testo: 'Scrivi un articolo sul mantenimento' } }),
      ev({ tipo: 'turno_iniziato', payload: { turnoId: 't1', qualita: 'Standard' } }),
      ev({ tipo: 'articolo', payload: { turnoId: 't1', articolo } }),
      ev({ tipo: 'testo_assistente', payload: { turnoId: 't1', messaggioId: 'm2', testo: 'Ecco la bozza.' } }),
      ev({ tipo: 'turno_finito', payload: { turnoId: 't1', esito: 'ok' } }),
    ])!;
    expect(stato.titolo).toBe(articolo.titolo);
    expect(stato.articolo).toEqual(articolo);
    expect(stato.messaggi.at(-1)?.articolo).toEqual(articolo);
  });
});

describe('riduciElenco', () => {
  it('segue stato e titolo e toglie le conversazioni eliminate', () => {
    const eventi = eventiDaTraccia('c1', DOMANDA, RISPOSTA_NORMALE);
    let elenco = ELENCO_VUOTO;
    for (const e of eventi.slice(0, 4)) elenco = riduciElenco(elenco, e);
    expect(elenco.conversazioni.c1).toMatchObject({
      stato: 'in_corso',
      attivita: 'Sto leggendo un documento della pratica…',
      titolo: DOMANDA.slice(0, 60),
    });

    for (const e of eventi.slice(4)) elenco = riduciElenco(elenco, e);
    expect(elenco.conversazioni.c1).toMatchObject({ stato: 'completata', attivita: null, turnoId: null });
    expect(elenco.ultimoSeq).toBe(Math.max(...eventi.map((e) => e.seq ?? 0)));

    elenco = riduciElenco(elenco, {
      tipo: 'conversazione_eliminata',
      seq: 100,
      creatoIl: 'x',
      conversazioneId: 'c1',
      payload: {},
    });
    expect(elenco.conversazioni.c1).toBeUndefined();
  });
});

describe('schemi del protocollo', () => {
  it('ogni evento generato passa la validazione', () => {
    for (const e of eventiDaTraccia('c1', DOMANDA, [...RISPOSTA_NORMALE.slice(0, -1), ...CON_BOZZA])) {
      expect(eventoSchema.safeParse(e).success).toBe(true);
    }
  });

  it('busta di un comando valida; tipo sconosciuto o versione diversa rifiutati', () => {
    const comando = {
      comandoId: 'cmd-1',
      tipo: 'conversazione.invia',
      argomenti: { conversazioneId: 'c1', testo: 'Ciao', qualita: 'Standard' },
    };
    expect(comandoSchema.safeParse(comando).success).toBe(true);
    expect(bustaSchema.safeParse({ v: 1, tipo: 'comando', id: 'r1', comando }).success).toBe(true);
    expect(bustaSchema.safeParse({ v: 2, tipo: 'comando', id: 'r1', comando }).success).toBe(false);
    expect(comandoSchema.safeParse({ ...comando, tipo: 'conversazione.cancellaTutto' }).success).toBe(false);
    expect(comandoSchema.safeParse({ ...comando, argomenti: { ...comando.argomenti, testo: '' } }).success).toBe(false);
  });

  it('solo testo_delta e lavori sono transitori', () => {
    expect(eTransitorio('testo_delta')).toBe(true);
    expect(eTransitorio('lavori')).toBe(true);
    expect(eTransitorio('testo_assistente')).toBe(false);
    expect(eTransitorio('attivita')).toBe(false);
  });
});
