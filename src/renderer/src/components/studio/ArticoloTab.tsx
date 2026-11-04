import { useEffect, useRef, useState } from 'react';
import type { Articolo, ConversazioneSito, Copertina } from '../../types';
import CopertinaArticolo from '../CopertinaArticolo';
import Markdown from '../Markdown';
import { GlobeIcon, SendIcon, StopIcon } from '../icons';
import AnteprimeArticolo from './AnteprimeArticolo';
import EditorArticolo from './EditorArticolo';
import type { StudioDigitaleApi } from './useStudioDigitale';
import { aLocaleInput, daLocaleInput, dataOraBreve, oraBreve } from './util';

interface ArticoloSito {
  titolo: string;
  url: string;
}

interface Props {
  conversazioni: ConversazioneSito[];
  attivaId: string | null;
  onApri: (id: string | null) => void;
  api: StudioDigitaleApi;
  sitoCollegato: boolean | null;
  sitoUrl: string | null;
  nomeStudio: string;
  articoliSito: ArticoloSito[];
  onElimina: (id: string) => void;
  onVaiImpostazioni: () => void;
}

const SPUNTI = [
  'Quali novità normative o sentenze recenti meritano un articolo per i nostri clienti?',
  'Quali domande frequenti dei clienti non hanno ancora un articolo sul sito?',
];

export const nuovoIdArticolo = () => `sd-${crypto.randomUUID()}`;

export default function ArticoloTab(props: Props) {
  const { conversazioni, attivaId, onApri } = props;
  const [confermaElimina, setConfermaElimina] = useState<string | null>(null);
  const attiva = conversazioni.find((c) => c.id === attivaId) ?? null;
  const [nuovaId, setNuovaId] = useState(nuovoIdArticolo);

  return (
    <div className="sd-art-layout">
      <div className="sd-elenco">
        <button
          className="btn primary sd-nuovo"
          onClick={() => {
            setNuovaId(nuovoIdArticolo());
            onApri(null);
          }}
        >
          + Nuovo articolo
        </button>
        <div className="sd-elenco-scroll">
          {conversazioni.length === 0 && <div className="sd-elenco-vuoto">Ancora nessun articolo.</div>}
          {conversazioni.map((c) =>
            confermaElimina === c.id ? (
              <div key={c.id} className="pratica-convo-item conferma-elimina">
                <span className="nm">Eliminare?</span>
                <button
                  className="conferma-si"
                  onClick={() => {
                    props.onElimina(c.id);
                    setConfermaElimina(null);
                    if (attivaId === c.id) onApri(null);
                  }}
                >
                  Sì
                </button>
                <button className="conferma-no" onClick={() => setConfermaElimina(null)}>
                  No
                </button>
              </div>
            ) : (
              <div
                key={c.id}
                className={`pratica-convo-item sd-voce ${c.id === attivaId ? 'attiva' : ''}`}
                onClick={() => onApri(c.id)}
                title={c.titolo}
              >
                <span className={`sd-pallino ${c.programmataPer ? 'programmato' : (c.sito?.stato ?? 'locale')}`} />
                <span className="nm">{c.titolo}</span>
                <button
                  className="convo-delete"
                  title="Elimina da JarAI (non tocca il sito)"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfermaElimina(c.id);
                  }}
                >
                  ×
                </button>
              </div>
            ),
          )}
        </div>
        <div className="sd-legenda">
          <span><span className="sd-pallino locale" /> in JarAI</span>
          <span><span className="sd-pallino bozza" /> bozza sul sito</span>
          <span><span className="sd-pallino programmato" /> programmato</span>
          <span><span className="sd-pallino pubblicato" /> pubblicato</span>
        </div>
      </div>

      <Lavoro key={attiva?.id ?? nuovaId} {...props} id={attiva?.id ?? nuovaId} conversazione={attiva} />
    </div>
  );
}

