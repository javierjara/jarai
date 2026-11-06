import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ricostruisciConversazione } from '../../shared/reducer';
import { apriDatabase } from '../db';
import { EventStore } from '../eventStore';
import {
  MIGRAZIONE_CONVERSAZIONI,
  MIGRAZIONE_RESTO,
  migraConversazioniPratica,
  migraDaJson,
  migraResto,
  migrazioneFatta,
  type DatiLegacy,
} from '../migrazioneJson';

const ARTICOLO = {
  titolo: 'Mantenimento dei figli maggiorenni',
  slug: 'mantenimento-figli-maggiorenni',
  metaTitolo: 'Mantenimento figli maggiorenni',
  metaDescrizione: 'Quando finisce l’obbligo',
  categorie: ['Famiglia'],
  contenuto: '## Testo\n\nCorpo',
  daVerificare: ['Cass. 2025'],
};

// Dati di prova che coprono i casi del vecchio formato: piano, fonti, bozza,
// conversazione interrotta, risposta rimasta in streaming, conversazione
// senza pratica, titolo diverso dalla prima domanda, Studio digitale.
const DATI: DatiLegacy = {
  pratiche: [
    {
      id: 'p1',
      nome: 'Rossi c. Bianchi',
      cliente: 'Mario Rossi',
      controparte: 'Bianchi srl',
      ambito: 'Civile',
      documenti: 2,
      aggiornataIl: '2026-10-01T09:00:00.000Z',
      cartellaPercorso: '/Users/avv/Pratiche/Rossi',
    },
  ],
  documenti: {
    p1: [
      { id: 'd1', nome: 'Citazione.pdf', tipo: 'pdf', pagine: 12, data: '2026-09-01', cartella: 'Atti', percorso: '/x/Citazione.pdf' },
      { id: 'd2', nome: 'Contratto.docx', tipo: 'docx', data: '2026-09-02', cartella: 'Documenti', dimensione: 2048 },
    ],
    // Orfano: la pratica non esiste più.
    p9: [{ id: 'd9', nome: 'Vecchio.pdf', tipo: 'pdf', data: '2025-01-01', cartella: '' }],
  },
  conversazioni: [
    {
      id: 'c-completa',
      praticaId: 'p1',
      titolo: 'Scadenze della causa',
      procedura: 'Analisi & Redazione',
      stato: 'completata',
      aggiornataIl: '2026-10-02T10:00:00.000Z',
      piano: [
        { id: 'p-1', testo: 'Lettura documenti', stato: 'completato' },
        { id: 'p-2', testo: 'Redazione', stato: 'completato' },
      ],
      messaggi: [
        { id: 'm1', ruolo: 'avvocato', testo: 'Quali sono le scadenze?' },
        { id: 'm2', ruolo: 'assistente', testo: 'Tre scadenze.', fonti: [{ documento: 'Citazione.pdf', pagina: 3 }] },
        { id: 'm3', ruolo: 'avvocato', testo: 'Prepara la comparsa' },
        { id: 'm4', ruolo: 'assistente', testo: 'Ecco la bozza.', bozza: { titolo: 'Comparsa', contenuto: '# Comparsa' } },
      ],
    },
    {
      id: 'c-interrotta',
      praticaId: 'senza-pratica',
      titolo: 'Domanda generica',
      procedura: 'Analisi & Redazione',
      stato: 'interrotta',
      aggiornataIl: '2026-10-03T10:00:00.000Z',
      messaggi: [
        { id: 'm1', ruolo: 'avvocato', testo: 'Cosa dice l’art. 2043?' },
        { id: 'm2', ruolo: 'assistente', testo: 'Non riesco a raggiungere Claude. Controlla la connessione e riprova.' },
      ],
    },
    {
      id: 'c-streaming',
      praticaId: 'p1',
      titolo: 'Risposta a metà',
      procedura: 'Cronologia dei fatti',
      stato: 'in_corso',
      aggiornataIl: '2026-09-30T10:00:00.000Z',
      messaggi: [
        { id: 'm1', ruolo: 'avvocato', testo: 'Fai la cronologia' },
        { id: 'm2', ruolo: 'assistente', testo: 'Il 3 marzo', isStreaming: true },
      ],
    },
    {
      id: 'c-solo-domanda',
      praticaId: 'p1',
      titolo: 'Senza risposta',
      procedura: 'Revisione contratto',
      stato: 'completata',
      aggiornataIl: '2026-10-04T10:00:00.000Z',
      messaggi: [{ id: 'm1', ruolo: 'avvocato', testo: 'Rivedi il contratto' }],
    },
  ],
  studio: { nome: 'Studio Legale Prova', avvocato: 'Avv. Prova' },
  studioDigitale: [
    {
      id: 's1',
      titolo: 'Titolo scelto a mano',
      stato: 'completata',
      aggiornataIl: '2026-10-05T10:00:00.000Z',
      articolo: { ...ARTICOLO, titolo: 'Versione modificata' },
      modificato: true,
      sito: { id: 42, stato: 'bozza', urlModifica: 'https://x/admin', urlPubblico: 'https://x/a', aggiornatoIl: '2026-10-05' },
      messaggi: [
        { id: 'm1', ruolo: 'avvocato', testo: 'Articolo sul mantenimento' },
        { id: 'm2', ruolo: 'assistente', testo: 'Ecco l’articolo.', articolo: ARTICOLO },
      ],
    },
  ],
  ideeSito: [{ id: 'i1', titolo: 'Idea', stato: 'da_valutare' }],
  preferenzeSito: { obiettivoSettimana: 2 },
};

