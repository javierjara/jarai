import { describe, expect, it } from 'vitest';
import type { Comando, Evento } from '../../shared/protocollo';
import { messaggiVisibili, ricostruisciConversazione, riduciConversazione, type ProiezioneConversazione } from '../../shared/reducer';
import { apriDatabase } from '../db';
import { EventStore } from '../eventStore';
import { Host, MESSAGGI, type EventoMotore, type Motore, type RichiestaMotore } from '../host';

/** Agente finto: il test decide cosa emette e quando finisce. */
class MotoreFinto implements Motore {
  richieste: RichiestaMotore[] = [];
  fermate: string[] = [];
  private turni = new Map<string, { emetti: (e: EventoMotore) => void; fine: () => void; errore: (e: unknown) => void }>();

  esegui(r: RichiestaMotore, emetti: (e: EventoMotore) => void): Promise<void> {
    this.richieste.push(r);
    return new Promise((fine, errore) => this.turni.set(r.conversazioneId, { emetti, fine: () => fine(), errore }));
  }
  ferma(id: string): void {
    this.fermate.push(id);
  }
  emetti(id: string, ...eventi: EventoMotore[]): void {
    for (const e of eventi) this.turni.get(id)!.emetti(e);
  }
  finisci(id: string): Promise<void> {
    this.turni.get(id)!.fine();
    return attesa();
  }
  esplodi(id: string): Promise<void> {
    this.turni.get(id)!.errore(new Error('processo claude terminato'));
    return attesa();
  }
}

const attesa = () => new Promise<void>((r) => setTimeout(r, 0));

let avvii = 0;
function prepara(db = apriDatabase(':memory:')) {
  // Id diversi a ogni avvio, come gli UUID veri.
  const avvio = ++avvii;
  let n = 0;
  const motore = new MotoreFinto();
  const errori: string[] = [];
  const host = new Host(db, motore, {
    nuovoId: () => `a${avvio}-id${++n}`,
    orologio: () => '2026-11-06T10:00:00.000Z',
    registraErrore: (c) => errori.push(c),
  });
  const ricevuti: Evento[] = [];
  host.abbona((e) => ricevuti.push(e));
  let k = 0;
  const comando = (c: Omit<Comando, 'comandoId'> & { comandoId?: string }) =>
    host.esegui({ comandoId: `a${avvio}-cmd${++k}`, ...c } as Comando, { dispositivoId: 'mac' });
  const crea = (id = 'c1', praticaId: string | null = 'p1') =>
    comando({
      tipo: 'conversazione.crea',
      argomenti: { conversazioneId: id, modalita: 'pratica', praticaId, titolo: '', procedura: 'Analisi & Redazione', qualita: 'Standard' },
    });
  const invia = (testo: string, id = 'c1', comandoId?: string) =>
    comando({ tipo: 'conversazione.invia', ...(comandoId ? { comandoId } : {}), argomenti: { conversazioneId: id, testo, qualita: 'Standard' } });
  return { db, host, motore, ricevuti, comando, crea, invia, errori };
}

/** Come farà la finestra: proiezione tenuta aggiornata con gli eventi ricevuti. */
function vista(ricevuti: Evento[], id = 'c1'): ProiezioneConversazione {
  let s: ProiezioneConversazione | null = null;
  for (const e of ricevuti) s = riduciConversazione(s, e);
  expect(s?.id).toBe(id);
  return s!;
}

