import { CloseIcon } from './icons';

export interface FilePendente {
  id: string;
  nome: string;
  cartella: string;
  estensione: string;
  dimensione: number;
  percorso: string;
  modificatoIl: string;
  duplicato: boolean;
  incluso: boolean;
}

interface Props {
  cartellaNome: string;
  caricando: boolean;
  pendenti: FilePendente[];
  onToggle: (id: string) => void;
  onToggleTuttiDuplicati: (incluso: boolean) => void;
  onConferma: () => void;
  onAnnulla: () => void;
}

function fmtSize(b: number) {
  return b > 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
}

function MiniPaper({ faded = false, label }: { faded?: boolean; label: string }) {
  return (
    <div className={`mini-paper doc${faded ? ' faded' : ''}`}>
      <div className="accent-bar" />
      <div className="line s" />
      <div className="line l" />
      <div className="line m" />
      <div className="line s" />
      <div className="stamp" />
      <span className="ext-tag">{label}</span>
    </div>
  );
}

export default function ImportaCartellaModal({ cartellaNome, caricando, pendenti, onToggle, onToggleTuttiDuplicati, onConferma, onAnnulla }: Props) {
  const nuovi = pendenti.filter((f) => !f.duplicato);
  const duplicati = pendenti.filter((f) => f.duplicato);
  const selezionati = pendenti.filter((f) => f.incluso).length;

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !caricando) onAnnulla(); }}>
      <div className="upload-modal">
        <div className="upload-modal-head">
          <div>
            <h3>{caricando ? 'Lettura della cartella…' : 'Anteprima importazione'}</h3>
            {caricando ? (
              <p className="upload-modal-sub">«{cartellaNome}»</p>
            ) : (
              <p className="upload-modal-sub">
                {pendenti.length} file trovati in «{cartellaNome}» · {selezionati} selezionati
              </p>
            )}
          </div>
          {!caricando && (
            <button className="btn-icon" onClick={onAnnulla}>
              <CloseIcon />
            </button>
          )}
        </div>

        {caricando ? (
          <div className="upload-modal-loading">
            <div className="upload-progress-bar">
              <div className="upload-progress-fill" style={{ width: '100%' }} />
            </div>
            <p>Sto leggendo i documenti nelle sottocartelle…</p>
          </div>
        ) : (
          <div className="upload-modal-body">
            {pendenti.length === 0 && (
              <div className="empty-state" style={{ margin: '12px 20px' }}>
                Nessun documento supportato trovato in questa cartella.
              </div>
            )}

            {nuovi.length > 0 && (
              <section className="upload-section">
                <div className="upload-section-label new">
                  <span className="upload-section-dot" />
                  Nuovi — {nuovi.length}
                </div>
                {nuovi.map((f) => (
                  <div key={f.id} className="upload-file-row">
                    <MiniPaper label={f.estensione} />
                    <div className="upload-file-info">
                      <div className="upload-file-name">{f.nome}</div>
                      <div className="upload-file-meta">
                        {f.cartella} · {fmtSize(f.dimensione)}
                      </div>
                    </div>
                    <span className="upload-badge new">Nuovo</span>
                  </div>
                ))}
              </section>
            )}

            {duplicati.length > 0 && (
              <section className="upload-section">
                <div className="upload-section-label dupe">
                  <span className="upload-section-dot" />
                  Già presenti — {duplicati.length}
                  <button className="upload-toggle-all" onClick={() => onToggleTuttiDuplicati(duplicati.some((f) => !f.incluso))}>
                    {duplicati.every((f) => f.incluso) ? 'Deseleziona tutti' : 'Seleziona tutti'}
                  </button>
                </div>
                {duplicati.map((f) => (
                  <label key={f.id} className={`upload-file-row dupe-row${f.incluso ? ' checked' : ''}`}>
                    <MiniPaper faded={!f.incluso} label={f.estensione} />
                    <div className="upload-file-info">
                      <div className="upload-file-name">{f.nome}</div>
                      <div className="upload-file-meta">
                        {f.cartella} · {fmtSize(f.dimensione)} · già nella pratica
                      </div>
                    </div>
                    <input type="checkbox" className="upload-check" checked={f.incluso} onChange={() => onToggle(f.id)} />
                  </label>
                ))}
              </section>
            )}
          </div>
        )}

        {!caricando && (
          <div className="upload-modal-foot">
            <button className="btn" onClick={onAnnulla}>
              Annulla
            </button>
            <button className="btn primary" disabled={selezionati === 0} onClick={onConferma}>
              Aggiungi {selezionati} file
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
