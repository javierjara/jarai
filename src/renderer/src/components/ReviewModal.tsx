import { useState } from 'react';

interface Props {
  titolo: string;
  descrizione: string;
  fatti?: { etichetta: string; valore: string }[];
  onApprova: (nota: string) => void;
  onModifica: (nota: string) => void;
  onRifiuta: () => void;
}

export default function ReviewModal({ titolo, descrizione, fatti, onApprova, onModifica, onRifiuta }: Props) {
  const [nota, setNota] = useState('');

  return (
    <div className="review-overlay">
      <div className="review-modal">
        <div className="review-header">
          <div className="review-title">⚠ {titolo}</div>
          <div className="review-motivation">{descrizione}</div>
        </div>
        {fatti && fatti.length > 0 && (
          <div className="review-document">
            {fatti.map((f) => (
              <div className="review-fact" key={f.etichetta}>
                <span className="lbl">{f.etichetta}</span>
                <span className="val">{f.valore}</span>
              </div>
            ))}
          </div>
        )}
        <div className="review-note-wrap">
          <textarea
            className="review-note-input"
            rows={2}
            placeholder="Nota per l'assistente (facoltativa)"
            value={nota}
            onChange={(e) => setNota(e.target.value)}
          />
        </div>
        <div className="review-actions">
          <button className="review-btn-reject" onClick={onRifiuta}>
            Rifiuta
          </button>
          <button className="review-btn-modify" onClick={() => onModifica(nota)}>
            Chiedi modifiche
          </button>
          <button className="review-btn-approve" onClick={() => onApprova(nota)}>
            Approva
          </button>
        </div>
      </div>
    </div>
  );
}