const orologio = () => '2026-11-06T12:00:00.000Z';

describe('migraDaJson', () => {
  it('porta tutto in jarai.db e ogni conversazione si ricostruisce identica', () => {
    const db = apriDatabase(':memory:');
    const r = migraDaJson(db, DATI, { orologio });
    expect(r).toMatchObject({ pratiche: 1, documenti: 2, conversazioni: 4, conversazioniSito: 1, idee: 1 });

    const store = new EventStore(db);
    expect(store.ultimoSeq()).toBe(r.eventi);

    const completa = ricostruisciConversazione(store.perConversazione('c-completa'))!;
    expect(completa.stato).toBe('completata');
    expect(completa.praticaId).toBe('p1');
    expect(completa.piano).toHaveLength(2);
    expect(completa.messaggi[1].fonti).toEqual([{ documento: 'Citazione.pdf', pagina: 3 }]);
    expect(completa.messaggi[3].bozza).toEqual({ titolo: 'Comparsa', contenuto: '# Comparsa' });
    expect(completa.messaggi.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);

    const interrotta = ricostruisciConversazione(store.perConversazione('c-interrotta'))!;
    expect(interrotta.stato).toBe('interrotta');
    expect(interrotta.praticaId).toBeNull();
    expect(interrotta.messaggi[1].testo).toBe('Non riesco a raggiungere Claude. Controlla la connessione e riprova.');

    // Risposta rimasta in streaming: stesso testo, non più "in scrittura".
    const streaming = ricostruisciConversazione(store.perConversazione('c-streaming'))!;
    expect(streaming.stato).toBe('interrotta');
    expect(streaming.turno).toBeNull();
    expect(streaming.messaggi[1]).toMatchObject({ testo: 'Il 3 marzo' });
    expect(streaming.messaggi[1].isStreaming).toBeUndefined();

    const sito = ricostruisciConversazione(store.perConversazione('s1'))!;
    expect(sito.modalita).toBe('studio-digitale');
    expect(sito.titolo).toBe('Titolo scelto a mano');
    expect(sito.messaggi[1].articolo).toEqual(ARTICOLO);
    const editoriale = JSON.parse((db.prepare("SELECT dati FROM conversazione_sito WHERE id = 's1'").get() as { dati: string }).dati);
    expect(editoriale).toMatchObject({ modificato: true, sito: { id: 42 }, articolo: { titolo: 'Versione modificata' } });
    expect(editoriale.messaggi).toBeUndefined();

    const impostazioni = db.prepare("SELECT chiave FROM impostazione WHERE chiave NOT LIKE 'migrazione.%' ORDER BY chiave").all() as Array<{ chiave: string }>;
    expect(impostazioni.map((i) => i.chiave)).toEqual(['preferenzeSito', 'studio']);
    expect(migrazioneFatta(db, MIGRAZIONE_CONVERSAZIONI) && migrazioneFatta(db, MIGRAZIONE_RESTO)).toBe(true);
  });

  it('il seq segue l’ordine cronologico delle conversazioni', () => {
    const db = apriDatabase(':memory:');
    migraDaJson(db, DATI, { orologio });
    const ordine = db
      .prepare("SELECT conversazione_id FROM evento WHERE tipo = 'conversazione_creata' ORDER BY seq")
      .all() as Array<{ conversazione_id: string }>;
    // Prima le conversazioni delle pratiche (parte 1), poi lo Studio digitale (parte 2).
    expect(ordine.map((o) => o.conversazione_id)).toEqual(['c-streaming', 'c-completa', 'c-interrotta', 'c-solo-domanda', 's1']);
  });

  it('non si ripete su un database già pieno', () => {
    const db = apriDatabase(':memory:');
    migraDaJson(db, DATI, { orologio });
    expect(() => migraDaJson(db, DATI, { orologio })).toThrow(/già fatta/);
  });

  it('se una conversazione non torna, annulla tutto senza lasciare dati a metà', () => {
    const db = apriDatabase(':memory:');
    // Un campo che il protocollo non conosce viene scartato in scrittura:
    // la verifica se ne accorge e la migrazione si annulla.
    const conCampoIgnoto: DatiLegacy = {
      ...DATI,
      conversazioni: [
        ...DATI.conversazioni!,
        {
          id: 'c-strana',
          praticaId: 'p1',
          titolo: 'Strana',
          procedura: 'Analisi & Redazione',
          stato: 'completata',
          aggiornataIl: '2026-10-09T10:00:00.000Z',
          messaggi: [
            { id: 'm1', ruolo: 'avvocato', testo: 'x' },
            { id: 'm2', ruolo: 'assistente', testo: 'y', bozza: { titolo: 't', contenuto: 'c', extra: 1 } as never },
          ],
        },
      ],
    };
    expect(() => migraDaJson(db, conCampoIgnoto, { orologio })).toThrow(/c-strana non corrisponde.*bozza del messaggio 2/);
    const conteggi = db.prepare('SELECT (SELECT COUNT(*) FROM evento) e, (SELECT COUNT(*) FROM pratica) p').get();
    expect(conteggi).toEqual({ e: 0, p: 0 });
    // Niente segno "fatto": al prossimo avvio si riprova.
    expect(migrazioneFatta(db, MIGRAZIONE_CONVERSAZIONI)).toBe(false);
  });

  it('le due parti si possono fare in momenti diversi', () => {
    const db = apriDatabase(':memory:');
    expect(migraConversazioniPratica(db, DATI.conversazioni!, { orologio }).conversazioni).toBe(4);
    expect(migrazioneFatta(db, MIGRAZIONE_CONVERSAZIONI)).toBe(true);
    expect(migrazioneFatta(db, MIGRAZIONE_RESTO)).toBe(false);
    expect(() => migraConversazioniPratica(db, DATI.conversazioni!, { orologio })).toThrow(/già fatta/);
    expect(migraResto(db, DATI, { orologio })).toMatchObject({ pratiche: 1, conversazioniSito: 1 });
    expect(migrazioneFatta(db, MIGRAZIONE_RESTO)).toBe(true);
  });
});

// Prova sui dati reali, solo in locale e solo su richiesta:
//   JARAI_DATI_REALI=/percorso/copia/jarai-dati.json npm test
// Stampa solo conteggi: niente contenuto delle pratiche.
describe.runIf(process.env.JARAI_DATI_REALI)('dati reali', () => {
  it('migrano senza differenze', () => {
    const dati = JSON.parse(readFileSync(process.env.JARAI_DATI_REALI!, 'utf-8')) as DatiLegacy;
    const r = migraDaJson(apriDatabase(':memory:'), dati);
    console.log('Migrazione dati reali:', r);
    expect(r.conversazioni).toBe(dati.conversazioni?.length ?? 0);
  });
});
