import { useState } from 'react';
import type { Articolo, ConversazioneSito, SlideInstagram } from '../../types';
import { aLocaleInput, daLocaleInput } from './util';

interface Props {
  conversazione: ConversazioneSito;
  articolo: Articolo;
  copertina: string;
  nomeStudio: string;
  dominio: string;
  onCambiaArticolo: (a: Articolo) => void;
  onCambiaSocial: (s: NonNullable<ConversazioneSito['social']>) => void;
}

type Scheda = 'google' | 'linkedin' | 'instagram';

// Anteprime: come appare l'articolo su Google, il post LinkedIn e il
// carosello Instagram. I testi social li propone l'assistente insieme
// all'articolo; l'avvocato li corregge qui. La pubblicazione sui social è
// manuale: LinkedIn si apre già compilato, il carosello si salva come immagini.
export default function AnteprimeArticolo({ conversazione, articolo, copertina, nomeStudio, dominio, onCambiaArticolo, onCambiaSocial }: Props) {
  const [scheda, setScheda] = useState<Scheda>('google');
  const iniziale = (nomeStudio || dominio || 'S').replace(/^(studio legale|avv\.?|avvocato)\s+/i, '').charAt(0).toUpperCase();
  const social = conversazione.social ?? {};

  return (
    <div className="sd-anteprime">
      <div className="sd-prev-tabs">
        <span className="muted">Anteprima:</span>
        {(['google', 'linkedin', 'instagram'] as const).map((s) => (
          <button key={s} className={`sd-chip ${scheda === s ? 'on' : ''}`} onClick={() => setScheda(s)}>
            {s === 'google' ? 'Google' : s === 'linkedin' ? 'LinkedIn' : 'Instagram'}
          </button>
        ))}
      </div>

      {scheda === 'google' && (
        <AnteprimaGoogle articolo={articolo} copertina={copertina} nomeStudio={nomeStudio} dominio={dominio} iniziale={iniziale} />
      )}
      {scheda === 'linkedin' && (
        <AnteprimaLinkedin
          conversazione={conversazione}
          articolo={articolo}
          copertina={copertina}
          nomeStudio={nomeStudio}
          dominio={dominio}
          iniziale={iniziale}
          promemoria={social.linkedinIl}
          onPromemoria={(linkedinIl) => onCambiaSocial({ ...social, linkedinIl })}
          onCambia={(linkedin) => onCambiaArticolo({ ...articolo, linkedin })}
        />
      )}
      {scheda === 'instagram' && (
        <AnteprimaInstagram
          conversazione={conversazione}
          articolo={articolo}
          copertina={copertina}
          nomeStudio={nomeStudio}
          dominio={dominio}
          promemoria={social.instagramIl}
          onPromemoria={(instagramIl) => onCambiaSocial({ ...social, instagramIl })}
          onCambia={(instagram) => onCambiaArticolo({ ...articolo, instagram })}
        />
      )}
    </div>
  );
}

function AnteprimaGoogle({ articolo, copertina, nomeStudio, dominio, iniziale }: { articolo: Articolo; copertina: string; nomeStudio: string; dominio: string; iniziale: string }) {
  const data = new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });
  const titolo = articolo.metaTitolo || articolo.titolo;
  return (
    <div className="sd-card sd-serp">
      <div className="sd-serp-body">
        <div className="u">
          <i>{iniziale}</i>
          <div>
            {nomeStudio || dominio}
            <small>
              https://{dominio.includes('.') ? dominio : '…'} › posts › {articolo.slug.length > 28 ? `${articolo.slug.slice(0, 28)}…` : articolo.slug}
            </small>
          </div>
        </div>
        <div className="t">{titolo.length > 62 ? `${titolo.slice(0, 60)}…` : titolo}</div>
        <div className="s">
          {data} — {articolo.metaDescrizione.length > 160 ? `${articolo.metaDescrizione.slice(0, 157)}…` : articolo.metaDescrizione}
        </div>
      </div>
      {copertina && (
        <div className="sd-serp-th">
          <img src={copertina} alt="" />
        </div>
      )}
    </div>
  );
}

