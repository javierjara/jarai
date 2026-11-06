import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ProiezioneConversazione } from '../../../../shared/reducer';
import { comando } from '../../host';
import type { ConversazioneSito, Idea, PreferenzeSito } from '../../types';

// Stato e automazioni dello Studio digitale, a livello di App: le risposte
// dell'assistente, le idee e le pubblicazioni programmate arrivano anche se
// l'avvocato è in un'altra sezione. Le idee si chiedono a Claude solo col
// pulsante "Proponi nuove idee": mai da sole, perché ogni richiesta costa.
//
// Dal passo 5 i messaggi degli articoli li tiene l'host (jarai.db): qui si
// mandano i comandi, si mostra il lavoro in corso e a fine risposta si
// rilegge la conversazione. La richiesta di idee resta una chiamata singola
// su claude:invia: non è una conversazione da conservare.

export interface StatoLavoro {
  elaborando: boolean;
  attivita: string | null;
  /** Testo in arrivo, non ancora salvato nella conversazione. */
  parziale: string;
}

export const PREFERENZE_SITO_DEFAULT: PreferenzeSito = { obiettivoSettimana: 1 };

const nuovoId = () => crypto.randomUUID();
const PREFISSO_IDEE = 'idee-';

interface Args {
  attivo: boolean;
  setConversazioni: Dispatch<SetStateAction<ConversazioneSito[]>>;
  setIdee: Dispatch<SetStateAction<Idea[]>>;
  setPreferenze: Dispatch<SetStateAction<PreferenzeSito>>;
}

export function useStudioDigitale({ attivo, setConversazioni, setIdee, setPreferenze }: Args) {
  const [lavori, setLavori] = useState<Record<string, StatoLavoro>>({});
  const [ideeInCorso, setIdeeInCorso] = useState<string | null>(null);
  const [erroreIdee, setErroreIdee] = useState<string | null>(null);
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

  // Richieste di idee: chiamata singola, eventi su claude:evento.
  useEffect(() => {
    return window.jarai.claude.onEvento((evento) => {
      if (!evento.conversazioneId.startsWith(PREFISSO_IDEE)) return;
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
    });
  }, [setIdee]);

  // Articoli: eventi dall'host.
  useEffect(() => {
    return window.jarai.host.onEvento((evento) => {
      const id = evento.conversazioneId;
      if (!id || !inCorso.current.has(id)) return;
      switch (evento.tipo) {
        case 'attivita':
          setLavoro(id, { attivita: evento.payload.testo });
          return;
        case 'testo_delta':
          parziali.current[id] = (parziali.current[id] ?? '') + evento.payload.testo;
          setLavoro(id, { attivita: null, parziale: parziali.current[id] });
          return;
        case 'articolo': {
          const { articolo } = evento.payload;
          // L'articolo compare subito nell'editor, prima della fine della risposta.
          aggiorna(id, (c) => ({ ...c, titolo: articolo.titolo, articolo, modificato: false, modificataIl: new Date().toISOString() }));
          return;
        }
        case 'turno_finito':
          inCorso.current.delete(id);
          delete parziali.current[id];
          setLavoro(id, { elaborando: false, attivita: null, parziale: '' });
          // Messaggi e stato dalla fonte di verità: compresa la risposta,
          // l'articolo agganciato e l'eventuale errore già composto.
          void window.jarai.host
            .busta({ v: 1, tipo: 'richiesta', id: nuovoId(), richiesta: { tipo: 'snapshot.conversazione', conversazioneId: id } })
            .then((r) => {
              const c = r.tipo === 'risposta' && r.esito.ok && 'dati' in r.esito ? (r.esito.dati as { conversazione: ProiezioneConversazione | null }).conversazione : null;
              if (c) aggiorna(id, (x) => ({ ...x, messaggi: c.messaggi, stato: c.stato, aggiornataIl: c.aggiornataIl }));
            });
          return;
      }
    });
  }, [aggiorna]);

  // testoVisibile resta nella conversazione; testoAgente (con l'articolo
  // modificato a mano, se serve) va all'assistente.
  const invia = useCallback(
    (id: string, testoVisibile: string, testoAgente: string, qualita: 'Standard' | 'Massima' = 'Standard') => {
      let titolo = 'Nuovo articolo';
      aggiorna(id, (c) => {
        titolo = c.articolo?.titolo ?? (c.messaggi.length ? c.titolo : testoVisibile.slice(0, 60));
        return {
          ...c,
          titolo,
          stato: 'in_corso',
          aggiornataIl: new Date().toISOString(),
          // Subito visibile; a fine risposta i messaggi arrivano dall'host.
          messaggi: [...c.messaggi, { id: nuovoId(), ruolo: 'avvocato', testo: testoVisibile }],
        };
      });
      parziali.current[id] = '';
      inCorso.current.add(id);
      setLavoro(id, { elaborando: true, attivita: 'Sto pensando…', parziale: '' });
      void (async () => {
        // Se l'articolo esiste già nell'host il comando non fa niente.
        const creata = await comando({
          tipo: 'conversazione.crea',
          argomenti: { conversazioneId: id, modalita: 'studio-digitale', praticaId: null, titolo, procedura: null, qualita },
        });
        const esito = creata.ok
          ? await comando({ tipo: 'conversazione.invia', argomenti: { conversazioneId: id, testo: testoVisibile, testoAgente, qualita } })
          : creata;
        if (!esito.ok) {
          inCorso.current.delete(id);
          setLavoro(id, { elaborando: false, attivita: null, parziale: '' });
          aggiorna(id, (c) => ({
            ...c,
            stato: 'interrotta',
            messaggi: [...c.messaggi, { id: nuovoId(), ruolo: 'assistente', testo: esito.errore }],
          }));
        }
      })();
    },
    [aggiorna],
  );

  const ferma = useCallback((id: string) => void comando({ tipo: 'conversazione.ferma', argomenti: { conversazioneId: id } }), []);

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
