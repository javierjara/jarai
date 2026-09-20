import { useCallback, useEffect, useRef, useState } from 'react';
import type { Conversazione, Documento, FileImportato, Pratica } from '../types';
import { CloseIcon, FolderIcon, PencilIcon, PlusIcon, SearchIcon } from './icons';
import ImportaCartellaModal, { type FilePendente } from './ImportaCartellaModal';

interface Props {
  pratiche: Pratica[];
  conversazioni: Conversazione[];
  documenti: Record<string, Documento[]>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChiedi: (praticaId: string) => void;
  onAddPraticaDaCartella: (cartellaPercorso: string, cartellaNome: string, file: FileImportato[]) => void;
  onRicollegaCartella: (praticaId: string, cartellaPercorso: string) => void;
  onCartellaNonTrovata: (praticaId: string) => void;
  onRenamePratica: (id: string, nome: string) => void;
  onDeletePratica: (id: string) => void;
  onImportaDocumenti: (praticaId: string, documenti: Documento[]) => void;
  onDeleteDocumento: (praticaId: string, docId: string) => void;
}

type Tab = 'documenti' | 'conversazioni';

const SIDEBAR_MIN_WIDTH = 160;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_DEFAULT_WIDTH = 220;
const SIDEBAR_WIDTH_KEY = 'jarai-pratiche-sidebar-width';

