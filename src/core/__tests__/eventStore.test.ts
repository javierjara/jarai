import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ricostruisciConversazione } from '../../shared/reducer';
import { apriDatabase, versioneSchema } from '../db';
import { EventStore, type EventoNuovo } from '../eventStore';
import { MIGRAZIONI } from '../migrazioni';

let cartelle: string[] = [];
afterEach(() => {
  for (const c of cartelle) rmSync(c, { recursive: true, force: true });
  cartelle = [];
});
const cartellaTemporanea = () => {
  const c = mkdtempSync(join(tmpdir(), 'jarai-test-'));
  cartelle.push(c);
  return c;
};

let orario = 0;
const orologio = () => `2026-11-06T10:00:${String(orario++ % 60).padStart(2, '0')}.000Z`;

const crea = (id: string): EventoNuovo => ({
  tipo: 'conversazione_creata',
  conversazioneId: id,
  payload: { modalita: 'pratica', praticaId: null, titolo: 'Prova', procedura: null, qualita: 'Standard' },
});
const domanda = (id: string, testo: string, messaggioId = `m-${testo}`): EventoNuovo => ({
  tipo: 'messaggio_utente',
  conversazioneId: id,
  dispositivoId: 'mac-studio',
  payload: { messaggioId, testo },
});

describe('database', () => {
  it('applica le migrazioni e si riapre senza rifarle', () => {
    const percorso = join(cartellaTemporanea(), 'jarai.db');
    const db = apriDatabase(percorso);
    expect(versioneSchema(db)).toBe(MIGRAZIONI.length);
    new EventStore(db, orologio).appendi([crea('c1')]);
    db.close();

    const riaperto = apriDatabase(percorso);
    expect(versioneSchema(riaperto)).toBe(MIGRAZIONI.length);
    expect(new EventStore(riaperto).ultimoSeq()).toBe(1);
    expect((riaperto.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    riaperto.close();
  });

  it('rifiuta un database creato da una versione più recente di JarAI', () => {
    const percorso = join(cartellaTemporanea(), 'jarai.db');
    const db = apriDatabase(percorso);
    db.exec(`PRAGMA user_version = ${MIGRAZIONI.length + 1}`);
    db.close();
    expect(() => apriDatabase(percorso)).toThrow(/più recente/);
  });
});

describe('EventStore', () => {
  const nuovo = () => new EventStore(apriDatabase(':memory:'), orologio);

  it('assegna seq crescenti e conserva tutti i campi', () => {
    const store = nuovo();
    const { eventi } = store.appendi([crea('c1'), domanda('c1', 'ciao')]);
    expect(eventi.map((e) => e.seq)).toEqual([1, 2]);
    expect(store.perConversazione('c1')).toEqual(eventi);
    expect(store.perConversazione('c1')[1]).toMatchObject({ dispositivoId: 'mac-studio', payload: { testo: 'ciao' } });
    expect(store.ultimoSeq()).toBe(2);
  });

  it('dopo(seq) restituisce solo gli eventi successivi, con limite', () => {
    const store = nuovo();
    store.appendi([crea('c1'), domanda('c1', 'a'), domanda('c1', 'b'), domanda('c1', 'c')]);
    expect(store.dopo(2).map((e) => e.seq)).toEqual([3, 4]);
    expect(store.dopo(0, 2).map((e) => e.seq)).toEqual([1, 2]);
    expect(store.dopo(4)).toEqual([]);
  });

  it('lo stesso comando rimandato non viene eseguito due volte', () => {
    const store = nuovo();
    store.appendi([crea('c1')]);
    const prima = store.appendi([domanda('c1', 'ciao')], { comandoId: 'cmd-1' });
    const seconda = store.appendi([domanda('c1', 'ciao')], { comandoId: 'cmd-1' });
    expect(prima.giaEseguito).toBe(false);
    expect(seconda.giaEseguito).toBe(true);
    expect(seconda.eventi).toEqual(prima.eventi);
    expect(store.perConversazione('c1')).toHaveLength(2);
  });

  it('un comando senza eventi viene comunque ricordato', () => {
    const store = nuovo();
    expect(store.appendi([], { comandoId: 'vuoto' })).toEqual({ eventi: [], giaEseguito: false });
    expect(store.appendi([crea('c1')], { comandoId: 'vuoto' })).toEqual({ eventi: [], giaEseguito: true });
  });

  it('tutto o niente: un evento non valido annulla anche quelli prima', () => {
    const store = nuovo();
    const nonValido = { tipo: 'messaggio_utente', conversazioneId: 'c1', payload: { testo: 'manca messaggioId' } } as unknown as EventoNuovo;
    expect(() => store.appendi([crea('c1'), nonValido], { comandoId: 'cmd-x' })).toThrow();
    expect(store.ultimoSeq()).toBe(0);
    // Il comando fallito non risulta eseguito: si può riprovare.
    expect(store.appendi([crea('c1')], { comandoId: 'cmd-x' }).giaEseguito).toBe(false);
  });

  it('gli eventi transitori non entrano nel log', () => {
    const store = nuovo();
    const delta: EventoNuovo = { tipo: 'testo_delta', conversazioneId: 'c1', payload: { turnoId: 't', testo: 'x' } };
    expect(() => store.appendi([delta])).toThrow(/transitorio/);
  });

  it('il log riletto dà la stessa conversazione', () => {
    const store = nuovo();
    store.appendi([
      crea('c1'),
      domanda('c1', 'Quali scadenze?', 'm1'),
      { tipo: 'turno_iniziato', conversazioneId: 'c1', payload: { turnoId: 't1', qualita: 'Massima' } },
      { tipo: 'testo_assistente', conversazioneId: 'c1', payload: { turnoId: 't1', messaggioId: 'm2', testo: 'Tre.' } },
      { tipo: 'turno_finito', conversazioneId: 'c1', payload: { turnoId: 't1', esito: 'ok', costoUsd: 0.5 } },
    ]);
    const c = ricostruisciConversazione(store.perConversazione('c1'))!;
    expect(c.messaggi.map((m) => [m.ruolo, m.testo])).toEqual([
      ['avvocato', 'Quali scadenze?'],
      ['assistente', 'Tre.'],
    ]);
    expect(c.costoUsd).toBe(0.5);
    expect(c.ultimoSeq).toBe(5);
  });
});
