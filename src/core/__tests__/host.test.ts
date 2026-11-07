import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Comando, Evento } from '../../shared/protocollo';
import { messaggiVisibili, ricostruisciConversazione, riduciConversazione, type ProiezioneConversazione } from '../../shared/reducer';
import { apriDatabase } from '../db';
import { EventStore } from '../eventStore';
import type { SnapshotEntita } from '../entita';
import { Host, MESSAGGI, PEZZO_DOCUMENTO } from '../host';
import { attesa, MotoreFinto } from './motoreFinto';
import { migraResto } from '../migrazioneJson';


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

  it('la procedura si può cambiare dopo il primo messaggio', async () => {
    const { host, crea, comando } = prepara();
    await crea();
    await comando({ tipo: 'conversazione.cambiaProcedura', argomenti: { conversazioneId: 'c1', procedura: 'Revisione contratto' } });
    expect(host.conversazione('c1')!.procedura).toBe('Revisione contratto');
    const { elenco } = host.richiedi({ tipo: 'snapshot.elenco' }) as { elenco: { conversazioni: Record<string, { procedura: string }> } };
    expect(elenco.conversazioni.c1.procedura).toBe('Revisione contratto');
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

describe('Host: entità (passo 5)', () => {
  const PRATICA = {
    id: 'p1',
    nome: 'Rossi c. Bianchi',
    cliente: 'Mario Rossi',
    ambito: 'Civile' as const,
    documenti: 1,
    aggiornataIl: '2026-11-06T10:00:00.000Z',
    cartellaPercorso: '/Pratiche/Rossi',
  };
  const DOC = { id: 'd1', nome: 'Citazione.pdf', tipo: 'pdf', data: '2026-09-01', cartella: 'Atti', percorso: '/Pratiche/Rossi/Citazione.pdf' };
  const entita = (host: Host) => (host.richiedi({ tipo: 'snapshot.entita' }) as { entita: SnapshotEntita | null }).entita;

  const migrato = () => {
    const db = apriDatabase(':memory:');
    migraResto(db, { pratiche: [], documenti: {}, conversazioni: [] });
    return prepara(db);
  };

  it('prima della migrazione: niente snapshot e niente scritture', async () => {
    const { host, comando } = prepara();
    expect(entita(host)).toBeNull();
    expect(await comando({ tipo: 'pratica.salva', argomenti: { pratica: PRATICA } })).toEqual({ ok: false, errore: MESSAGGI.datiNonPronti });
  });

  it('pratica, documenti, studio, idee: salvati e riletti, con un evento per ciascuno', async () => {
    const { host, comando, ricevuti } = migrato();
    await comando({ tipo: 'pratica.salva', argomenti: { pratica: PRATICA } });
    await comando({ tipo: 'documenti.salva', argomenti: { praticaId: 'p1', documenti: [DOC] } });
    await comando({ tipo: 'studio.salva', argomenti: { studio: { nome: 'Studio Prova', avvocato: 'Avv. Prova' } } });
    await comando({ tipo: 'idee.salva', argomenti: { idee: [{ id: 'i1', titolo: 'Idea', stato: 'da_valutare' }] } });
    await comando({ tipo: 'preferenzeSito.salva', argomenti: { preferenze: { obiettivoSettimana: 2 } } });

    const e = entita(host)!;
    expect(e.pratiche).toEqual([PRATICA]);
    expect(e.documenti).toEqual({ p1: [DOC] });
    expect(e.studio).toEqual({ nome: 'Studio Prova', avvocato: 'Avv. Prova' });
    expect(e.ideeSito).toEqual([{ id: 'i1', titolo: 'Idea', stato: 'da_valutare' }]);
    expect(e.preferenzeSito).toEqual({ obiettivoSettimana: 2 });
    expect(ricevuti.filter((x) => x.tipo === 'entita_cambiata').map((x) => (x.payload as { entita: string }).entita)).toEqual([
      'pratica',
      'documento',
      'studio',
      'idea',
      'preferenze',
    ]);
  });

  it("l'agente riceve i documenti della pratica da jarai.db", async () => {
    const { motore, comando, crea, invia } = migrato();
    await comando({ tipo: 'pratica.salva', argomenti: { pratica: PRATICA } });
    await comando({ tipo: 'documenti.salva', argomenti: { praticaId: 'p1', documenti: [DOC] } });
    await crea('c1', 'p1');
    await invia('Cosa dice la citazione?');
    expect(motore.richieste[0].documenti).toEqual([DOC]);
  });

  it('documenti di una pratica inesistente: rifiutati', async () => {
    const { comando } = migrato();
    expect(await comando({ tipo: 'documenti.salva', argomenti: { praticaId: 'nessuna', documenti: [DOC] } })).toEqual({
      ok: false,
      errore: MESSAGGI.praticaNonTrovata,
    });
  });

  it('eliminare una pratica toglie anche i suoi documenti', async () => {
    const { host, comando } = migrato();
    await comando({ tipo: 'pratica.salva', argomenti: { pratica: PRATICA } });
    await comando({ tipo: 'documenti.salva', argomenti: { praticaId: 'p1', documenti: [DOC] } });
    await comando({ tipo: 'pratica.elimina', argomenti: { praticaId: 'p1' } });
    expect(entita(host)).toMatchObject({ pratiche: [], documenti: {} });
  });

  it('Studio digitale: articolo creato dalla finestra, domanda, risposta e dati editoriali insieme', async () => {
    const { host, motore, comando, invia } = migrato();
    const dati = { id: 's1', titolo: 'Nuovo articolo', modificato: false, copertina: { file: 'c.png', alt: 'x', origine: 'foto' } };
    await comando({ tipo: 'conversazioneSito.salva', argomenti: { dati } });
    // La conversazione esiste già: l'invio la ritrova senza crearla.
    await invia('Scrivi un articolo sul mantenimento', 's1');
    expect(motore.richieste[0]).toMatchObject({ modalita: 'studio-digitale', praticaId: null, documenti: [] });
    motore.emetti('s1', { tipo: 'completato', testo: 'Ecco la bozza.' });
    await motore.finisci('s1');

    const sito = entita(host)!.studioDigitale;
    expect(sito).toHaveLength(1);
    expect(sito[0]).toMatchObject({ id: 's1', titolo: 'Nuovo articolo', copertina: { file: 'c.png' }, stato: 'completata' });
    expect(sito[0].messaggi.map((m) => m.testo)).toEqual(['Scrivi un articolo sul mantenimento', 'Ecco la bozza.']);

    await comando({ tipo: 'conversazioneSito.elimina', argomenti: { conversazioneId: 's1' } });
    expect(entita(host)!.studioDigitale).toEqual([]);
    expect(host.conversazione('s1')).toBeNull();
  });

  it('i dati editoriali non salvano messaggi e stato, anche se arrivano', async () => {
    const { host, comando, db } = migrato();
    await comando({
      tipo: 'conversazioneSito.salva',
      argomenti: { dati: { id: 's1', titolo: 'T', messaggi: [{ id: 'x', ruolo: 'avvocato', testo: 'fantasma' }], stato: 'in_corso' } },
    });
    const salvato = JSON.parse((db.prepare("SELECT dati FROM conversazione_sito WHERE id = 's1'").get() as { dati: string }).dati);
    expect(salvato).toEqual({ id: 's1', titolo: 'T' });
    expect(entita(host)!.studioDigitale[0].messaggi).toEqual([]);
  });
});

describe('bozza.esporta (file per il telefono)', () => {
  const richiesta = (formato: 'word' | 'pdf', titolo = 'Atto: Rossi / Bianchi') => ({
    v: 1,
    tipo: 'richiesta',
    id: 'r1',
    richiesta: { tipo: 'bozza.esporta', titolo, contenuto: '## Fatto\n\nTesto.', formato },
  });

  it('restituisce il file in base64 con un nome sicuro e il tipo giusto', async () => {
    const chiamate: string[] = [];
    const host = new Host(apriDatabase(':memory:'), new MotoreFinto(), {
      esportaBozza: async (b, formato) => {
        chiamate.push(`${formato}:${b.contenuto}`);
        return new Uint8Array([1, 2, 3]);
      },
    });
    const r = await host.gestisciBusta(richiesta('word'));
    expect(r).toMatchObject({
      tipo: 'risposta',
      id: 'r1',
      esito: {
        ok: true,
        dati: { nome: 'Atto Rossi Bianchi.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', base64: 'AQID' },
      },
    });
    const pdf = await host.gestisciBusta(richiesta('pdf', ''));
    expect(pdf).toMatchObject({ esito: { ok: true, dati: { nome: 'Bozza.pdf', mime: 'application/pdf' } } });
    expect(chiamate).toEqual(['word:## Fatto\n\nTesto.', 'pdf:## Fatto\n\nTesto.']);
  });

  it('senza esportatore, o se fallisce: errore leggibile', async () => {
    const senza = new Host(apriDatabase(':memory:'), new MotoreFinto());
    expect(await senza.gestisciBusta(richiesta('word'))).toMatchObject({ esito: { ok: false } });
    const rotto = new Host(apriDatabase(':memory:'), new MotoreFinto(), {
      esportaBozza: async () => {
        throw new Error('stampa');
      },
    });
    expect(await rotto.gestisciBusta(richiesta('pdf'))).toMatchObject({ esito: { ok: false, errore: 'Non sono riuscito a preparare il documento.' } });
  });
});

describe('documento.leggi (file delle pratiche per il telefono)', () => {
  const cartella = mkdtempSync(join(tmpdir(), 'jarai-doc-'));
  const contenuto = randomBytes(PEZZO_DOCUMENTO * 2 + 1234);
  writeFileSync(join(cartella, 'Contratto.pdf'), contenuto);

  const conPratica = (percorso: string | null, opzioni = {}) => {
    const db = apriDatabase(':memory:');
    migraResto(db, {
      pratiche: [{ id: 'p1', nome: 'Rossi c. Bianchi', cliente: 'Rossi', ambito: 'Civile', documenti: 1, aggiornataIl: '2026-11-07T10:00:00.000Z', cartellaPercorso: cartella }],
      documenti: { p1: [{ id: 'd1', nome: 'Contratto', tipo: 'PDF', data: '2026-03-03', cartella: 'Atti', ...(percorso ? { percorso } : {}) }] },
    } as never);
    return new Host(db, new MotoreFinto(), opzioni);
  };
  const leggi = (host: Host, da: number, documentoId = 'd1', praticaId = 'p1') =>
    host.gestisciBusta({ v: 1, tipo: 'richiesta', id: 'r', richiesta: { tipo: 'documento.leggi', praticaId, documentoId, da } }) as Promise<{
      esito: { ok: boolean; errore?: string; dati?: { nome: string; mime: string; dimensione: number; da: number; base64: string; fine: boolean } };
    }>;

  it('manda il file a pezzi e i pezzi ricompongono il file', async () => {
    const host = conPratica(join(cartella, 'Contratto.pdf'));
    const pezzi: Buffer[] = [];
    for (let da = 0, giri = 0; giri < 10; giri++) {
      const { esito } = await leggi(host, da);
      expect(esito.ok).toBe(true);
      const d = esito.dati!;
      expect(d).toMatchObject({ nome: 'Contratto.pdf', mime: 'application/pdf', dimensione: contenuto.length, da });
      const b = Buffer.from(d.base64, 'base64');
      expect(b.length).toBeLessThanOrEqual(PEZZO_DOCUMENTO);
      pezzi.push(b);
      da += b.length;
      if (d.fine) break;
    }
    expect(pezzi).toHaveLength(3);
    expect(Buffer.concat(pezzi).equals(contenuto)).toBe(true);
  });

  it('legge solo documenti registrati nella pratica, mai un percorso scelto dal client', async () => {
    const host = conPratica(join(cartella, 'Contratto.pdf'));
    expect((await leggi(host, 0, 'd1', 'altra')).esito).toEqual({ ok: false, errore: 'Questo documento non è più nella pratica.' });
    expect((await leggi(host, 0, '../../etc/passwd')).esito.ok).toBe(false);
    const forzata = await host.gestisciBusta({ v: 1, tipo: 'richiesta', id: 'r', richiesta: { tipo: 'documento.leggi', praticaId: 'p1', documentoId: 'd1', da: 0, percorso: '/etc/passwd' } });
    expect((forzata as { esito: { dati: { nome: string } } }).esito.dati.nome).toBe('Contratto.pdf');
  });

  it('spiega quando il file manca o non è mai stato collegato', async () => {
    expect((await leggi(conPratica(join(cartella, 'Spostato.pdf')), 0)).esito).toEqual({
      ok: false,
      errore: 'Il file non si trova più sul computer: forse è stato spostato o rinominato.',
    });
    expect((await leggi(conPratica(null), 0)).esito).toEqual({ ok: false, errore: 'Questo documento non ha un file sul computer.' });
  });

  it('su JarAI Server traduce il percorso del desktop nella cartella del server', async () => {
    const host = conPratica('C:\\Studio\\Rossi\\Contratto.pdf', { risolviPercorso: () => join(cartella, 'Contratto.pdf') });
    const { esito } = await leggi(host, contenuto.length - 10);
    expect(esito.dati).toMatchObject({ da: contenuto.length - 10, fine: true });
    expect(Buffer.from(esito.dati!.base64, 'base64').equals(contenuto.subarray(-10))).toBe(true);
  });
});

describe('snapshot.entita: numero di documenti', () => {
  it('conta i documenti registrati, non il contatore salvato sulla pratica', () => {
    const db = apriDatabase(':memory:');
    const doc = (id: string) => ({ id, nome: id, tipo: 'PDF', data: '2026-01-01', cartella: 'Atti' });
    migraResto(db, {
      pratiche: [
        { id: 'p1', nome: 'Paini', cliente: 'Da definire', ambito: 'Lavoro', documenti: 0, aggiornataIl: '2026-11-07T10:00:00.000Z', cartellaPercorso: null },
        { id: 'p2', nome: 'Vuota', cliente: 'X', ambito: 'Civile', documenti: 0, aggiornataIl: '2026-11-07T10:00:00.000Z', cartellaPercorso: null },
      ],
      documenti: { p1: [doc('a'), doc('b'), doc('c')] },
    } as never);
    const { entita } = new Host(db, new MotoreFinto()).richiedi({ tipo: 'snapshot.entita' }) as { entita: SnapshotEntita };
    expect(entita.pratiche.map((p) => [p.nome, p.documenti])).toEqual([
      ['Paini', 3],
      ['Vuota', 0],
    ]);
  });
});
