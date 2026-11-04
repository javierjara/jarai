import { useEffect, useState } from 'react';
import type { Articolo, Copertina } from '../types';

type Proposta = Extract<Awaited<ReturnType<typeof window.jarai.sito.copertine>>, { ok: true }>['dati'][number];

interface Props {
  articolo: Articolo;
  copertina?: Copertina;
  firma: string;
  sitoCollegato: boolean;
  onCambia: (copertina: Copertina | undefined) => void;
}

const ORIGINE: Record<Copertina['origine'], string> = {
  copertina: 'Copertina creata da JarAI',
  foto: 'Foto d\'archivio',
  sito: 'Dalla libreria del sito',
  caricata: 'Caricata dal computer',
};

// Immagine di copertina dell'articolo (Studio digitale): in cima
// all'articolo e come anteprima su Google, LinkedIn e WhatsApp. Si sceglie
// tra quelle proposte o si carica dal computer; va sul sito solo con
// l'invio della bozza.
export default function CopertinaArticolo({ articolo, copertina, firma, sitoCollegato, onCambia }: Props) {
  const [anteprima, setAnteprima] = useState('');
  const [scelta, setScelta] = useState(false);

  useEffect(() => {
    if (!copertina) {
      setAnteprima('');
      return;
    }
    let annullato = false;
    void window.jarai.sito.anteprimaImmagine(copertina.file).then((url) => !annullato && setAnteprima(url));
    return () => {
      annullato = true;
    };
  }, [copertina?.file]);

  const alt = copertina?.alt ?? '';

  return (
    <div className="sd-copertina">
      <div className="sd-copertina-head">
        <span className="sd-meta-et">Immagine di copertina</span>
        {copertina && !scelta && (
          <span className="sd-copertina-azioni">
            <button className="btn-link" onClick={() => setScelta(true)}>Cambia</button>
            <button className="btn-link" onClick={() => onCambia(undefined)}>Togli</button>
          </span>
        )}
      </div>

      {copertina ? (
        <>
          <div className="sd-copertina-img">{anteprima && <img src={anteprima} alt={alt} />}</div>
          <div className="sd-copertina-fonte">
            {ORIGINE[copertina.origine]}
            {copertina.credito ? ` · ${copertina.credito}` : ''}
            {copertina.mediaId !== undefined ? ' · già sul sito' : ''}
          </div>
          <label className="sd-copertina-alt">
            <span>Testo alternativo, per Google e per chi usa un lettore di schermo</span>
            <span className="sd-copertina-alt-riga">
              <input
                value={alt}
                placeholder="Descrivi in breve cosa mostra l'immagine"
                maxLength={300}
                onChange={(e) => onCambia({ ...copertina, alt: e.target.value })}
              />
              <span className={`sd-conteggio ${alt.length > 125 ? 'oltre' : ''}`}>{alt.length}/125</span>
            </span>
          </label>
        </>
      ) : (
        !scelta && (
          <div className="sd-copertina-vuota">
            Nessuna immagine: Google e i social mostreranno l'anteprima senza foto.
            <button className="btn" onClick={() => setScelta(true)}>Scegli un'immagine</button>
          </div>
        )
      )}

      {scelta && (
        <SceltaImmagine
          articolo={articolo}
          firma={firma}
          sitoCollegato={sitoCollegato}
          onScelta={(c) => {
            onCambia(c);
            setScelta(false);
          }}
          onAnnulla={() => setScelta(false)}
        />
      )}
    </div>
  );
}

interface SceltaProps {
  articolo: Articolo;
  firma: string;
  sitoCollegato: boolean;
  onScelta: (copertina: Copertina) => void;
  onAnnulla: () => void;
}

interface Gruppo {
  proposte: Proposta[] | null;
  errore: string | null;
}

const VUOTO: Gruppo = { proposte: null, errore: null };

