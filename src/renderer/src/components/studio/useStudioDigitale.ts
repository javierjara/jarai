import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Articolo, ConversazioneSito, Idea, Messaggio, PreferenzeSito } from '../../types';

// Stato e automazioni dello Studio digitale, a livello di App: le risposte
// dell'assistente, le idee del lunedì e le pubblicazioni programmate
// arrivano anche se l'avvocato è in un'altra sezione.

export interface StatoLavoro {
  elaborando: boolean;
  attivita: string | null;
  /** Testo in arrivo, non ancora salvato nella conversazione. */
  parziale: string;
}

export const PREFERENZE_SITO_DEFAULT: PreferenzeSito = { ideeLunedi: true, obiettivoSettimana: 1 };

const nuovoId = () => crypto.randomUUID();
const PREFISSO_IDEE = 'idee-';

// Lunedì di questa settimana alle 8:00 (ora locale).
function lunediOtto(ora = new Date()): Date {
  const d = new Date(ora);
  const giorno = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - giorno);
  d.setHours(8, 0, 0, 0);
  return d;
}

interface Args {
  attivo: boolean;
  setConversazioni: Dispatch<SetStateAction<ConversazioneSito[]>>;
  setIdee: Dispatch<SetStateAction<Idea[]>>;
  preferenze: PreferenzeSito;
  setPreferenze: Dispatch<SetStateAction<PreferenzeSito>>;
}