function fmtData(iso: string) {
  return new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtSize(b: number) {
  return b > 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
}

export default function PraticheView({
  pratiche,
  conversazioni,
  documenti,
  selectedId,
  onSelect,
  onChiedi,
  onAddPraticaDaCartella,
  onRicollegaCartella,
  onCartellaNonTrovata,
  onRenamePratica,
  onDeletePratica,
  onImportaDocumenti,
  onDeleteDocumento,
}: Props) {
  const [creandoPratica, setCreandoPratica] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [filterQuery, setFilterQuery] = useState('');
  const [tab, setTab] = useState<Tab>('documenti');
  const [previewDoc, setPreviewDoc] = useState<Documento | null>(null);

  const [importazione, setImportazione] = useState<{ cartellaNome: string; caricando: boolean; pendenti: FilePendente[] } | null>(null);

  const layoutRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return stored >= SIDEBAR_MIN_WIDTH && stored <= SIDEBAR_MAX_WIDTH ? stored : SIDEBAR_DEFAULT_WIDTH;
  });

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!resizingRef.current || !layoutRef.current) return;
      const rect = layoutRef.current.getBoundingClientRect();
      setSidebarWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, e.clientX - rect.left)));
    };
    const handleUp = () => {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setSidebarWidth((w) => {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
        return w;
      });
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  // Fase 3 (spec §5.3): "Aggiungi pratica" apre subito il selettore di
  // cartelle — la pratica nasce già legata 1:1 a quella cartella, nome
  // proposto dal nome della cartella (rinominabile dopo, come già oggi).
  async function aggiungiPratica() {
    setCreandoPratica(true);
    const risultato = await window.jarai.importaCartella();
    setCreandoPratica(false);
    if (!risultato) return;
    onAddPraticaDaCartella(risultato.cartellaPercorso, risultato.cartellaNome, risultato.file);
  }

  function startRename(p: Pratica) {
    setRenamingId(p.id);
    setRenameValue(p.nome);
  }

  function commitRename() {
    const nome = renameValue.trim();
    if (renamingId && nome) onRenamePratica(renamingId, nome);
    setRenamingId(null);
    setRenameValue('');
  }

  const pratica = pratiche.find((p) => p.id === selectedId) ?? null;

  // Rilegge la cartella già collegata alla pratica (mai un nuovo selettore:
  // il legame è 1:1, spec §5.3) per scoprire i file aggiunti nel frattempo.
  // Se la cartella non risponde più, segnala "non trovata" invece di un
  // errore grezzo — l'avvocato la ritrova con "Trova di nuovo".
  async function aggiornaDaCartella() {
    if (!pratica?.cartellaPercorso) return;
    setImportazione({ cartellaNome: pratica.nome, caricando: true, pendenti: [] });
    try {
      const risultato = await window.jarai.scansionaCartella(pratica.cartellaPercorso);
      const esistenti = new Set((documenti[pratica.id] ?? []).map((d) => d.nome.toLowerCase()));
      const pendenti: FilePendente[] = risultato.file.map((f) => {
        const duplicato = esistenti.has(f.nome.toLowerCase());
        return {
          id: crypto.randomUUID(),
          nome: f.nome,
          cartella: f.cartella,
          estensione: f.estensione,
          dimensione: f.dimensione,
          percorso: f.percorso,
          modificatoIl: f.modificatoIl,
          duplicato,
          incluso: !duplicato,
        };
      });
      setImportazione({ cartellaNome: risultato.cartellaNome, caricando: false, pendenti });
    } catch {
      setImportazione(null);
      onCartellaNonTrovata(pratica.id);
    }
  }

  // "Trova di nuovo" (spec §5.3): la cartella è stata rinominata o spostata,
  // l'avvocato ne indica la nuova posizione. Aggiorna subito il legame e
  // rilegge tutto — i documenti già noti vengono solo aggiornati (nuovo
  // percorso), mai duplicati, grazie alla fusione per nome in App.
  async function trovaDiNuovo() {
    if (!pratica) return;
    const risultato = await window.jarai.importaCartella();
    if (!risultato) return;
    onRicollegaCartella(pratica.id, risultato.cartellaPercorso);
    const aggiornati: Documento[] = risultato.file.map((f) => ({
      id: crypto.randomUUID(),
      nome: f.nome,
      tipo: f.estensione,
      data: f.modificatoIl,
      cartella: f.cartella,
      dimensione: f.dimensione,
      percorso: f.percorso,
    }));
    onImportaDocumenti(pratica.id, aggiornati);
  }

  function toggleImportato(id: string) {
    setImportazione((prev) => (prev ? { ...prev, pendenti: prev.pendenti.map((f) => (f.id === id ? { ...f, incluso: !f.incluso } : f)) } : prev));
  }

  function toggleTuttiDuplicati(incluso: boolean) {
    setImportazione((prev) => (prev ? { ...prev, pendenti: prev.pendenti.map((f) => (f.duplicato ? { ...f, incluso } : f)) } : prev));
  }

  function confermaImportazione() {
    if (!pratica || !importazione) return;
    const nuovi: Documento[] = importazione.pendenti
      .filter((f) => f.incluso)
      .map((f) => ({
        id: crypto.randomUUID(),
        nome: f.nome,
        tipo: f.estensione,
        data: f.modificatoIl,
        cartella: f.cartella,
        dimensione: f.dimensione,
        percorso: f.percorso,
      }));
    if (nuovi.length) onImportaDocumenti(pratica.id, nuovi);
    setImportazione(null);
  }

  const docsScoped: Documento[] = selectedId ? (documenti[selectedId] ?? []) : Object.values(documenti).flat();
  const visibleDocs = filterQuery.trim() ? docsScoped.filter((d) => d.nome.toLowerCase().includes(filterQuery.toLowerCase())) : docsScoped;
  const totalDocs = Object.values(documenti).reduce((n, arr) => n + arr.length, 0);

  return (
    <div className="libreria-layout" ref={layoutRef}>
      {/* ── Sidebar: elenco pratiche ── */}
      <div className="libreria-sidebar" style={{ width: sidebarWidth }}>
        <div className="libreria-sidebar-head">
          <span>Pratiche</span>
          <button className="btn-icon" title="Aggiungi pratica da una cartella" onClick={aggiungiPratica} disabled={creandoPratica}>
            <PlusIcon />
          </button>
        </div>

        {pratiche.length === 0 ? (
          <div className="libreria-empty-folders">
            <p>Nessuna pratica</p>
          </div>
        ) : (
          <>
            <button className={`folder-item ${selectedId === null ? 'active' : ''}`} onClick={() => onSelect(null)}>
              <span className="folder-icon">
                <FolderIcon size={14} />
              </span>
              <span className="folder-name">Tutti i documenti</span>
              <span className="folder-count">{totalDocs}</span>
            </button>

            <div className="libreria-sidebar-divider" />

            {pratiche.map((p) => {
              const count = documenti[p.id]?.length ?? 0;
              const isRenaming = renamingId === p.id;
              return (
                <div
                  key={p.id}
                  className={`folder-item ${selectedId === p.id ? 'active' : ''}`}
                  onClick={() => !isRenaming && onSelect(p.id)}
                >
                  <span className="folder-icon">
                    <FolderIcon size={14} />
                  </span>
                  {isRenaming ? (
                    <input
                      className="folder-rename-input"
                      value={renameValue}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') {
                          setRenamingId(null);
                          setRenameValue('');
                        }
                      }}
                    />
                  ) : (
                    <span className="folder-name" title="Doppio clic per rinominare" onDoubleClick={(e) => { e.stopPropagation(); startRename(p); }}>
                      {p.nome}
                    </span>
                  )}
                  {!isRenaming && !p.cartellaTrovata && <span className="stato-dot interrotta" title="Cartella non trovata" />}
                  {!isRenaming && <span className="folder-count">{count}</span>}
                  {!isRenaming && (
                    <button className="folder-rename" title="Rinomina pratica" onClick={(e) => { e.stopPropagation(); startRename(p); }}>
                      <PencilIcon />
                    </button>
                  )}
                  {!isRenaming && (
                    <button className="folder-delete" title="Rimuovi pratica da JarAI" onClick={(e) => { e.stopPropagation(); onDeletePratica(p.id); }}>
                      ×
                    </button>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      <div className="libreria-sidebar-resizer" onMouseDown={startResize} />

      {/* ── Contenuto ── */}
      <div className="libreria-content">
        <div className="libreria-content-head">
          <div>
            <h2>{pratica ? pratica.nome : 'Tutti i documenti'}</h2>
            <span className="lib-file-count">
              {pratica
                ? `${pratica.ambito} · Cliente: ${pratica.cliente}${pratica.controparte ? ` · Controparte: ${pratica.controparte}` : ''} · aggiornata ${fmtData(pratica.aggiornataIl)}`
                : `${totalDocs} document${totalDocs === 1 ? 'o' : 'i'}`}
            </span>
          </div>
          <div className="lib-filter-wrap">
            <SearchIcon size={13} />
            <input className="lib-filter-input" placeholder="Filtra documenti…" value={filterQuery} onChange={(e) => setFilterQuery(e.target.value)} />
            {filterQuery && (
              <button className="lib-filter-clear" onClick={() => setFilterQuery('')}>
                ×
              </button>
            )}
          </div>
          {pratica && (
            <div className="lib-upload-actions">
              <button className="btn primary" onClick={() => onChiedi(pratica.id)}>
                Chiedi su questa pratica
              </button>
              {pratica.cartellaTrovata ? (
                <button className="btn" disabled={!!importazione} onClick={aggiornaDaCartella}>
                  Aggiorna dalla cartella
                </button>
              ) : (
                <button className="btn danger" onClick={trovaDiNuovo}>
                  Trova di nuovo
                </button>
              )}
            </div>
          )}
        </div>

        {pratica && !pratica.cartellaTrovata && (
          <div className="privacy-card" style={{ margin: '0 24px 16px' }}>
            <div className="privacy-icn">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
              </svg>
            </div>
            <div className="privacy-text">
              <strong>Cartella non trovata.</strong> «{pratica.nome}» era collegata a una cartella che non risulta più al suo posto — rinominata o
              spostata dopo l'ultima apertura. I documenti restano quelli già letti finché non premi "Trova di nuovo".
            </div>
          </div>
        )}

        {pratica && (
          <div className="tabs lib-tabs">
            <button className={`tab ${tab === 'documenti' ? 'active' : ''}`} onClick={() => setTab('documenti')}>
              Documenti
            </button>
            <button className={`tab ${tab === 'conversazioni' ? 'active' : ''}`} onClick={() => setTab('conversazioni')}>
              Conversazioni
            </button>
          </div>
        )}

        {(!pratica || tab === 'documenti') &&
          (visibleDocs.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📄</div>
              <p>{pratica ? 'Nessun documento in questa pratica' : 'Nessun documento'}</p>
              <p className="empty-sub">
                {pratica ? 'La cartella collegata non contiene ancora documenti in un formato leggibile.' : 'Seleziona una pratica dal pannello a sinistra.'}
              </p>
            </div>
          ) : (
            <div className="lib-file-list">
              {visibleDocs.map((d) => (
                <div key={d.id} className="lib-file-row lib-file-row-clickable" onClick={() => setPreviewDoc(d)} title="Clicca per aprire">
                  <div className="lib-file-thumb">
                    <div className="mini-paper doc">
                      <div className="accent-bar" />
                      <div className="line s" />
                      <div className="line l" />
                      <div className="line m" />
                      <div className="line s" />
                      <div className="stamp" />
                      <span className="ext-tag">{d.tipo}</span>
                    </div>
                  </div>
                  <div className="lib-file-body">
                    <div className="lib-file-name">{d.nome}</div>
                    <div className="lib-file-meta">
                      <span>{d.cartella}</span>
                      {d.pagine ? (
                        <>
                          <span className="pip" />
                          <span>{d.pagine} p.</span>
                        </>
                      ) : d.dimensione ? (
                        <>
                          <span className="pip" />
                          <span>{fmtSize(d.dimensione)}</span>
                        </>
                      ) : null}
                      <span className="pip" />
                      <span>{fmtData(d.data)}</span>
                    </div>
                  </div>
                  {pratica && (
                    <button className="lib-row-del" title="Elimina" onClick={(e) => { e.stopPropagation(); onDeleteDocumento(pratica.id, d.id); }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14H6L5 6" />
                        <path d="M9 6V4h6v2" />
                      </svg>
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}

        {pratica && tab === 'conversazioni' && (
          <div className="storico-list">
            {conversazioni.filter((c) => c.praticaId === pratica.id).length === 0 ? (
              <div className="empty-state">Nessuna conversazione ancora su questa pratica.</div>
            ) : (
              conversazioni
                .filter((c) => c.praticaId === pratica.id)
                .map((c) => (
                  <div key={c.id} className="storico-card">
                    <div className="storico-card-top">
                      <span className={`stato-dot ${c.stato}`} />
                      <span className="mode-badge mode-badge-inkblue">{c.procedura}</span>
                      <span className="storico-date">{fmtData(c.aggiornataIl)}</span>
                    </div>
                    <div className="storico-query">{c.titolo}</div>
                  </div>
                ))
            )}
          </div>
        )}
      </div>

      {/* ── Anteprima documento ── */}
      {previewDoc && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setPreviewDoc(null); }}>
          <div className="doc-preview-modal">
            <h3>{previewDoc.nome}</h3>
            <div className="meta">
              {previewDoc.tipo} · {previewDoc.cartella}
              {previewDoc.pagine ? ` · ${previewDoc.pagine} pagine` : ''}
              {previewDoc.dimensione ? ` · ${fmtSize(previewDoc.dimensione)}` : ''} · {fmtData(previewDoc.data)}
            </div>
            <div className="note">
              Claude può già leggere questo documento in conversazione (PDF, DOCX, DOC, RTF, EML, MSG, P7M, immagini con OCR). L'anteprima visiva del
              contenuto qui nel pannello, pagina per pagina, arriva con il pannello documento della Fase 5.
            </div>
            <div className="foot">
              {previewDoc.percorso && (
                <button className="btn" onClick={() => void window.jarai.apriNellaCartella(previewDoc.percorso!)}>
                  Apri nella cartella
                </button>
              )}
              <button className="btn" onClick={() => setPreviewDoc(null)}>
                <CloseIcon size={13} /> Chiudi
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Importazione cartella ── */}
      {importazione && (
        <ImportaCartellaModal
          cartellaNome={importazione.cartellaNome}
          caricando={importazione.caricando}
          pendenti={importazione.pendenti}
          onToggle={toggleImportato}
          onToggleTuttiDuplicati={toggleTuttiDuplicati}
          onConferma={confermaImportazione}
          onAnnulla={() => setImportazione(null)}
        />
      )}
    </div>
  );
}