function SceltaImmagine({ articolo, firma, sitoCollegato, onScelta, onAnnulla }: SceltaProps) {
  const [copertine, setCopertine] = useState<Gruppo>(VUOTO);
  const [foto, setFoto] = useState<Gruppo>(VUOTO);
  const [delSito, setDelSito] = useState<Gruppo>(VUOTO);
  const [cerca, setCerca] = useState(articolo.fotoCerca ?? '');
  const [inScelta, setInScelta] = useState<string | null>(null);
  const [errore, setErrore] = useState<string | null>(null);

  const daEsito = (esito: Awaited<ReturnType<typeof window.jarai.sito.copertine>>): Gruppo =>
    esito.ok ? { proposte: esito.dati, errore: null } : { proposte: [], errore: esito.errore };

  async function cercaFoto(testo: string) {
    if (testo.trim().length < 2) return;
    setFoto(VUOTO);
    setFoto(daEsito(await window.jarai.sito.cercaFoto(testo.trim(), articolo.titolo)));
  }

  useEffect(() => {
    void window.jarai.sito
      .copertine({ titolo: articolo.titolo, categoria: articolo.categorie[0], firma })
      .then((e) => setCopertine(daEsito(e)));
    if (sitoCollegato) void window.jarai.sito.immaginiSito().then((e) => setDelSito(daEsito(e)));
    if (articolo.fotoCerca) void cercaFoto(articolo.fotoCerca);
    else setFoto({ proposte: [], errore: null });
    // Solo all'apertura della scelta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function scegli(p: Proposta) {
    setInScelta(p.chiave);
    setErrore(null);
    const esito = await window.jarai.sito.scegliImmagine(p);
    setInScelta(null);
    if (!esito.ok) {
      setErrore(esito.errore);
      return;
    }
    onScelta(esito.dati);
  }

  async function carica() {
    setErrore(null);
    setInScelta('caricata');
    const esito = await window.jarai.sito.caricaImmagine();
    setInScelta(null);
    if (!esito.ok) {
      setErrore(esito.errore);
      return;
    }
    if (esito.dati) onScelta(esito.dati);
  }

  const griglia = (g: Gruppo, attesa: string, vuoto: string) => (
    <>
      {g.proposte === null && <div className="sd-scelta-nota">{attesa}</div>}
      {g.errore && <div className="sd-scelta-nota">{g.errore}</div>}
      {g.proposte?.length === 0 && !g.errore && <div className="sd-scelta-nota">{vuoto}</div>}
      {!!g.proposte?.length && (
        <div className="sd-scelta-griglia">
          {g.proposte.map((p) => (
            <button
              key={p.chiave}
              className={`sd-scelta-voce ${inScelta === p.chiave ? 'in-corso' : ''}`}
              onClick={() => void scegli(p)}
              disabled={inScelta !== null}
              title={p.credito ?? p.etichetta}
            >
              <img src={p.anteprima} alt="" />
              <span>{inScelta === p.chiave ? 'Preparo…' : p.etichetta}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );

  return (
    <div className="sd-scelta">
      <div className="sd-scelta-titolo">Copertine con il titolo</div>
      {griglia(copertine, 'Preparo le copertine…', 'Nessuna copertina disponibile.')}

      <div className="sd-scelta-titolo">Foto d'archivio</div>
      <form
        className="sd-scelta-cerca"
        onSubmit={(e) => {
          e.preventDefault();
          void cercaFoto(cerca);
        }}
      >
        <input value={cerca} onChange={(e) => setCerca(e.target.value)} placeholder="es. chiavi di casa, stadio, biblioteca" />
        <button className="btn" type="submit" disabled={cerca.trim().length < 2}>Cerca</button>
      </form>
      {griglia(foto, 'Cerco le foto…', 'Scrivi cosa cercare: oggetti o luoghi, meglio senza persone.')}
      <div className="sd-scelta-nota">Foto da Pixabay, gratuite anche per uso professionale. Evita volti riconoscibili.</div>

      {sitoCollegato && (
        <>
          <div className="sd-scelta-titolo">Già sul sito</div>
          {griglia(delSito, 'Leggo la libreria del sito…', 'Nessuna immagine nella libreria del sito.')}
        </>
      )}

      {errore && <div className="sd-errore">{errore}</div>}

      <div className="sd-scelta-azioni">
        <button className="btn" onClick={() => void carica()} disabled={inScelta !== null}>
          {inScelta === 'caricata' ? 'Preparo…' : 'Carica dal computer…'}
        </button>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={onAnnulla}>Annulla</button>
      </div>
    </div>
  );
}
