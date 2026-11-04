import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { ConversazioneSito, Idea, PreferenzeSito } from '../types';
import ArticoloTab, { nuovoIdArticolo } from './studio/ArticoloTab';
import CalendarioTab from './studio/CalendarioTab';
import IdeeTab from './studio/IdeeTab';
import StatisticheTab from './studio/StatisticheTab';
import type { StudioDigitaleApi } from './studio/useStudioDigitale';

type ArticoloPubblicato = Extract<Awaited<ReturnType<typeof window.jarai.sito.elencoArticoli>>, { ok: true }>['dati'][number];
type Scheda = 'idee' | 'calendario' | 'articolo' | 'statistiche';

interface Props {
  conversazioni: ConversazioneSito[];
  setConversazioni: Dispatch<SetStateAction<ConversazioneSito[]>>;
  idee: Idea[];
  setIdee: Dispatch<SetStateAction<Idea[]>>;
  preferenze: PreferenzeSito;
  setPreferenze: Dispatch<SetStateAction<PreferenzeSito>>;
  api: StudioDigitaleApi;
  nomeStudio: string;
  onVaiImpostazioni: () => void;
}

// Studio digitale (spec §5.11): idee, calendario editoriale, articolo in
// lavorazione con anteprime social, statistiche. L'assistente qui non vede
// le pratiche (src/main/agentRunner.ts); nulla va online senza un clic.
export default function StudioDigitaleView(p: Props) {
  const [scheda, setScheda] = useState<Scheda>(() => (p.conversazioni.length ? 'articolo' : 'idee'));
  const [attivaId, setAttivaId] = useState<string | null>(p.conversazioni[0]?.id ?? null);
  const [sito, setSito] = useState<{ collegato: boolean | null; url: string | null }>({ collegato: null, url: null });
  const [articoliSito, setArticoliSito] = useState<ArticoloPubblicato[]>([]);

  useEffect(() => {
    void window.jarai.sito.stato().then((s) => {
      setSito({ collegato: s.collegato, url: s.url ?? null });
      if (s.collegato) void window.jarai.sito.elencoArticoli().then((e) => e.ok && setArticoliSito(e.dati));
    });
  }, []);

  // Un articolo pubblicato da JarAI entra nell'elenco del sito.
  const pubblicati = p.conversazioni.filter((c) => c.sito?.stato === 'pubblicato').length;
  useEffect(() => {
    if (sito.collegato) void window.jarai.sito.elencoArticoli(true).then((e) => e.ok && setArticoliSito(e.dati));
  }, [pubblicati, sito.collegato]);

  const apriArticolo = useCallback((id: string | null) => {
    setAttivaId(id);
    setScheda('articolo');
  }, []);
  const apriIdee = useCallback(() => setScheda('idee'), []);

  function scriviIdea(idea: Idea) {
    const id = nuovoIdArticolo();
    p.setIdee((prev) => prev.map((i) => (i.id === idea.id ? { ...i, stato: 'scritta', conversazioneId: id } : i)));
    if (idea.pianificataPer) p.api.aggiorna(id, (c) => ({ ...c, titolo: idea.titolo, dataPrevista: idea.pianificataPer }));
    const richiesta = [
      `Scrivi l'articolo per questa idea: «${idea.titolo}».`,
      idea.categoria && `Categoria: ${idea.categoria}.`,
      `Perché ora: ${idea.motivo}`,
      idea.fonte && `Fonte: ${idea.fonte}`,
    ]
      .filter(Boolean)
      .join('\n');
    p.api.invia(id, richiesta, richiesta);
    apriArticolo(id);
  }

  const daValutare = p.idee.filter((i) => i.stato === 'da_valutare').length;
  const dominio = sito.url?.replace(/^https?:\/\//, '');

  return (
    <div className="sd-pagina">
      <div className="sd-head">
        <div className="sd-head-top">
          <h1>Studio digitale</h1>
          {sito.collegato ? (
            <div className="sd-site-pill">
              {dominio}
              {articoliSito.length ? ` · ${articoliSito.length} articoli` : ''}
            </div>
          ) : (
            sito.collegato === false && (
              <button className="btn sm" onClick={p.onVaiImpostazioni}>Collega il sito</button>
            )
          )}
        </div>
        <div className="sd-tabs">
          <button className={scheda === 'idee' ? 'on' : ''} onClick={() => setScheda('idee')}>
            Idee {daValutare > 0 && <span className="n">{daValutare}</span>}
          </button>
          <button className={scheda === 'calendario' ? 'on' : ''} onClick={() => setScheda('calendario')}>Calendario</button>
          <button className={scheda === 'articolo' ? 'on' : ''} onClick={() => setScheda('articolo')}>Articolo in lavorazione</button>
          <button className={scheda === 'statistiche' ? 'on' : ''} onClick={() => setScheda('statistiche')}>Statistiche</button>
        </div>
      </div>

      <div className="sd-corpo">
        {scheda === 'idee' && (
          <IdeeTab
            idee={p.idee}
            setIdee={p.setIdee}
            preferenze={p.preferenze}
            setPreferenze={p.setPreferenze}
            inCorso={p.api.ideeInCorso}
            errore={p.api.erroreIdee}
            onGenera={() => p.api.generaIdee()}
            onScrivi={scriviIdea}
            onApriArticolo={apriArticolo}
          />
        )}
        {scheda === 'calendario' && (
          <CalendarioTab
            conversazioni={p.conversazioni}
            idee={p.idee}
            setIdee={p.setIdee}
            articoliSito={articoliSito}
            preferenze={p.preferenze}
            setPreferenze={p.setPreferenze}
            api={p.api}
            onApriArticolo={apriArticolo}
            onApriIdee={apriIdee}
          />
        )}
        {scheda === 'articolo' && (
          <ArticoloTab
            conversazioni={p.conversazioni}
            attivaId={attivaId}
            onApri={setAttivaId}
            api={p.api}
            sitoCollegato={sito.collegato}
            sitoUrl={sito.url}
            nomeStudio={p.nomeStudio}
            articoliSito={articoliSito}
            onElimina={(id) => p.setConversazioni((prev) => prev.filter((c) => c.id !== id))}
            onVaiImpostazioni={p.onVaiImpostazioni}
          />
        )}
        {scheda === 'statistiche' && (
          <StatisticheTab
            articoliSito={articoliSito}
            onNuovaIdea={(idea) =>
              p.setIdee((prev) => [{ ...idea, id: crypto.randomUUID(), stato: 'da_valutare', creataIl: new Date().toISOString() }, ...prev])
            }
          />
        )}
      </div>
    </div>
  );
}
