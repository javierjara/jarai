import { useMemo, useState } from 'react';
import type { Conversazione, Pratica } from '../types';
import { PhoneIcon, SearchIcon } from './icons';

interface Props {
  conversazioni: Conversazione[];
  pratiche: Pratica[];
  onOpen: (c: Conversazione) => void;
  onDelete: (id: string) => void;
}

const STATO_LABEL: Record<Conversazione['stato'], string> = {
  in_corso: 'In corso',
  attesa: 'In attesa di conferma',
  completata: 'Completata',
  interrotta: 'Interrotta',
};

export default function StoricoView({ conversazioni, pratiche, onOpen, onDelete }: Props) {
  const [search, setSearch] = useState('');
  const [filtroPratica, setFiltroPratica] = useState<string>('all');
  const [soloAttesa, setSoloAttesa] = useState(false);
  // Stesso schema di doppia conferma della sidebar: un solo click apre solo
  // la domanda, mai la cancellazione diretta.
  const [confermaId, setConfermaId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return conversazioni
      .filter((c) => filtroPratica === 'all' || c.praticaId === filtroPratica)
      .filter((c) => !soloAttesa || c.stato === 'attesa')
      .filter((c) => !q || c.titolo.toLowerCase().includes(q))
      .sort((a, b) => (a.aggiornataIl < b.aggiornataIl ? 1 : -1));
  }, [conversazioni, filtroPratica, soloAttesa, search]);

  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });

  const nomePratica = (id: string) => pratiche.find((p) => p.id === id)?.nome ?? '';

  return (
    <div className="storico-view">
      <div className="page-head">
        <div>
          <h1>Storico</h1>
          <p>{conversazioni.length} conversazioni</p>
        </div>
      </div>

      <div className="storico-filters">
        <div className="search-wrap">
          <SearchIcon />
          <input className="s-input" placeholder="Cerca nello storico…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="mode-filter-tabs">
          <button className={`chip ${filtroPratica === 'all' ? 'active' : ''}`} onClick={() => setFiltroPratica('all')}>
            Tutte le pratiche
          </button>
          {pratiche.map((p) => (
            <button
              key={p.id}
              className={`chip ${filtroPratica === p.id ? 'active' : ''}`}
              onClick={() => setFiltroPratica(p.id)}
            >
              {p.nome}
            </button>
          ))}
          <button className={`chip ${soloAttesa ? 'active' : ''}`} onClick={() => setSoloAttesa((s) => !s)}>
            In attesa di conferma
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🔍</div>
          <p>Nessuna conversazione trovata</p>
        </div>
      ) : (
        <div className="storico-list">
          {filtered.map((c) =>
            confermaId === c.id ? (
              <div key={c.id} className="storico-card conferma-elimina">
                <span className="nm">Eliminare questa conversazione? Non si può annullare.</span>
                <button
                  className="conferma-si"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(c.id);
                    setConfermaId(null);
                  }}
                >
                  Sì, elimina
                </button>
                <button className="conferma-no" onClick={(e) => { e.stopPropagation(); setConfermaId(null); }}>
                  Annulla
                </button>
              </div>
            ) : (
              <div key={c.id} className="storico-card" onClick={() => onOpen(c)}>
                <div className="storico-card-top">
                  <span className={`stato-dot ${c.stato}`} title={STATO_LABEL[c.stato]} />
                  <span className="mode-badge mode-badge-inkblue">{c.procedura}</span>
                  <span className="storico-folder">{nomePratica(c.praticaId)}</span>
                  {c.dispositivoOrigine === 'telefono' && (
                    <span className="storico-phone" title="Avviata dal telefono">
                      <PhoneIcon size={12} />
                    </span>
                  )}
                  <span className="storico-date">{fmt(c.aggiornataIl)}</span>
                  <button
                    className="convo-delete storico-delete"
                    title="Elimina conversazione"
                    onClick={(e) => { e.stopPropagation(); setConfermaId(c.id); }}
                  >
                    ×
                  </button>
                </div>
                <div className="storico-query">{c.titolo}</div>
                <div className="storico-preview">{STATO_LABEL[c.stato]}</div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