function Promemoria({ valore, onCambia, etichetta }: { valore?: string; onCambia: (v: string | undefined) => void; etichetta: string }) {
  return (
    <label className="sd-promemoria" title="Compare nel calendario: la pubblicazione sui social resta tua">
      {etichetta}
      <input type="datetime-local" value={aLocaleInput(valore)} onChange={(e) => onCambia(daLocaleInput(e.target.value))} />
    </label>
  );
}

function AnteprimaLinkedin(props: {
  conversazione: ConversazioneSito;
  articolo: Articolo;
  copertina: string;
  nomeStudio: string;
  dominio: string;
  iniziale: string;
  promemoria?: string;
  onPromemoria: (v: string | undefined) => void;
  onCambia: (testo: string) => void;
}) {
  const { conversazione, articolo, copertina, nomeStudio, dominio, iniziale } = props;
  const [modifica, setModifica] = useState(false);
  const [tutto, setTutto] = useState(false);
  const [copiato, setCopiato] = useState(false);
  const testo = articolo.linkedin ?? '';
  const pubblicato = conversazione.sito?.stato === 'pubblicato';
  const corto = testo.length > 220 && !tutto;

  async function copia() {
    await navigator.clipboard.writeText(testo);
    setCopiato(true);
    setTimeout(() => setCopiato(false), 1500);
  }

  if (!testo && !modifica) {
    return (
      <div className="sd-card sd-vuoto-prev">
        Il post LinkedIn arriva con la prossima versione dell'articolo. Puoi chiederlo a JarAI («prepara il post LinkedIn»)
        o scriverlo tu.
        <button className="btn" onClick={() => setModifica(true)}>Scrivi il post</button>
      </div>
    );
  }

  return (
    <>
      <div className="sd-card sd-li">
        <div className="top">
          <div className="av">{iniziale}</div>
          <div>
            <div className="nm">{nomeStudio || dominio}</div>
            <div className="sub">{articolo.categorie.join(', ') || 'Studio legale'} · ora</div>
          </div>
        </div>
        {modifica ? (
          <textarea className="sd-li-edit" value={testo} autoFocus onChange={(e) => props.onCambia(e.target.value)} rows={8} />
        ) : (
          <div className="txt">
            {corto ? `${testo.slice(0, 210).trimEnd()}` : testo}
            {corto && (
              <button className="more" onClick={() => setTutto(true)}>
                …altro
              </button>
            )}
          </div>
        )}
        <div className="lk">
          {copertina ? <img className="img" src={copertina} alt="" /> : <div className="img vuota">{articolo.titolo}</div>}
          <div className="cap">
            <b>{articolo.metaTitolo || articolo.titolo}</b>
            <small>{dominio}</small>
          </div>
        </div>
        <div className="bar">
          <span>Consiglia</span>
          <span>Commenta</span>
          <span>Diffondi</span>
          <span>Invia</span>
        </div>
      </div>
      <div className="sd-prev-azioni">
        <button className="btn" onClick={() => void copia()} disabled={!testo}>
          {copiato ? 'Copiato ✓' : 'Copia testo'}
        </button>
        <button className="btn" onClick={() => setModifica((m) => !m)}>
          {modifica ? 'Fatto' : 'Modifica testo del post'}
        </button>
        <button
          className="btn primary"
          disabled={!pubblicato}
          title={pubblicato ? 'Copia il testo, poi incollalo nel post che si apre' : 'Disponibile dopo la pubblicazione dell\'articolo'}
          onClick={() => {
            void copia();
            if (conversazione.sito) void window.jarai.sito.condividiLinkedin(conversazione.sito.urlPubblico);
          }}
        >
          Condividi su LinkedIn ↗
        </button>
        <Promemoria valore={props.promemoria} onCambia={props.onPromemoria} etichetta="Promemoria" />
      </div>
    </>
  );
}

export function SlideAnteprima({ s, i, n, sfondo, firma, dominio }: { s: SlideInstagram; i: number; n: number; sfondo: string; firma: string; dominio: string }) {
  const prima = i === 0;
  const ultima = i === n - 1;
  const parti = s.testo.split(/(\*\*[^*]+\*\*)/g);
  return (
    <div className={`sd-slide ${prima || ultima ? '' : 'light'}`}>
      {prima && sfondo && (
        <div className="bgph">
          <img src={sfondo} alt="" />
        </div>
      )}
      <span className="pg">
        {i + 1}/{n}
      </span>
      <span className="k">{s.titoletto}</span>
      <span className={prima || ultima ? 'h' : 'p'}>
        {parti.map((p, j) => (p.startsWith('**') && p.endsWith('**') ? <b key={j}>{p.slice(2, -2)}</b> : <span key={j}>{p}</span>))}
      </span>
      <span className="f">
        <span>{ultima ? dominio : firma}</span>
        <span>{prima ? 'scorri →' : ''}</span>
      </span>
    </div>
  );
}

