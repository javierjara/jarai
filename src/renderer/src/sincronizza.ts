import type { Comando } from '../../shared/protocollo';
import type { ConversazioneSito, Documento, Idea, Pratica, PreferenzeSito, Studio } from './types';

// Dalla finestra all'host (passo 5): le viste continuano a modificare lo
// stato React come prima, e invece di riscrivere tutto il JSON si mandano
// all'host solo i cambiamenti, come comandi. Funzione pura: stesso prima e
// dopo, stessi comandi.

type SenzaComandoId<T> = T extends unknown ? Omit<T, 'comandoId'> : never;
export type ComandoEntita = SenzaComandoId<Comando>;

export interface StatoEntita {
  pratiche: Pratica[];
  documenti: Record<string, Documento[]>;
  studio: Studio;
  studioDigitale: ConversazioneSito[];
  ideeSito: Idea[];
  preferenzeSito: PreferenzeSito;
}

const uguali = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Quello che della pratica si salva: cartellaTrovata si ricalcola a ogni avvio. */
function praticaDaSalvare({ cartellaTrovata: _c, ...p }: Pratica) {
  return p;
}

/** Dell'articolo si salvano i dati editoriali: messaggi e stato li tiene l'host. */
export function datiEditoriali({ messaggi: _m, stato: _s, ...dati }: ConversazioneSito) {
  return dati;
}

export function differenze(prima: StatoEntita, dopo: StatoEntita): ComandoEntita[] {
  const comandi: ComandoEntita[] = [];
  if (prima === dopo) return comandi;

  // Pratiche prima dei documenti (i documenti richiedono la pratica).
  const pratichePrima = new Map(prima.pratiche.map((p) => [p.id, p]));
  for (const p of dopo.pratiche) {
    const vecchia = pratichePrima.get(p.id);
    if (!vecchia || !uguali(praticaDaSalvare(vecchia), praticaDaSalvare(p))) {
      comandi.push({ tipo: 'pratica.salva', argomenti: { pratica: praticaDaSalvare(p) } });
    }
  }
  const idPraticheDopo = new Set(dopo.pratiche.map((p) => p.id));
  for (const p of prima.pratiche) {
    if (!idPraticheDopo.has(p.id)) comandi.push({ tipo: 'pratica.elimina', argomenti: { praticaId: p.id } });
  }

  if (prima.documenti !== dopo.documenti) {
    for (const [praticaId, documenti] of Object.entries(dopo.documenti)) {
      // Documenti di una pratica che non esiste (più): l'host li rifiuterebbe.
      if (!idPraticheDopo.has(praticaId)) continue;
      if (!uguali(prima.documenti[praticaId] ?? [], documenti)) {
        comandi.push({ tipo: 'documenti.salva', argomenti: { praticaId, documenti } });
      }
    }
  }

  if (!uguali(prima.studio, dopo.studio)) comandi.push({ tipo: 'studio.salva', argomenti: { studio: dopo.studio } });
  if (!uguali(prima.preferenzeSito, dopo.preferenzeSito)) {
    comandi.push({ tipo: 'preferenzeSito.salva', argomenti: { preferenze: { ...dopo.preferenzeSito } } });
  }
  if (!uguali(prima.ideeSito, dopo.ideeSito)) comandi.push({ tipo: 'idee.salva', argomenti: { idee: dopo.ideeSito.map((i) => ({ ...i })) } });

  if (prima.studioDigitale !== dopo.studioDigitale) {
    const sitoPrima = new Map(prima.studioDigitale.map((c) => [c.id, c]));
    for (const c of dopo.studioDigitale) {
      const vecchia = sitoPrima.get(c.id);
      if (!vecchia || !uguali(datiEditoriali(vecchia), datiEditoriali(c))) {
        comandi.push({ tipo: 'conversazioneSito.salva', argomenti: { dati: datiEditoriali(c) } });
      }
    }
    const idSitoDopo = new Set(dopo.studioDigitale.map((c) => c.id));
    for (const c of prima.studioDigitale) {
      if (!idSitoDopo.has(c.id)) comandi.push({ tipo: 'conversazioneSito.elimina', argomenti: { conversazioneId: c.id } });
    }
  }
  return comandi;
}
