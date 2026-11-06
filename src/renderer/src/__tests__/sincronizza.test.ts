import { describe, expect, it } from 'vitest';
import { differenze, type StatoEntita } from '../sincronizza';

const PRATICA = {
  id: 'p1',
  nome: 'Rossi',
  cliente: 'Mario Rossi',
  ambito: 'Civile' as const,
  documenti: 0,
  aggiornataIl: '2026-11-06',
  cartellaPercorso: '/x',
  cartellaTrovata: true,
};
const DOC = { id: 'd1', nome: 'a.pdf', tipo: 'pdf', data: '2026-01-01', cartella: '' };
const BASE: StatoEntita = {
  pratiche: [PRATICA],
  documenti: { p1: [] },
  studio: { nome: 'Studio', avvocato: '' },
  studioDigitale: [{ id: 's1', titolo: 'Art', stato: 'completata', aggiornataIl: 'x', messaggi: [] }],
  ideeSito: [],
  preferenzeSito: { obiettivoSettimana: 1 },
};

describe('differenze', () => {
  it('nessun cambiamento, nessun comando', () => {
    expect(differenze(BASE, BASE)).toEqual([]);
    expect(differenze(BASE, structuredClone(BASE))).toEqual([]);
  });

  it('cartellaTrovata non si salva', () => {
    expect(differenze(BASE, { ...BASE, pratiche: [{ ...PRATICA, cartellaTrovata: false }] })).toEqual([]);
  });

  it('nuova pratica con documenti: prima la pratica, poi i documenti', () => {
    const nuova = { ...PRATICA, id: 'p2', nome: 'Bianchi' };
    const dopo = { ...BASE, pratiche: [nuova, PRATICA], documenti: { ...BASE.documenti, p2: [DOC] } };
    expect(differenze(BASE, dopo).map((c) => c.tipo)).toEqual(['pratica.salva', 'documenti.salva']);
    expect(differenze(BASE, dopo)[0]).toEqual({ tipo: 'pratica.salva', argomenti: { pratica: { ...nuova, cartellaTrovata: undefined } } });
  });

  it('pratica eliminata: un solo comando, i suoi documenti non si risalvano', () => {
    const dopo = { ...BASE, pratiche: [], documenti: {} };
    expect(differenze(BASE, dopo)).toEqual([{ tipo: 'pratica.elimina', argomenti: { praticaId: 'p1' } }]);
  });

  it('studio, preferenze, idee', () => {
    const dopo = {
      ...BASE,
      studio: { nome: 'Studio Molfino', avvocato: '' },
      preferenzeSito: { obiettivoSettimana: 2 },
      ideeSito: [{ id: 'i1', titolo: 'x', categoria: 'c', motivo: 'm', tipo: 'google' as const, stato: 'da_valutare' as const, creataIl: 'x' }],
    };
    expect(differenze(BASE, dopo).map((c) => c.tipo)).toEqual(['studio.salva', 'preferenzeSito.salva', 'idee.salva']);
  });

  it('articolo: cambiano i dati editoriali → salva; cambiano solo i messaggi → niente', () => {
    const [art] = BASE.studioDigitale;
    expect(differenze(BASE, { ...BASE, studioDigitale: [{ ...art, messaggi: [{ id: 'm', ruolo: 'avvocato', testo: 'x' }], stato: 'in_corso' }] })).toEqual([]);
    const conCopertina = { ...art, copertina: { file: 'c.png', alt: '', origine: 'foto' as const } };
    const cmd = differenze(BASE, { ...BASE, studioDigitale: [conCopertina] });
    expect(cmd).toHaveLength(1);
    expect(cmd[0]).toMatchObject({ tipo: 'conversazioneSito.salva', argomenti: { dati: { id: 's1', copertina: { file: 'c.png' } } } });
    expect((cmd[0].argomenti as { dati: object }).dati).not.toHaveProperty('messaggi');
  });

  it('articolo eliminato', () => {
    expect(differenze(BASE, { ...BASE, studioDigitale: [] })).toEqual([
      { tipo: 'conversazioneSito.elimina', argomenti: { conversazioneId: 's1' } },
    ]);
  });
});
