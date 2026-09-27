import { useEffect, useState } from 'react';
import type { Bozza } from '../types';
import Markdown from './Markdown';
import { CopyIcon, DownloadIcon, FolderIcon } from './icons';

interface Props {
  bozza: Bozza;
  onChiudi: () => void;
}

// Pannello documento (spec §5.6): un vero pannello laterale che affianca la
// chat invece di coprirla (ConversazioneView lo mette dentro
// ".doc-panel-wrap", non più un modale sopra tutto). Solo la scheda
// "Documento" per ora — Modifiche e Versioni arrivano con la parte dati di
// Fase 5 (SQLite), quando ci sarà davvero uno storico su cui costruirle.
export default function PannelloDocumento({ bozza, onChiudi }: Props) {
  const [salvando, setSalvando] = useState<'word' | 'pdf' | null>(null);
  const [percorsoSalvato, setPercorsoSalvato] = useState<string | null>(null);
  const [esito, setEsito] = useState<string | null>(null);
  const [copiato, setCopiato] = useState(false);

  // Una bozza diversa (titolo diverso): il pannello dimentica il
  // salvataggio precedente, non ha senso "Apri nella cartella" di un altro
  // documento.
  useEffect(() => {
    setPercorsoSalvato(null);
    setEsito(null);
    setSalvando(null);
  }, [bozza.titolo, bozza.contenuto]);

  async function copiaTesto() {
    await navigator.clipboard.writeText(bozza.contenuto);
    setCopiato(true);
    setTimeout(() => setCopiato(false), 1500);
  }

  async function salva(formato: 'word' | 'pdf') {
    setSalvando(formato);
    setEsito(null);
    const risultato =
      formato === 'word'
        ? await window.jarai.bozze.salvaDocx(bozza.titolo, bozza.contenuto)
        : await window.jarai.bozze.salvaPdf(bozza.titolo, bozza.contenuto);
    setSalvando(null);
    if (risultato.salvato) {
      setPercorsoSalvato(risultato.percorso ?? null);
      setEsito(`Salvata in ${formato === 'word' ? 'Word' : 'PDF'}${risultato.percorso ? ` — ${risultato.percorso}` : ''}`);
    }
  }

  return (
    <div className="doc-panel">
      <div className="doc-panel-head">
        <h3 title={bozza.titolo}>{bozza.titolo}</h3>
        <button className="btn-icon" title="Chiudi" onClick={onChiudi}>
          ×
        </button>
      </div>

      <div className="doc-panel-actions">
        <button className="doc-panel-action" onClick={() => void copiaTesto()}>
          <CopyIcon size={13} />
          {copiato ? 'Copiato ✓' : 'Copia testo'}
        </button>
        <button className="doc-panel-action" onClick={() => void salva('word')} disabled={salvando !== null}>
          <DownloadIcon size={13} />
          {salvando === 'word' ? 'Salvataggio…' : 'Salva in Word'}
        </button>
        <button className="doc-panel-action" onClick={() => void salva('pdf')} disabled={salvando !== null}>
          <DownloadIcon size={13} />
          {salvando === 'pdf' ? 'Salvataggio…' : 'Salva in PDF'}
        </button>
        <button
          className="doc-panel-action"
          title={percorsoSalvato ? 'Apri nella cartella' : 'Salva prima il documento per poterlo aprire'}
          disabled={!percorsoSalvato}
          onClick={() => percorsoSalvato && void window.jarai.apriNellaCartella(percorsoSalvato)}
        >
          <FolderIcon size={13} />
          Apri nella cartella
        </button>
      </div>

      {esito && <div className="doc-panel-esito">✓ {esito}</div>}

      <div className="doc-panel-body">
        <div className="msg-text">
          <Markdown>{bozza.contenuto}</Markdown>
        </div>
      </div>
    </div>
  );
}
