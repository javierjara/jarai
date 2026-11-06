import { useState, type Dispatch, type SetStateAction } from 'react';
import type { Idea, TipoIdea } from '../../types';
import { dataBreve, daGiorno, giornoDi } from './util';

interface Props {
  idee: Idea[];
  setIdee: Dispatch<SetStateAction<Idea[]>>;
  inCorso: boolean;
  errore: string | null;
  onGenera: () => void;
  onScrivi: (idea: Idea) => void;
  onApriArticolo: (conversazioneId: string) => void;
}

type Filtro = Idea['stato'];

export const TIPI: Record<TipoIdea, { etichetta: string; classe: string }> = {
  google: { etichetta: '🔍 Ricerca Google senza articolo', classe: 'blue' },
  normativa: { etichetta: '⚖ Novità normativa', classe: 'amber' },
  stagionale: { etichetta: '↗ Tema stagionale', classe: 'green' },
  domande: { etichetta: '? Domanda frequente', classe: '' },
  aggiornamento: { etichetta: '↻ Da aggiornare', classe: 'blue' },
};

const FILTRI: { stato: Filtro; etichetta: string }[] = [
  { stato: 'da_valutare', etichetta: 'Da valutare' },
  { stato: 'pianificata', etichetta: 'Pianificate' },
  { stato: 'scritta', etichetta: 'Scritte' },
  { stato: 'scartata', etichetta: 'Scartate' },
];

export default function IdeeTab(p: Props) {
  const [filtro, setFiltro] = useState<Filtro>('da_valutare');
  const [pianifica, setPianifica] = useState<string | null>(null);
  const [giorno, setGiorno] = useState(() => giornoDi(new Date(Date.now() + 7 * 86_400_000)));
  const [nuova, setNuova] = useState('');

  const cambia = (id: string, patch: Partial<Idea>) => p.setIdee((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  const elenco = p.idee
    .filter((i) => i.stato === filtro)
    .sort((a, b) =>
      filtro === 'pianificata' ? (a.pianificataPer ?? '').localeCompare(b.pianificataPer ?? '') : b.creataIl.localeCompare(a.creataIl),
    );

  function aggiungi() {
    const titolo = nuova.trim();
    if (!titolo) return;
    p.setIdee((prev) => [
      { id: crypto.randomUUID(), titolo, categoria: '', motivo: 'Aggiunta da te.', tipo: 'domande', stato: 'da_valutare', creataIl: new Date().toISOString() },
      ...prev,
    ]);
    setNuova('');
    setFiltro('da_valutare');
  }

  return (
    <div className="sd-vista">
      <div className="sd-riga between">
        <button className="btn primary" onClick={p.onGenera} disabled={p.inCorso}>
          {p.inCorso ? '◌ JarAI sta cercando idee…' : '✦ Proponi nuove idee'}
        </button>
      </div>
      {p.errore && <div className="sd-errore-largo">{p.errore}</div>}

      <div className="sd-filtri">
        {FILTRI.map((f) => (
          <button key={f.stato} className={`sd-chip ${filtro === f.stato ? 'on' : ''}`} onClick={() => setFiltro(f.stato)}>
            {f.etichetta} · {p.idee.filter((i) => i.stato === f.stato).length}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <form
          className="sd-idea-nuova"
          onSubmit={(e) => {
            e.preventDefault();
            aggiungi();
          }}
        >
          <input value={nuova} onChange={(e) => setNuova(e.target.value)} placeholder="Aggiungi un'idea tua…" />
        </form>
      </div>

      <div className="sd-idee">
        {elenco.length === 0 && (
          <div className="sd-vuoto">
            {filtro === 'da_valutare'
              ? p.inCorso
                ? 'JarAI sta guardando il sito, le ricerche su Google e le novità normative…'
                : 'Nessuna idea da valutare. Premi «Proponi nuove idee».'
              : 'Niente qui.'}
          </div>
        )}
        {elenco.map((idea) => (
          <div key={idea.id} className={`sd-card sd-idea ${idea.stato === 'scartata' ? 'spenta' : ''}`}>
            <h3>{idea.titolo}</h3>
            <div className="meta">
              {idea.categoria && <span className="sd-chip statico">{idea.categoria}</span>}
              <span className={`sd-chip statico ${TIPI[idea.tipo].classe}`}>{TIPI[idea.tipo].etichetta}</span>
              {idea.pianificataPer && <span className="sd-chip statico blue">📅 {dataBreve(daGiorno(idea.pianificataPer).toISOString())}</span>}
            </div>
            <div className="why">
              {idea.motivo}
              {idea.fonte && (
                <>
                  {' '}
                  {/^https:\/\//.test(idea.fonte) && (
                    // Si apre nel browser (setWindowOpenHandler in src/main/index.ts).
                    <a className="btn-link" href={idea.fonte} target="_blank" rel="noreferrer" title={idea.fonte}>
                      Fonte ↗
                    </a>
                  )}
                </>
              )}
            </div>
            <div className="acts">
              {idea.stato === 'scritta' && idea.conversazioneId ? (
                <button className="btn sm" onClick={() => p.onApriArticolo(idea.conversazioneId!)}>Apri l'articolo</button>
              ) : idea.stato === 'scartata' ? (
                <button className="btn sm" onClick={() => cambia(idea.id, { stato: 'da_valutare' })}>Ripristina</button>
              ) : (
                <>
                  <button className="btn primary sm" onClick={() => p.onScrivi(idea)}>Scrivi</button>
                  {pianifica === idea.id ? (
                    <form
                      className="sd-pianifica"
                      onSubmit={(e) => {
                        e.preventDefault();
                        cambia(idea.id, { stato: 'pianificata', pianificataPer: giorno });
                        setPianifica(null);
                      }}
                    >
                      <input type="date" value={giorno} onChange={(e) => setGiorno(e.target.value)} />
                      <button className="btn sm" type="submit">OK</button>
                    </form>
                  ) : (
                    <button
                      className="btn sm"
                      onClick={() => {
                        setGiorno(idea.pianificataPer ?? giornoDi(new Date(Date.now() + 7 * 86_400_000)));
                        setPianifica(idea.id);
                      }}
                    >
                      {idea.stato === 'pianificata' ? 'Cambia data…' : 'Pianifica…'}
                    </button>
                  )}
                  {idea.stato === 'pianificata' ? (
                    <button className="btn ghost sm" onClick={() => cambia(idea.id, { stato: 'da_valutare', pianificataPer: undefined })}>
                      Togli dal calendario
                    </button>
                  ) : (
                    <button className="btn ghost sm" onClick={() => cambia(idea.id, { stato: 'scartata' })}>Scarta</button>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
