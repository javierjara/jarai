import { useEffect, useRef, useState } from 'react';
import type { Documento } from '../types';

const ESTENSIONI_IMMAGINE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

// PDF e immagini hanno un'anteprima visiva vera (una pagina così com'è); i
// DOCX mostrano il testo estratto — in particolare le trascrizioni audio
// (spec §6.2): il collegamento "📝 Trascrizione" sulla riga dell'audio deve
// far leggere il testo vero, non fermarsi a una nota generica. Per il resto
// (DOC, RTF, EML, MSG, P7M, audio) PraticheView tiene la nota testuale di
// sempre — JarAI li legge comunque in conversazione.
export function anteprimaSupportata(doc: Documento): boolean {
  if (!doc.percorso) return false;
  const ext = doc.tipo.toLowerCase();
  return ext === 'pdf' || ext === 'docx' || ESTENSIONI_IMMAGINE.has(ext);
}

// Livelli di zoom, in percentuale della larghezza del riquadro (non della
// pagina originale: nessuna misurazione da fare, il browser risolve da
// solo una larghezza in % rispetto al contenitore). -1 = "Adatta", il
// comportamento di sempre (object-fit: contain, tutta la pagina visibile).
const LIVELLI_ZOOM = [100, 130, 160, 200, 250, 300];
const ADATTA = -1;

interface Props {
  doc: Documento;
}

export default function AnteprimaDocumento({ doc }: Props) {
  const ext = doc.tipo.toLowerCase();
  const eImmagine = ESTENSIONI_IMMAGINE.has(ext);
  const eDocx = ext === 'docx';
  const percorso = doc.percorso;

  const [pagina, setPagina] = useState(1);
  const [totalePagine, setTotalePagine] = useState<number | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [testo, setTesto] = useState<string | null>(null);
  const [caricando, setCaricando] = useState(true);
  const [errore, setErrore] = useState<string | null>(null);
  const [zoomIdx, setZoomIdx] = useState(ADATTA);
  const urlRef = useRef<string | null>(null);

  const zoomAttivo = zoomIdx !== ADATTA;
  const zoomPercentuale = zoomAttivo ? LIVELLI_ZOOM[zoomIdx] : null;

  function zoomIn() {
    setZoomIdx((i) => Math.min(LIVELLI_ZOOM.length - 1, i + 1));
  }
  function zoomOut() {
    setZoomIdx((i) => Math.max(ADATTA, i - 1));
  }
  function zoomAdatta() {
    setZoomIdx(ADATTA);
  }

  // Un documento diverso: si riparte dalla prima pagina, si dimentica
  // l'anteprima precedente e lo zoom torna ad "Adatta" — non ha senso
  // restare a 300% aprendo un documento nuovo.
  useEffect(() => {
    setPagina(1);
    setTotalePagine(null);
    setUrl(null);
    setTesto(null);
    setZoomIdx(ADATTA);
  }, [doc.id]);

  // I DOCX (in particolare le trascrizioni) non hanno pagine/zoom: solo
  // testo, letto una volta sola — percorso diverso dal blob PDF/immagine
  // sotto, niente URL da creare o revocare.
  useEffect(() => {
    if (!eDocx) return;
    if (!percorso) {
      setErrore('Questo documento non ha un file collegato.');
      setCaricando(false);
      return;
    }
    let annullato = false;
    setCaricando(true);
    setErrore(null);
    window.jarai.documenti
      .anteprimaDocx(percorso)
      .then((r) => {
        if (annullato) return;
        setTesto(r.testo.trim() || '(Questo documento non contiene testo.)');
      })
      .catch((err) => {
        if (annullato) return;
        console.error('[anteprima] lettura DOCX non riuscita', doc.nome, err);
        setErrore("Non riesco a leggere il testo di questo file.");
      })
      .finally(() => {
        if (!annullato) setCaricando(false);
      });
    return () => {
      annullato = true;
    };
  }, [eDocx, percorso, doc.nome]);

  useEffect(() => {
    if (eDocx) return;
    if (!percorso) {
      setErrore('Questo documento non ha un file collegato.');
      setCaricando(false);
      return;
    }
    let annullato = false;
    setCaricando(true);
    setErrore(null);

    const richiesta = eImmagine
      ? window.jarai.documenti.anteprimaImmagine(percorso).then((r) => ({ dati: r.dati, mime: r.mime, totalePagine: 1 }))
      : window.jarai.documenti.anteprimaPdf(percorso, pagina).then((r) => ({ dati: r.dati, mime: 'image/png', totalePagine: r.totalePagine }));

    richiesta
      .then(({ dati, mime, totalePagine: tot }) => {
        if (annullato) return;
        const nuovoUrl = URL.createObjectURL(new Blob([dati], { type: mime }));
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = nuovoUrl;
        setUrl(nuovoUrl);
        setTotalePagine(tot);
      })
      .catch((err) => {
        if (annullato) return;
        console.error('[anteprima] caricamento non riuscito', doc.nome, err);
        setErrore("Non riesco a mostrare l'anteprima di questo file.");
      })
      .finally(() => {
        if (!annullato) setCaricando(false);
      });

    return () => {
      annullato = true;
    };
  }, [eDocx, percorso, pagina, eImmagine, doc.nome]);

  // Revoca l'ultimo blob creato quando il componente sparisce (documento
  // chiuso) — non solo ad ogni cambio pagina, dove è già gestito sopra.
  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  if (errore) return <div className="anteprima-errore">{errore}</div>;

  if (eDocx) {
    return (
      <div className="anteprima-doc">
        <div className="anteprima-testo-wrap">
          {caricando && !testo ? <div className="anteprima-caricando">Leggo il testo…</div> : <p className="anteprima-testo">{testo}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="anteprima-doc">
      {url && (
        <div className="anteprima-zoom">
          <button className="doc-panel-action" title="Riduci" disabled={!zoomAttivo} onClick={zoomOut}>
            −
          </button>
          <button className="doc-panel-action anteprima-zoom-etichetta" title="Adatta alla finestra" onClick={zoomAdatta}>
            {zoomAttivo ? `${zoomPercentuale}%` : 'Adatta'}
          </button>
          <button className="doc-panel-action" title="Ingrandisci" disabled={zoomIdx >= LIVELLI_ZOOM.length - 1} onClick={zoomIn}>
            +
          </button>
        </div>
      )}
      <div className={`anteprima-pagina-wrap ${zoomAttivo ? 'zoomed' : ''}`}>
        {caricando && !url && <div className="anteprima-caricando">Carico l'anteprima…</div>}
        {url && (
          <img
            className="anteprima-pagina"
            src={url}
            alt={doc.nome}
            style={zoomAttivo ? { width: `${zoomPercentuale}%`, maxWidth: 'none', maxHeight: 'none' } : undefined}
          />
        )}
      </div>
      {!eImmagine && totalePagine !== null && totalePagine > 1 && (
        <div className="anteprima-nav">
          <button className="btn" disabled={pagina <= 1 || caricando} onClick={() => setPagina((p) => p - 1)}>
            ‹ Precedente
          </button>
          <span className="anteprima-contatore">
            Pagina {pagina} di {totalePagine}
          </span>
          <button className="btn" disabled={pagina >= totalePagine || caricando} onClick={() => setPagina((p) => p + 1)}>
            Successiva ›
          </button>
        </div>
      )}
    </div>
  );
}
