import { useState } from 'react';
import type { Conversazione, MainView, Pratica, Studio } from '../types';
import { ChevronIcon, FolderIcon, HistoryIcon, HomeIcon, SettingsIcon } from './icons';

interface Props {
  currentView: MainView;
  onNavigate: (view: MainView) => void;
  studio: Studio;
  pratiche: Pratica[];
  conversazioni: Conversazione[];
  onOpenConversazione: (c: Conversazione) => void;
  onNuovaConversazione: (praticaId: string) => void;
  onDeleteConversazione: (id: string) => void;
}

const MAX_VISIBILI = 5;

export default function Sidebar({
  currentView,
  onNavigate,
  studio,
  pratiche,
  conversazioni,
  onOpenConversazione,
  onNuovaConversazione,
  onDeleteConversazione,
}: Props) {
  const [aperte, setAperte] = useState<Set<string>>(new Set([pratiche[0]?.id]));
  const [espanseAll, setEspanseAll] = useState<Set<string>>(new Set());
  // Doppia conferma prima di eliminare: il primo click mostra "Eliminare?",
  // solo un secondo click sul pulsante di conferma cancella davvero — mai
  // una singola azione accidentale che cancella una conversazione.
  const [confermaId, setConfermaId] = useState<string | null>(null);

  function toggle(id: string) {
    setAperte((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const initial = studio.nome[0]?.toUpperCase() ?? 'S';

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          jar<span className="accent">AI</span>
          <span className="dot">.</span>
        </div>
        <div className="brand-tag">STUDIO</div>
      </div>

      <div className="studio">
        <div className="studio-row">
          <div className="studio-avatar">{initial}</div>
          <div>
            <div className="studio-name">{studio.nome}</div>
            <div className="studio-meta">{studio.avvocato}</div>
          </div>
        </div>
      </div>

      <nav className="nav">
        <NavBtn id="home" label="Fai una domanda" current={currentView} onNavigate={onNavigate} icon={<HomeIcon />} />
        <NavBtn id="storico" label="Storico" current={currentView} onNavigate={onNavigate} icon={<HistoryIcon />} />
        <NavBtn id="pratiche" label="Le mie pratiche" current={currentView} onNavigate={onNavigate} icon={<FolderIcon />} />
      </nav>

      <div className="nav-label">Pratiche</div>
      <div className="pratiche-scroll">
        {pratiche.map((p) => {
          const open = aperte.has(p.id);
          const convo = conversazioni.filter((c) => c.praticaId === p.id);
          const espansa = espanseAll.has(p.id);
          const visibili = espansa ? convo : convo.slice(0, MAX_VISIBILI);
          return (
            <div className="pratica-group" key={p.id}>
              <div
                className={`pratica-group-head ${open ? 'open' : ''}`}
                onClick={() => toggle(p.id)}
              >
                <span className="chevron">
                  <ChevronIcon size={11} />
                </span>
                <span className="nm">{p.nome}</span>
              </div>
              {open && (
                <div className="pratica-convo-list">
                  {visibili.map((c) =>
                    confermaId === c.id ? (
                      <div key={c.id} className="pratica-convo-item conferma-elimina">
                        <span className="nm">Eliminare questa conversazione?</span>
                        <button
                          className="conferma-si"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteConversazione(c.id);
                            setConfermaId(null);
                          }}
                        >
                          Sì
                        </button>
                        <button className="conferma-no" onClick={(e) => { e.stopPropagation(); setConfermaId(null); }}>
                          No
                        </button>
                      </div>
                    ) : (
                      <div
                        key={c.id}
                        className="pratica-convo-item"
                        onClick={() => onOpenConversazione(c)}
                        title={c.titolo}
                      >
                        <span className={`stato-dot ${c.stato}`} />
                        <span className="nm">{c.titolo}</span>
                        <button
                          className="convo-delete"
                          title="Elimina conversazione"
                          onClick={(e) => { e.stopPropagation(); setConfermaId(c.id); }}
                        >
                          ×
                        </button>
                      </div>
                    ),
                  )}
                  {!espansa && convo.length > MAX_VISIBILI && (
                    <div
                      className="pratica-convo-more"
                      onClick={() => setEspanseAll((prev) => new Set(prev).add(p.id))}
                    >
                      Mostra tutte ({convo.length})
                    </div>
                  )}
                  <div className="pratica-add-row" onClick={() => onNuovaConversazione(p.id)}>
                    + Nuova
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div className="pratica-add" onClick={() => onNavigate('pratiche')}>
          + Aggiungi pratica
        </div>
      </div>

      <div className="sidebar-system">
        <div className="nav-label">Sistema</div>
        <nav className="nav">
          <NavBtn id="impostazioni" label="Impostazioni" current={currentView} onNavigate={onNavigate} icon={<SettingsIcon />} />
        </nav>
      </div>

      <div className="sidebar-footer">
        <div className="privacy-pill-sidebar">
          <span className="dot" />
          Locale · cifrata · GDPR
        </div>
      </div>
    </aside>
  );
}

function NavBtn({
  id,
  label,
  current,
  onNavigate,
  icon,
  trailing,
}: {
  id: MainView;
  label: string;
  current: MainView;
  onNavigate: (v: MainView) => void;
  icon: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <button className={`nav-item ${current === id ? 'active' : ''}`} onClick={() => onNavigate(id)}>
      <span className="ico">{icon}</span>
      {label}
      {trailing}
    </button>
  );
}