export function useStudioDigitale({ attivo, setConversazioni, setIdee, preferenze, setPreferenze }: Args) {
  const [lavori, setLavori] = useState<Record<string, StatoLavoro>>({});
  const [ideeInCorso, setIdeeInCorso] = useState<string | null>(null);
  const [erroreIdee, setErroreIdee] = useState<string | null>(null);
  const articoliInArrivo = useRef<Record<string, Articolo>>({});
  const parziali = useRef<Record<string, string>>({});
  // Conversazioni con una risposta in corso: solo i loro eventi interessano qui.
  const inCorso = useRef(new Set<string>());

  const aggiorna = useCallback(
    (id: string, cambia: (c: ConversazioneSito) => ConversazioneSito) => {
      setConversazioni((prev) => {
        const esistente = prev.find((c) => c.id === id);
        const base: ConversazioneSito = esistente ?? {
          id,
          titolo: 'Nuovo articolo',
          stato: 'in_corso',
          aggiornataIl: new Date().toISOString(),
          messaggi: [],
        };
        const nuova = cambia(base);
        return esistente ? prev.map((c) => (c.id === id ? nuova : c)) : [nuova, ...prev];
      });
    },
    [setConversazioni],
  );

  const setLavoro = (id: string, patch: Partial<StatoLavoro>) =>
    setLavori((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { elaborando: false, attivita: null, parziale: '' }), ...patch } }));

  // Eventi dell'assistente per le conversazioni dello Studio digitale e per
  // le richieste di idee.
  useEffect(() => {
    return window.jarai.claude.onEvento((evento) => {
      const id = evento.conversazioneId;
      if (id.startsWith(PREFISSO_IDEE)) {
        if (evento.tipo === 'idee') {
          const ora = new Date().toISOString();
          setIdee((prev) => [
            ...evento.idee.map((i) => ({ ...i, id: nuovoId(), stato: 'da_valutare' as const, creataIl: ora })),
            ...prev,
          ]);
        } else if (evento.tipo === 'completato' || evento.tipo === 'errore') {
          setIdeeInCorso(null);
          if (evento.tipo === 'errore') setErroreIdee(evento.messaggio);
        }
        return;
      }
      if (!inCorso.current.has(id)) return;

      if (evento.tipo === 'attivita') {
        setLavoro(id, { attivita: evento.testo });
        return;
      }
      if (evento.tipo === 'articolo') {
        articoliInArrivo.current[id] = evento.articolo;
        // L'articolo compare subito nell'editor, prima della fine della risposta.
        aggiorna(id, (c) => ({
          ...c,
          titolo: evento.articolo.titolo,
          articolo: evento.articolo,
          modificato: false,
          modificataIl: new Date().toISOString(),
        }));
        return;
      }
      if (evento.tipo === 'delta') {
        parziali.current[id] = (parziali.current[id] ?? '') + evento.testo;
        setLavoro(id, { attivita: null, parziale: parziali.current[id] });
        return;
      }
      if (evento.tipo !== 'completato' && evento.tipo !== 'errore') return;

      inCorso.current.delete(id);
      const articolo = articoliInArrivo.current[id];
      delete articoliInArrivo.current[id];
      const parziale = parziali.current[id] ?? '';
      delete parziali.current[id];
      setLavoro(id, { elaborando: false, attivita: null, parziale: '' });
      const testo = evento.tipo === 'completato' ? evento.testo : parziale ? `${parziale}\n\n${evento.messaggio}` : evento.messaggio;
      const messaggio: Messaggio = { id: nuovoId(), ruolo: 'assistente', testo, ...(articolo ? { articolo } : {}) };
      aggiorna(id, (c) => ({
        ...c,
        messaggi: [...c.messaggi, messaggio],
        stato: evento.tipo === 'completato' ? 'completata' : 'interrotta',
        aggiornataIl: new Date().toISOString(),
      }));
    });
  }, [aggiorna, setIdee]);

  // testoVisibile resta nella conversazione; testoAgente (con l'articolo
  // modificato a mano, se serve) va all'assistente.
  const invia = useCallback(
    (id: string, testoVisibile: string, testoAgente: string, qualita: 'Standard' | 'Massima' = 'Standard') => {
      aggiorna(id, (c) => ({
        ...c,
        titolo: c.articolo?.titolo ?? (c.messaggi.length ? c.titolo : testoVisibile.slice(0, 60)),
        stato: 'in_corso',
        aggiornataIl: new Date().toISOString(),
        messaggi: [...c.messaggi, { id: nuovoId(), ruolo: 'avvocato', testo: testoVisibile }],
      }));
      parziali.current[id] = '';
      inCorso.current.add(id);
      setLavoro(id, { elaborando: true, attivita: 'Sto pensando…', parziale: '' });
      void window.jarai.claude.invia({ conversazioneId: id, modalita: 'studio-digitale', testo: testoAgente, qualita });
    },
    [aggiorna],
  );

  const ferma = useCallback((id: string) => void window.jarai.claude.ferma(id), []);

  const generaIdee = useCallback(
    (richiesta = 'Proponimi tre idee di articoli per le prossime settimane.') => {
      if (ideeInCorso) return;
      const id = `${PREFISSO_IDEE}${nuovoId()}`;
      setIdeeInCorso(id);
      setErroreIdee(null);
      setPreferenze((p) => ({ ...p, ultimeIdeeIl: new Date().toISOString() }));
      void window.jarai.claude.invia({ conversazioneId: id, modalita: 'studio-digitale', testo: richiesta, qualita: 'Standard' });
    },
    [ideeInCorso, setPreferenze],
  );

  // Idee del lunedì: alla prima apertura dopo lunedì alle 8.
  const lunediControllato = useRef(false);
  useEffect(() => {
    if (!attivo || lunediControllato.current) return;
    lunediControllato.current = true;
    if (!preferenze.ideeLunedi) return;
    const soglia = lunediOtto();
    if (Date.now() < soglia.getTime()) return;
    if (preferenze.ultimeIdeeIl && Date.parse(preferenze.ultimeIdeeIl) >= soglia.getTime()) return;
    generaIdee();
  }, [attivo, preferenze.ideeLunedi, preferenze.ultimeIdeeIl, generaIdee]);

  // Pubblicazioni programmate eseguite dal main process.
  useEffect(() => {
    if (!attivo) return;
    const sincronizza = async () => {
      const [esiti, coda] = await Promise.all([window.jarai.sito.ritiraEsiti(), window.jarai.sito.programmate()]);
      const errori = new Map(coda.map((p) => [p.conversazioneId, p.ultimoErrore]));
      for (const e of esiti) {
        if (!e.esito) continue;
        const esito = e.esito;
        aggiorna(e.conversazioneId, (c) => ({
          ...c,
          programmataPer: undefined,
          ultimoErroreProgrammazione: undefined,
          sito: { id: esito.id, stato: 'pubblicato', urlModifica: esito.urlModifica, urlPubblico: esito.urlPubblico, aggiornatoIl: e.il },
        }));
      }
      setConversazioni((prev) =>
        prev.map((c) =>
          c.programmataPer && (errori.get(c.id) ?? undefined) !== c.ultimoErroreProgrammazione
            ? { ...c, ultimoErroreProgrammazione: errori.get(c.id) }
            : c,
        ),
      );
    };
    void sincronizza();
    return window.jarai.sito.onProgrammazione(() => void sincronizza());
  }, [attivo, aggiorna, setConversazioni]);

  return { lavori, invia, ferma, aggiorna, generaIdee, ideeInCorso: ideeInCorso !== null, erroreIdee };
}

export type StudioDigitaleApi = ReturnType<typeof useStudioDigitale>;