describe('Host: una domanda e la sua risposta', () => {
  it('crea, invia, streaming, risposta: client e log arrivano allo stesso stato', async () => {
    const { host, motore, ricevuti, crea, invia, db } = prepara();
    expect(await crea()).toMatchObject({ ok: true });
    expect(await invia('Quali scadenze?')).toMatchObject({ ok: true });
    expect(motore.richieste[0]).toMatchObject({ conversazioneId: 'c1', testo: 'Quali scadenze?', praticaId: 'p1', modalita: 'pratica' });
    expect(motore.richieste[0].resume).toBeUndefined();

    motore.emetti('c1', { tipo: 'attivita', testo: 'Sto leggendo…' }, { tipo: 'delta', testo: 'Le scadenze ' });
    // A metà risposta: il client vede il testo in arrivo, l'host anche nello snapshot.
    expect(messaggiVisibili(vista(ricevuti)).at(-1)).toMatchObject({ testo: 'Le scadenze ', isStreaming: true });
    expect(host.conversazione('c1')!.turno?.testoParziale).toBe('Le scadenze ');

    motore.emetti(
      'c1',
      { tipo: 'delta', testo: 'sono tre.' },
      { tipo: 'sessione', sessionId: 'sess-1' },
      { tipo: 'completato', testo: 'Le scadenze sono tre.', costoUsd: 0.3 },
    );
    await motore.finisci('c1');

    const finale = vista(ricevuti);
    expect(finale.stato).toBe('completata');
    expect(finale.messaggi.map((m) => [m.ruolo, m.testo])).toEqual([
      ['avvocato', 'Quali scadenze?'],
      ['assistente', 'Le scadenze sono tre.'],
    ]);
    expect(finale.messaggi[0].dispositivoId).toBe('mac');
    // Il log da solo (dopo un riavvio, o un telefono che arriva dopo) dà lo stesso risultato.
    const dalLog = ricostruisciConversazione(new EventStore(db).perConversazione('c1'))!;
    expect(dalLog.messaggi).toEqual(finale.messaggi);
    expect(host.conversazione('c1')!.messaggi).toEqual(finale.messaggi);
    // I delta non sono nel log.
    expect(new EventStore(db).perConversazione('c1').some((e) => e.tipo === 'testo_delta')).toBe(false);
  });

  it('la domanda successiva riprende la sessione salvata (resume)', async () => {
    const { motore, crea, invia } = prepara();
    await crea();
    await invia('Prima');
    motore.emetti('c1', { tipo: 'sessione', sessionId: 'sess-42' }, { tipo: 'completato', testo: 'ok' });
    await motore.finisci('c1');
    await invia('Seconda');
    expect(motore.richieste[1].resume).toBe('sess-42');
  });

  it('la sessione resta anche dopo un riavvio dell’host', async () => {
    const { db, motore, crea, invia } = prepara();
    await crea();
    await invia('Prima');
    motore.emetti('c1', { tipo: 'sessione', sessionId: 'sess-7' }, { tipo: 'completato', testo: 'ok' });
    await motore.finisci('c1');

    const dopo = prepara(db);
    await dopo.invia('Dopo il riavvio');
    expect(dopo.motore.richieste[0].resume).toBe('sess-7');
  });

  it('una bozza arriva agganciata alla risposta', async () => {
    const { motore, ricevuti, crea, invia } = prepara();
    await crea();
    await invia('Prepara la comparsa');
    motore.emetti('c1', { tipo: 'bozza', titolo: 'Comparsa', contenuto: '# Testo' }, { tipo: 'completato', testo: 'Fatto.' });
    await motore.finisci('c1');
    expect(vista(ricevuti).messaggi.at(-1)?.bozza).toEqual({ titolo: 'Comparsa', contenuto: '# Testo' });
  });
});