// Testo per l'assistente: se l'avvocato ha modificato l'articolo a mano,
// la versione attuale viaggia con la richiesta (spec §5.11).
function testoPerAgente(richiesta: string, c: ConversazioneSito | null): string {
  if (!c?.articolo || !c.modificato) return richiesta;
  const a = c.articolo;
  return `${richiesta}

Versione attuale dell'articolo (modificata da me, parti da questa):
Titolo: ${a.titolo}
Slug: ${a.slug}
Titolo Google: ${a.metaTitolo}
Descrizione Google: ${a.metaDescrizione}
Categorie: ${a.categorie.join(', ')}
${a.linkedin ? `Post LinkedIn:\n${a.linkedin}\n` : ''}${a.instagram ? `Carosello Instagram:\n${a.instagram.slide.map((s, i) => `${i + 1}. ${s.titoletto}: ${s.testo}`).join('\n')}\nDidascalia: ${a.instagram.didascalia}\n` : ''}
Testo:
${a.contenuto}`;
}

function Lavoro({
  id,
  conversazione,
  api,
  sitoCollegato,
  sitoUrl,
  nomeStudio,
  articoliSito,
  onApri,
  onVaiImpostazioni,
}: Props & { id: string; conversazione: ConversazioneSito | null }) {
  const lavoro = api.lavori[id];
  const elaborando = lavoro?.elaborando ?? false;
  const [chat, setChat] = useState(false);
  const [richiesta, setRichiesta] = useState('');
  const [qualita, setQualita] = useState<'Standard' | 'Massima'>('Standard');
  const articolo = conversazione?.articolo;

  function chiedi(testo: string) {
    const t = testo.trim();
    if (!t || elaborando) return;
    api.invia(id, t, testoPerAgente(t, conversazione), qualita);
    setRichiesta('');
    onApri(id);
  }

  if (!articolo) {
    return (
      <div className="sd-lavoro">
        <ChatArticolo
          conversazione={conversazione}
          lavoro={lavoro}
          vuoto={
            <div className="home-empty">
              <div className="home-empty-icon">
                <GlobeIcon size={38} />
              </div>
              <div className="home-empty-title">Un articolo per il sito dello studio</div>
              <div className="home-empty-sub">
                Parto dagli articoli già pubblicati{sitoUrl ? ` su ${sitoUrl.replace(/^https?:\/\//, '')}` : ''} e preparo testo,
                dati per Google, copertina, post LinkedIn e carosello Instagram. Qui non vedo le pratiche. Nulla va online senza
                il tuo clic.
              </div>
              <div className="sd-spunti">
                {SPUNTI.map((s) => (
                  <button key={s} className="sd-spunto" onClick={() => chiedi(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          }
          avviso={
            sitoCollegato === false && (
              <div className="sd-avviso">
                Il sito dello studio non è collegato: posso scrivere articoli, ma non conosco quelli già pubblicati e non posso
                inviarli al sito.
                <button className="btn" onClick={onVaiImpostazioni}>Collega il sito</button>
              </div>
            )
          }
          input={richiesta}
          setInput={setRichiesta}
          qualita={qualita}
          setQualita={setQualita}
          onInvia={() => chiedi(richiesta)}
          onFerma={() => api.ferma(id)}
          placeholder="Su cosa scriviamo? Es. «Scrivi un articolo sull'assegno di mantenimento ai figli maggiorenni»"
        />
      </div>
    );
  }

  return (
    <div className="sd-lavoro con-editor">
      <div className="sd-lavoro-scroll">
        <Spazio
          id={id}
          conversazione={conversazione!}
          articolo={articolo}
          api={api}
          sitoCollegato={sitoCollegato === true}
          sitoUrl={sitoUrl}
          nomeStudio={nomeStudio}
          articoliSito={articoliSito}
          richiesta={richiesta}
          setRichiesta={setRichiesta}
          onChiedi={chiedi}
          onApriChat={() => setChat(true)}
          numeroMessaggi={conversazione!.messaggi.length}
        />
      </div>
      {chat && (
        <div className="sd-chat-drawer">
          <div className="sd-chat-drawer-head">
            <span>Conversazione con JarAI</span>
            <button className="btn-icon" title="Chiudi" onClick={() => setChat(false)}>×</button>
          </div>
          <ChatArticolo
            conversazione={conversazione}
            lavoro={lavoro}
            input={richiesta}
            setInput={setRichiesta}
            qualita={qualita}
            setQualita={setQualita}
            onInvia={() => chiedi(richiesta)}
            onFerma={() => api.ferma(id)}
            placeholder="Chiedi una correzione…"
            compatta
          />
        </div>
      )}
    </div>
  );
}

// ─── Spazio di lavoro sull'articolo ─────────────────────────────────────

function Spazio(p: {
  id: string;
  conversazione: ConversazioneSito;
  articolo: Articolo;
  api: StudioDigitaleApi;
  sitoCollegato: boolean;
  sitoUrl: string | null;
  nomeStudio: string;
  articoliSito: ArticoloSito[];
  richiesta: string;
  setRichiesta: (v: string) => void;
  onChiedi: (t: string) => void;
  onApriChat: () => void;
  numeroMessaggi: number;
}) {
  const { id, conversazione: c, articolo, api } = p;
  const lavoro = api.lavori[id];
  const [anteprimaCopertina, setAnteprimaCopertina] = useState('');
  const [versioni, setVersioni] = useState(false);
  const dominio = (p.sitoUrl ?? '').replace(/^https?:\/\//, '') || 'sito dello studio';
  const elencoVersioni = c.messaggi.filter((m) => m.articolo);

  useEffect(() => {
    if (!c.copertina) {
      setAnteprimaCopertina('');
      return;
    }
    let annullato = false;
    void window.jarai.sito.anteprimaImmagine(c.copertina.file).then((u) => !annullato && setAnteprimaCopertina(u));
    return () => {
      annullato = true;
    };
  }, [c.copertina?.file]);

  // L'avvocato può aver pubblicato o cancellato dal pannello del sito.
  useEffect(() => {
    if (!c.sito || !p.sitoCollegato) return;
    const sito = c.sito;
    void window.jarai.sito.statoArticolo(sito.id).then((esito) => {
      if (!esito.ok || !esito.dati || esito.dati.stato === sito.stato) return;
      const { copertinaMediaId: _ignora, ...dati } = esito.dati;
      api.aggiorna(id, (x) => ({ ...x, sito: { ...dati, aggiornatoIl: sito.aggiornatoIl } }));
    });
    // Solo all'apertura dell'articolo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const modifica = (a: Partial<Articolo>) =>
    api.aggiorna(id, (x) => ({
      ...x,
      titolo: a.titolo ?? x.titolo,
      articolo: { ...(x.articolo ?? articolo), ...a },
      modificato: true,
      modificataIl: new Date().toISOString(),
    }));

  const cambiaCopertina = (copertina: Copertina | undefined) =>
    api.aggiorna(id, (x) => ({ ...x, copertina, modificataIl: new Date().toISOString() }));

  return (
    <div className="sd-spazio">
      <div className="sd-riga between">
        <StatoArticolo c={c} versione={elencoVersioni.length} />
        <div className="sd-riga">
          {articolo.categorie.map((cat) => (
            <span key={cat} className="sd-chip statico">{cat}</span>
          ))}
          <div className="sd-versioni">
            <button className="btn ghost sm" onClick={() => setVersioni((v) => !v)} disabled={elencoVersioni.length < 2}>
              Versioni
            </button>
            {versioni && (
              <div className="sd-versioni-menu">
                {elencoVersioni.map((m, i) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      api.aggiorna(id, (x) => ({
                        ...x,
                        titolo: m.articolo!.titolo,
                        articolo: m.articolo,
                        modificato: true,
                        modificataIl: new Date().toISOString(),
                      }));
                      setVersioni(false);
                    }}
                  >
                    Versione {i + 1} · {m.articolo!.titolo}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="btn ghost sm" onClick={p.onApriChat}>
            Conversazione ({p.numeroMessaggi})
          </button>
        </div>
      </div>

      <input className="sd-titolo" value={articolo.titolo} onChange={(e) => modifica({ titolo: e.target.value })} />

      <div className="sd-card sd-campi">
        <label>Indirizzo</label>
        <div className="fw">
          <span className="pre mono">/posts/</span>
          <input className="mono" value={articolo.slug} onChange={(e) => modifica({ slug: e.target.value })} />
        </div>
        <label>Titolo Google</label>
        <div className="fw">
          <input value={articolo.metaTitolo} onChange={(e) => modifica({ metaTitolo: e.target.value })} />
          <Conteggio n={articolo.metaTitolo.length} max={60} />
        </div>
        <label>Descrizione</label>
        <div className="fw">
          <input value={articolo.metaDescrizione} onChange={(e) => modifica({ metaDescrizione: e.target.value })} />
          <Conteggio n={articolo.metaDescrizione.length} max={155} />
        </div>
      </div>

      <div className="sd-copertina-larga">
        <CopertinaArticolo
          articolo={articolo}
          copertina={c.copertina}
          firma={p.nomeStudio || dominio}
          sitoCollegato={p.sitoCollegato}
          onCambia={cambiaCopertina}
        />
      </div>

      <EditorArticolo contenuto={articolo.contenuto} articoliSito={p.articoliSito} onCambia={(contenuto) => modifica({ contenuto })} />

      <form
        className="sd-ask"
        onSubmit={(e) => {
          e.preventDefault();
          p.onChiedi(p.richiesta);
        }}
      >
        {lavoro?.elaborando ? (
          <>
            <span className="sd-ask-stato">◌ {lavoro.attivita ?? 'JarAI sta scrivendo…'}</span>
            <button type="button" className="btn sm" onClick={() => api.ferma(id)}>Ferma</button>
          </>
        ) : (
          <>
            <input
              value={p.richiesta}
              onChange={(e) => p.setRichiesta(e.target.value)}
              placeholder="Chiedi una modifica a JarAI: «accorcia l'introduzione», «aggiungi un esempio»…"
            />
            <button type="button" className="sd-chip" onClick={() => p.onChiedi('Rendi il testo più semplice da leggere, senza perdere precisione.')}>
              Rendi più semplice
            </button>
            <button
              type="button"
              className="sd-chip"
              onClick={() => p.onChiedi('Verifica i riferimenti normativi e giurisprudenziali citati e dimmi se qualcosa non torna.')}
            >
              Verifica i riferimenti
            </button>
          </>
        )}
      </form>

      {!!articolo.daVerificare?.length && (
        <div className="sd-warn">
          ⚠ Da verificare prima di pubblicare: {articolo.daVerificare.join(' · ')}
        </div>
      )}

      <AnteprimeArticolo
        conversazione={c}
        articolo={articolo}
        copertina={anteprimaCopertina}
        nomeStudio={p.nomeStudio}
        dominio={dominio}
        onCambiaArticolo={(a) => modifica(a)}
        onCambiaSocial={(social) => api.aggiorna(id, (x) => ({ ...x, social }))}
      />

      <BarraAzioni id={id} c={c} articolo={articolo} api={api} sitoCollegato={p.sitoCollegato} />
    </div>
  );
}

function Conteggio({ n, max }: { n: number; max: number }) {
  return <span className={`sd-conteggio ${n > max ? 'oltre' : ''}`}>{n}/{max}</span>;
}

function nonInviate(c: ConversazioneSito): boolean {
  return !!c.sito && !!c.modificataIl && Date.parse(c.modificataIl) > Date.parse(c.sito.aggiornatoIl);
}

function StatoArticolo({ c, versione }: { c: ConversazioneSito; versione: number }) {
  const classe = c.programmataPer ? 'programmato' : (c.sito?.stato ?? 'locale');
  let testo = 'Non ancora sul sito';
  if (c.programmataPer) testo = `Programmato: si pubblica ${dataOraBreve(c.programmataPer)}`;
  else if (c.sito?.stato === 'bozza') testo = `Bozza sul sito, non visibile · inviata alle ${oraBreve(c.sito.aggiornatoIl)}`;
  else if (c.sito?.stato === 'pubblicato') testo = `Pubblicato sul sito · ${dataOraBreve(c.sito.aggiornatoIl)}`;
  return (
    <div className={`sd-art-stato ${classe}`}>
      <span className="dot" />
      {testo}
      {versione > 0 && ` · versione ${versione}`}
      {nonInviate(c) && <span className="sd-non-inviate"> · modifiche non ancora inviate al sito</span>}
      {c.ultimoErroreProgrammazione && <span className="sd-non-inviate"> · {c.ultimoErroreProgrammazione}</span>}
    </div>
  );
}

// ─── Azioni sul sito: sempre clic dell'avvocato ─────────────────────────

function domaniAlleNove(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

function BarraAzioni({ id, c, articolo, api, sitoCollegato }: { id: string; c: ConversazioneSito; articolo: Articolo; api: StudioDigitaleApi; sitoCollegato: boolean }) {
  const [inCorso, setInCorso] = useState<'invio' | 'programma' | 'pubblica' | null>(null);
  const [conferma, setConferma] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  // Valore dell'input datetime-local; parte dal giorno previsto nel calendario, se c'è.
  const [quando, setQuando] = useState(() => (c.dataPrevista ? `${c.dataPrevista}T09:00` : aLocaleInput(domaniAlleNove())));
  const quandoIso = daLocaleInput(quando) ?? domaniAlleNove();

  // Invia l'ultima versione come bozza e restituisce l'id del post sul sito.
  async function invia(): Promise<number | string | null> {
    setErrore(null);
    const esito = await window.jarai.sito.inviaBozza(articolo, c.sito?.id, c.copertina);
    if (!esito.ok) {
      setErrore(esito.errore);
      return null;
    }
    const { copertinaMediaId, ...dati } = esito.dati;
    api.aggiorna(id, (x) => ({
      ...x,
      copertina:
        x.copertina && copertinaMediaId !== undefined && x.copertina.mediaId === undefined
          ? { ...x.copertina, mediaId: copertinaMediaId }
          : x.copertina,
      // Una nuova bozza su un articolo pubblicato non lo ritira dal sito.
      sito: { ...dati, stato: x.sito?.stato === 'pubblicato' ? 'pubblicato' : 'bozza', aggiornatoIl: new Date().toISOString() },
    }));
    return dati.id;
  }

  async function aggiornaBozza() {
    setInCorso('invio');
    await invia();
    setInCorso(null);
  }

  async function programma() {
    setInCorso('programma');
    const postId = await invia();
    if (postId !== null) {
      const esito = await window.jarai.sito.programma({ conversazioneId: id, postId, titolo: articolo.titolo, quando: quandoIso });
      if (!esito.ok) setErrore(esito.errore);
      else api.aggiorna(id, (x) => ({ ...x, programmataPer: quandoIso, ultimoErroreProgrammazione: undefined, dataPrevista: undefined }));
    }
    setInCorso(null);
  }

  async function annullaProgrammazione() {
    const esito = await window.jarai.sito.annullaProgrammazione(id);
    if (!esito.ok) setErrore(esito.errore);
    else api.aggiorna(id, (x) => ({ ...x, programmataPer: undefined, ultimoErroreProgrammazione: undefined }));
  }

  async function pubblica() {
    setInCorso('pubblica');
    // Prima l'ultima versione come bozza, poi la pubblicazione di quella.
    const postId = await invia();
    if (postId !== null) {
      const esito = await window.jarai.sito.pubblica(postId);
      if (!esito.ok) setErrore(esito.errore);
      else {
        if (c.programmataPer) await window.jarai.sito.annullaProgrammazione(id);
        const { copertinaMediaId: _ignora, ...dati } = esito.dati;
        api.aggiorna(id, (x) => ({ ...x, programmataPer: undefined, sito: { ...dati, aggiornatoIl: new Date().toISOString() } }));
      }
    }
    setInCorso(null);
    setConferma(false);
  }

  const occupato = inCorso !== null;

  return (
    <>
      {conferma && (
        <div className="confirm-inline sd-conferma-larga">
          <div className="confirm-inline-title">⚠ Serve la tua conferma</div>
          <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 4, lineHeight: 1.5 }}>
            «{articolo.titolo}» sarà visibile a tutti sul sito dello studio, in questa versione. Controlla date, riferimenti
            normativi e che non ci siano dati di clienti.
          </div>
          <div className="confirm-inline-actions">
            <button className="btn" onClick={() => setConferma(false)}>Annulla</button>
            <button className="btn primary" onClick={() => void pubblica()} disabled={occupato}>
              {inCorso === 'pubblica' ? 'Pubblicazione…' : 'Pubblica ora'}
            </button>
          </div>
        </div>
      )}
      {errore && <div className="sd-errore-largo">{errore}</div>}
      <div className="sd-card sd-actionbar">
        <button className="btn" onClick={() => void aggiornaBozza()} disabled={!sitoCollegato || occupato} title={sitoCollegato ? undefined : 'Collega prima il sito da Impostazioni'}>
          {inCorso === 'invio' ? 'Invio…' : c.sito ? 'Aggiorna bozza sul sito' : 'Invia al sito come bozza'}
        </button>
        {c.sito && (
          <button className="btn ghost" onClick={() => void window.jarai.sito.apri(c.sito!.urlModifica)}>Apri nel pannello del sito</button>
        )}
        {c.sito?.stato === 'pubblicato' && (
          <button className="btn ghost" onClick={() => void window.jarai.sito.apri(c.sito!.urlPubblico)}>Vedi l'articolo</button>
        )}
        <span style={{ flex: 1 }} />
        {c.sito?.stato !== 'pubblicato' &&
          (c.programmataPer ? (
            <span className="sd-sched on">
              Si pubblica da solo <b>{dataOraBreve(c.programmataPer)}</b>
              <button className="btn sm" onClick={() => void annullaProgrammazione()}>Annulla</button>
            </span>
          ) : (
            <span className="sd-sched" title="La pubblicazione la esegue JarAI: all'ora scelta se è aperto, altrimenti appena lo riapri">
              Programma per
              <input type="datetime-local" value={quando} onChange={(e) => setQuando(e.target.value)} />
              <button className="btn sm" onClick={() => void programma()} disabled={!sitoCollegato || occupato}>
                {inCorso === 'programma' ? '…' : '✓'}
              </button>
            </span>
          ))}
        <button className="btn primary" onClick={() => setConferma(true)} disabled={!sitoCollegato || occupato || conferma}>
          {c.sito?.stato === 'pubblicato' ? 'Pubblica le modifiche…' : 'Pubblica ora…'}
        </button>
      </div>
      {c.programmataPer && (
        <div className="sd-nota">
          La pubblicazione la esegue JarAI: all'ora indicata se è aperto, altrimenti appena lo riapri.
        </div>
      )}
    </>
  );
}

// ─── Conversazione ──────────────────────────────────────────────────────

function ChatArticolo(p: {
  conversazione: ConversazioneSito | null;
  lavoro?: { elaborando: boolean; attivita: string | null; parziale: string };
  vuoto?: React.ReactNode;
  avviso?: React.ReactNode;
  input: string;
  setInput: (v: string) => void;
  qualita: 'Standard' | 'Massima';
  setQualita: (q: 'Standard' | 'Massima') => void;
  onInvia: () => void;
  onFerma: () => void;
  placeholder: string;
  compatta?: boolean;
}) {
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const messaggi = p.conversazione?.messaggi ?? [];
  const lavoro = p.lavoro;

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [messaggi.length, lavoro?.parziale, lavoro?.attivita]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [p.input]);

  const vuota = messaggi.length === 0 && !lavoro?.elaborando;

  return (
    <div className={`sd-chat ${p.compatta ? 'compatta' : ''}`}>
      {p.avviso}
      <div className="chat-thread" ref={threadRef}>
        {vuota
          ? p.vuoto
          : messaggi.map((m) => (
              <div key={m.id} className={`msg ${m.ruolo === 'avvocato' ? 'msg-user' : 'msg-assistant'}`}>
                <div className="msg-avatar">{m.ruolo === 'avvocato' ? 'TU' : 'AI'}</div>
                <div className="msg-body">
                  <div className="msg-text">
                    {m.ruolo === 'avvocato' ? <p>{m.testo}</p> : <Markdown>{m.testo}</Markdown>}
                  </div>
                  {m.articolo && <div className="sd-versione-chip">📰 {m.articolo.titolo}</div>}
                </div>
              </div>
            ))}
        {lavoro?.parziale && (
          <div className="msg msg-assistant">
            <div className="msg-avatar">AI</div>
            <div className="msg-body">
              <div className="msg-text">
                <Markdown>{lavoro.parziale}</Markdown>
                <span className="streaming-cursor" />
              </div>
            </div>
          </div>
        )}
        {lavoro?.elaborando && lavoro.attivita && <div className="artifact-processing">◌ {lavoro.attivita}</div>}
      </div>
      <div className="composer-wrap">
        <div className="composer">
          <textarea
            ref={composerRef}
            className="composer-input"
            rows={1}
            placeholder={p.placeholder}
            value={p.input}
            onChange={(e) => p.setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                p.onInvia();
              }
            }}
          />
          {!p.compatta && (
            <select className="procedura-select" value={p.qualita} onChange={(e) => p.setQualita(e.target.value as 'Standard' | 'Massima')}>
              <option value="Standard">Standard</option>
              <option value="Massima">Massima</option>
            </select>
          )}
          {lavoro?.elaborando ? (
            <button className="composer-send ready" onClick={p.onFerma} title="Ferma">
              <StopIcon />
            </button>
          ) : (
            <button className={`composer-send ${p.input.trim() ? 'ready' : ''}`} onClick={p.onInvia} disabled={!p.input.trim()}>
              <SendIcon size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