function AnteprimaInstagram(props: {
  conversazione: ConversazioneSito;
  articolo: Articolo;
  copertina: string;
  nomeStudio: string;
  dominio: string;
  promemoria?: string;
  onPromemoria: (v: string | undefined) => void;
  onCambia: (ig: NonNullable<Articolo['instagram']>) => void;
}) {
  const { conversazione, articolo, copertina, nomeStudio, dominio } = props;
  const [modifica, setModifica] = useState(false);
  const [stato, setStato] = useState<string | null>(null);
  const ig = articolo.instagram;
  // Le foto fanno da sfondo alla prima slide; le copertine con il titolo no.
  const sfondo = conversazione.copertina && conversazione.copertina.origine !== 'copertina' ? copertina : '';

  if (!ig?.slide.length) {
    return (
      <div className="sd-card sd-vuoto-prev">
        Il carosello Instagram arriva con la prossima versione dell'articolo: chiedilo a JarAI («prepara il carosello
        Instagram»).
      </div>
    );
  }

  async function salva() {
    if (!ig) return;
    setStato('Preparo le immagini…');
    const esito = await window.jarai.sito.salvaCarosello({
      slide: ig.slide,
      firma: nomeStudio || dominio,
      sito: dominio,
      sfondo: sfondo ? conversazione.copertina?.file : undefined,
      nome: articolo.slug || articolo.titolo,
    });
    if (!esito.ok) setStato(esito.errore);
    else setStato(esito.dati ? `Salvate ${ig.slide.length} immagini in ${esito.dati}` : null);
  }

  const cambiaSlide = (i: number, patch: Partial<SlideInstagram>) =>
    props.onCambia({ ...ig, slide: ig.slide.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  const didascalia = ig.didascalia.split(/(#[\p{L}\p{N}_]+)/gu);

  return (
    <>
      <div className="sd-ig-wrap">
        {ig.slide.map((s, i) => (
          <SlideAnteprima key={i} s={s} i={i} n={ig.slide.length} sfondo={sfondo} firma={nomeStudio || dominio} dominio={dominio} />
        ))}
      </div>
      {modifica ? (
        <div className="sd-card sd-ig-edit">
          {ig.slide.map((s, i) => (
            <div key={i} className="riga">
              <span className="n">{i + 1}</span>
              <input value={s.titoletto} onChange={(e) => cambiaSlide(i, { titoletto: e.target.value })} />
              <textarea value={s.testo} rows={2} onChange={(e) => cambiaSlide(i, { testo: e.target.value })} />
            </div>
          ))}
          <div className="riga">
            <span className="n">✎</span>
            <textarea
              className="largo"
              value={ig.didascalia}
              rows={4}
              onChange={(e) => props.onCambia({ ...ig, didascalia: e.target.value })}
            />
          </div>
        </div>
      ) : (
        <div className="sd-card sd-caption">
          {didascalia.map((p, i) => (p.startsWith('#') ? <span key={i} className="hash">{p}</span> : <span key={i}>{p}</span>))}
        </div>
      )}
      <div className="sd-prev-azioni">
        <button className="btn" onClick={() => setModifica((m) => !m)}>{modifica ? 'Fatto' : 'Modifica slide'}</button>
        <button className="btn" onClick={() => void navigator.clipboard.writeText(ig.didascalia)}>Copia didascalia</button>
        <button className="btn primary" onClick={() => void salva()}>Salva le {ig.slide.length} immagini</button>
        <Promemoria valore={props.promemoria} onCambia={props.onPromemoria} etichetta="Promemoria" />
      </div>
      {stato && <div className="sd-nota">{stato}</div>}
      <div className="sd-nota">Pubblicazione diretta su Instagram: in un secondo momento (account Meta Business).</div>
    </>
  );
}