describe('Host: errori, interruzioni, regole', () => {
  it('errore a metà: un messaggio con parziale e motivo, anche rileggendo il log', async () => {
    const { motore, ricevuti, crea, invia, db } = prepara();
    await crea();
    await invia('Domanda');
    motore.emetti('c1', { tipo: 'delta', testo: 'Inizio' }, { tipo: 'errore', messaggio: 'Non riesco a raggiungere Claude.' });
    await motore.finisci('c1');
    const atteso = 'Inizio\n\n⚠ Non riesco a raggiungere Claude.';
    expect(vista(ricevuti).messaggi.at(-1)?.testo).toBe(atteso);
    expect(ricostruisciConversazione(new EventStore(db).perConversazione('c1'))!.messaggi.at(-1)?.testo).toBe(atteso);
    expect(vista(ricevuti).stato).toBe('interrotta');
  });

  it("errore grezzo del CLI arrivato in streaming: non viene mostrato", async () => {
    const { motore, ricevuti, crea, invia } = prepara();
    await crea();
    await invia('Domanda');
    motore.emetti(
      'c1',
      { tipo: 'delta', testo: 'Not logged in · Please run /login' },
      { tipo: 'errore', messaggio: 'Non risulta un accesso a Claude attivo.', scartaParziale: true },
    );
    await motore.finisci('c1');
    expect(vista(ricevuti).messaggi.at(-1)?.testo).toBe('Non risulta un accesso a Claude attivo.');
  });

  it('ferma: il motore viene fermato e il turno si chiude come interrotto', async () => {
    const { motore, ricevuti, crea, invia, comando } = prepara();
    await crea();
    await invia('Domanda lunga');
    motore.emetti('c1', { tipo: 'delta', testo: 'Sto' });
    await comando({ tipo: 'conversazione.ferma', argomenti: { conversazioneId: 'c1' } });
    expect(motore.fermate).toEqual(['c1']);
    motore.emetti('c1', { tipo: 'errore', messaggio: 'Richiesta interrotta.' });
    await motore.finisci('c1');
    const fine = ricevuti.find((e) => e.tipo === 'turno_finito');
    expect(fine).toMatchObject({ payload: { esito: 'interrotto', testoParziale: 'Sto' } });
  });

  it('se il motore si rompe senza esito, il turno non resta aperto', async () => {
    const { motore, ricevuti, crea, invia, errori } = prepara();
    await crea();
    await invia('Domanda');
    await motore.esplodi('c1');
    expect(vista(ricevuti).turno).toBeNull();
    expect(vista(ricevuti).messaggi.at(-1)?.testo).toBe(MESSAGGI.senzaEsito);
    expect(errori).toContain('motore');
  });

  it('non accetta una seconda domanda mentre risponde', async () => {
    const { crea, invia } = prepara();
    await crea();
    await invia('Prima');
    expect(await invia('Seconda')).toEqual({ ok: false, errore: MESSAGGI.occupata });
  });

  it('lo stesso comando rimandato non manda una seconda domanda', async () => {
    const { motore, crea, invia } = prepara();
    await crea();
    await invia('Una volta', 'c1', 'cmd-uguale');
    expect(await invia('Una volta', 'c1', 'cmd-uguale')).toMatchObject({ ok: true });
    expect(motore.richieste).toHaveLength(1);
  });

  it('conversazione inesistente o eliminata', async () => {
    const { host, crea, invia, comando } = prepara();
    expect(await invia('?', 'nessuna')).toEqual({ ok: false, errore: MESSAGGI.nonTrovata });
    await crea();
    await comando({ tipo: 'conversazione.elimina', argomenti: { conversazioneId: 'c1' } });
    expect(host.conversazione('c1')).toBeNull();
    expect((host.richiedi({ tipo: 'snapshot.elenco' }) as { elenco: { conversazioni: object } }).elenco.conversazioni).toEqual({});
    expect(await invia('?')).toEqual({ ok: false, errore: MESSAGGI.nonTrovata });
  });

  it('app chiusa a metà risposta: al riavvio il turno viene chiuso', async () => {
    const { db, motore, crea, invia } = prepara();
    await crea();
    await invia('Domanda');
    motore.emetti('c1', { tipo: 'attivita', testo: 'Sto leggendo…' });
    // Niente fine: l'app "si chiude" qui. Nuovo host sullo stesso database.
    const dopo = prepara(db);
    const c = dopo.host.conversazione('c1')!;
    expect(c.turno).toBeNull();
    expect(c.stato).toBe('interrotta');
    expect(c.messaggi.at(-1)?.testo).toBe(MESSAGGI.chiusuraApp);
    expect(await dopo.invia('Riprovo')).toMatchObject({ ok: true });
  });
});

describe('Host: busta e riconnessione', () => {
  it('gestisciBusta: comando, richiesta, busta non valida', async () => {
    const { host, crea } = prepara();
    await crea();
    const r = await host.gestisciBusta({ v: 1, tipo: 'richiesta', id: 'r1', richiesta: { tipo: 'snapshot.conversazione', conversazioneId: 'c1' } });
    expect(r).toMatchObject({ tipo: 'risposta', id: 'r1', esito: { ok: true, dati: { conversazione: { id: 'c1' } } } });
    const male = await host.gestisciBusta({ v: 1, tipo: 'comando', id: 'r2', comando: { tipo: 'formatta-disco' } });
    expect(male).toMatchObject({ id: 'r2', esito: { ok: false } });
  });

  it('eventi.dopo: un client che si ricollega recupera quello che ha perso', async () => {
    const { host, motore, crea, invia } = prepara();
    await crea();
    const { elenco } = host.richiedi({ tipo: 'snapshot.elenco' }) as { elenco: { ultimoSeq: number } };
    await invia('Domanda');
    motore.emetti('c1', { tipo: 'completato', testo: 'Risposta' });
    await motore.finisci('c1');
    const { eventi } = host.richiedi({ tipo: 'eventi.dopo', seq: elenco.ultimoSeq, limite: 100 }) as { eventi: Evento[] };
    expect(eventi.map((e) => e.tipo)).toEqual(['messaggio_utente', 'turno_iniziato', 'testo_assistente', 'turno_finito']);
  });
});
