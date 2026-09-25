import { useEffect, useRef, useState } from 'react';
import type { Bozza, Conversazione, Documento, LavoroDocumento, Messaggio, Pratica, Procedura } from '../types';
import { PROCEDURE } from '../types';
import PlanPanel from './PlanPanel';
import Markdown from './Markdown';
import { FolderIcon, SendIcon, StopIcon } from './icons';

interface Props {
  pratiche: Pratica[];
  praticaId: string | null;
  conversazione: Conversazione | null;
  documenti: Record<string, Documento[]>;
  onSalva: (c: Conversazione) => void;
}

// crypto.randomUUID(), non un contatore: un contatore in memoria riparte da
// zero a ogni riavvio, mentre le conversazioni restano salvate — due
// conversazioni create in sessioni diverse potevano finire con lo stesso id.
const nextId = () => crypto.randomUUID();

export default function ConversazioneView({ pratiche, praticaId, conversazione, documenti, onSalva }: Props) {
  const pratica = pratiche.find((p) => p.id === (conversazione?.praticaId ?? praticaId)) ?? null;
  const documentiPratica = pratica ? (documenti[pratica.id] ?? []) : [];

  const conversazioneIdRef = useRef(conversazione?.id ?? nextId());
  const [messaggi, setMessaggi] = useState<Messaggio[]>(conversazione?.messaggi ?? []);
  const piano = conversazione?.piano;
  const [procedura, setProcedura] = useState<Procedura>(conversazione?.procedura ?? PROCEDURE[0]);
  const [input, setInput] = useState('');
  const [elaborando, setElaborando] = useState(false);
  const [attivita, setAttivita] = useState<string | null>(conversazione?.attivitaCorrente ?? null);
  const [lavori, setLavori] = useState<LavoroDocumento[]>([]);
  const [qualita, setQualita] = useState<'Standard' | 'Massima'>('Standard');
  const [confermaVisibile, setConfermaVisibile] = useState(conversazione?.stato === 'attesa');
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // La bozza arriva via un tool_use durante il turno, prima del testo finale:
  // resta qui finché il messaggio non si chiude, poi si aggancia a quello.
  const bozzaInCorsoRef = useRef<Bozza | null>(null);
  const [bozzaAperta, setBozzaAperta] = useState<Bozza | null>(null);

  // Il composer si allarga con il testo, come su T3 Code, fino al limite in
  // CSS (composer-input, max-height) — oltre scorre invece di crescere.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  useEffect(() => {
    const id = conversazioneIdRef.current;
    return window.jarai.claude.onEvento((evento) => {
      if (evento.conversazioneId !== id) return;

      if (evento.tipo === 'attivita') {
        setAttivita(evento.testo);
        return;
      }

      if (evento.tipo === 'lavori') {
        setLavori(evento.lavori);
        return;
      }

      if (evento.tipo === 'bozza') {
        bozzaInCorsoRef.current = { titolo: evento.titolo, contenuto: evento.contenuto };
        return;
      }

      if (evento.tipo === 'delta') {
        setAttivita(null);
        setMessaggi((prev) => {
          const ultimo = prev[prev.length - 1];
          if (ultimo?.ruolo === 'assistente' && ultimo.isStreaming) {
            return [...prev.slice(0, -1), { ...ultimo, testo: ultimo.testo + evento.testo }];
          }
          return [...prev, { id: nextId(), ruolo: 'assistente', testo: evento.testo, isStreaming: true }];
        });
        return;
      }

      setElaborando(false);
      setAttivita(null);
      setLavori([]);

      if (evento.tipo === 'completato') {
        const bozza = bozzaInCorsoRef.current ?? undefined;
        bozzaInCorsoRef.current = null;
        setMessaggi((prev) => {
          const ultimo = prev[prev.length - 1];
          const finali: Messaggio[] =
            ultimo?.ruolo === 'assistente' && ultimo.isStreaming
              ? [...prev.slice(0, -1), { ...ultimo, testo: evento.testo, isStreaming: false, bozza }]
              : [...prev, { id: nextId(), ruolo: 'assistente', testo: evento.testo, bozza }];
          onSalva({
            id,
            praticaId: pratica?.id ?? 'senza-pratica',
            titolo: conversazione?.titolo ?? finali.find((m) => m.ruolo === 'avvocato')?.testo.slice(0, 60) ?? 'Conversazione',
            procedura,
            stato: 'completata',
            aggiornataIl: new Date().toISOString(),
            dispositivoOrigine: 'desktop',
            piano,
            messaggi: finali,
          });
          return finali;
        });
      } else if (evento.tipo === 'errore') {
        setMessaggi((prev) => {
          const ultimo = prev[prev.length - 1];
          const finali: Messaggio[] =
            ultimo?.ruolo === 'assistente' && ultimo.isStreaming && !ultimo.testo
              ? [...prev.slice(0, -1), { ...ultimo, testo: evento.messaggio, isStreaming: false }]
              : [...prev, { id: nextId(), ruolo: 'assistente', testo: evento.messaggio }];
          onSalva({
            id,
            praticaId: pratica?.id ?? 'senza-pratica',
            titolo: conversazione?.titolo ?? finali.find((m) => m.ruolo === 'avvocato')?.testo.slice(0, 60) ?? 'Conversazione',
            procedura,
            stato: 'interrotta',
            aggiornataIl: new Date().toISOString(),
            dispositivoOrigine: 'desktop',
            piano,
            messaggi: finali,
          });
          return finali;
        });
      }
    });
  }, [pratica, procedura, piano, conversazione?.titolo, onSalva]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [messaggi, attivita, lavori.length]);

  function invia() {
    const testo = input.trim();
    if (!testo || elaborando) return;
    const msgUtente: Messaggio = { id: nextId(), ruolo: 'avvocato', testo };
    setMessaggi((prev) => [...prev, msgUtente]);
    setInput('');
    setElaborando(true);
    setAttivita('Sto pensando…');
    void window.jarai.claude.invia({
      conversazioneId: conversazioneIdRef.current,
      testo,
      qualita,
      praticaNome: pratica?.nome,
      documenti: documentiPratica.map((d) => ({ nome: d.nome, percorso: d.percorso, cartella: d.cartella, tipo: d.tipo, pagine: d.pagine })),
    });
  }

  function ferma() {
    void window.jarai.claude.ferma(conversazioneIdRef.current);
  }

  const [salvandoBozza, setSalvandoBozza] = useState(false);
  const [esitoSalvataggio, setEsitoSalvataggio] = useState<string | null>(null);

  async function salvaBozzaInWord(bozza: Bozza) {
    setSalvandoBozza(true);
    setEsitoSalvataggio(null);
    const esito = await window.jarai.bozze.salvaDocx(bozza.titolo, bozza.contenuto);
    setSalvandoBozza(false);
    setEsitoSalvataggio(esito.salvato ? `Salvata${esito.percorso ? ` in ${esito.percorso}` : ''}` : null);
  }

  return (
    <div className="home-page">
      <div className="home-topbar">
        <div className="home-topbar-title">
          <h2>{pratica ? pratica.nome : 'Fai una domanda'}</h2>
          <select
            className="procedura-select"
            value={procedura}
            onChange={(e) => setProcedura(e.target.value as Procedura)}
          >
            {PROCEDURE.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="home-actions">
          <select className="procedura-select" value={qualita} onChange={(e) => setQualita(e.target.value as 'Standard' | 'Massima')}>
            <option value="Standard">Qualità: Standard</option>
            <option value="Massima">Qualità: Massima — più lenta</option>
          </select>
        </div>
      </div>

      {piano && piano.length > 0 && <PlanPanel passi={piano} />}

      <div className="chat-thread" ref={threadRef}>
        {messaggi.length === 0 && !attivita ? (
          <div className="home-empty">
            <div className="home-empty-icon">✎</div>
            <div className="home-empty-title">Cosa ti serve oggi?</div>
            <div className="home-empty-sub">
              {pratica
                ? `Fai una domanda sulla pratica «${pratica.nome}» oppure chiedi di redigere un atto.`
                : 'Scegli una pratica dalla sidebar oppure fai una domanda generale.'}
            </div>
          </div>
        ) : (
          messaggi.map((m) => <MessaggioBubble key={m.id} m={m} documenti={documentiPratica} onApriBozza={setBozzaAperta} />)
        )}
        {lavori.some((l) => l.fase !== 'completato') ? (
          <LavoriInCorso lavori={lavori} />
        ) : (
          attivita && <div className="artifact-processing">◌ {attivita}</div>
        )}

        {confermaVisibile && (
          <div className="msg msg-assistant">
            <div className="msg-avatar">AI</div>
            <div className="msg-body">
              <div className="msg-text">Ho preparato il report delle spese ricorrenti. Prima di salvarlo serve la tua conferma.</div>
              <div className="confirm-inline">
                <div className="confirm-inline-title">⚠ Serve la tua conferma</div>
                <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 4 }}>
                  Sto per salvare «Report spese ricorrenti» nella cartella JarAI - Bozze.
                </div>
                <div className="confirm-inline-actions">
                  <button className="btn danger" onClick={() => setConfermaVisibile(false)}>
                    Rifiuta
                  </button>
                  <button className="btn primary" onClick={() => setConfermaVisibile(false)}>
                    Approva
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="composer-wrap">
        {pratica && (
          <div className="attached-files">
            <span className="attached-chip folder-context-chip">
              <FolderIcon size={12} />
              {pratica.nome}
            </span>
          </div>
        )}
        <div className="composer">
          <textarea
            ref={composerRef}
            className="composer-input"
            rows={1}
            placeholder="Scrivi cosa ti serve…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                invia();
              }
            }}
          />
          {elaborando ? (
            <button className="composer-send ready" onClick={ferma} title="Ferma">
              <StopIcon />
            </button>
          ) : (
            <button className={`composer-send ${input.trim() ? 'ready' : ''}`} onClick={invia} disabled={!input.trim()}>
              <SendIcon size={15} />
            </button>
          )}
        </div>
      </div>

      {bozzaAperta && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setBozzaAperta(null); }}>
          <div className="bozza-modal">
            <div className="bozza-modal-head">
              <h3>{bozzaAperta.titolo}</h3>
              <button className="btn-icon" onClick={() => setBozzaAperta(null)}>
                ×
              </button>
            </div>
            <div className="bozza-modal-body">
              <div className="msg-text">
                <Markdown>{bozzaAperta.contenuto}</Markdown>
              </div>
            </div>
            <div className="bozza-modal-foot">
              {esitoSalvataggio && <span className="bozza-modal-esito">✓ {esitoSalvataggio}</span>}
              <button className="btn" onClick={() => setBozzaAperta(null)}>
                Chiudi
              </button>
              <button className="btn primary" onClick={() => void salvaBozzaInWord(bozzaAperta)} disabled={salvandoBozza}>
                {salvandoBozza ? 'Salvataggio…' : 'Salva in Word'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Trasforma ogni occorrenza del nome esatto di un documento della pratica in
// un link speciale (spec §5.6): l'avvocato clicca il nome citato nella
// risposta e lo rivela nel Finder (stesso "Apri nella cartella" della
// scheda Documenti della pratica), senza doverlo cercare a mano. Solo i
// documenti con un file reale (percorso) sono linkificati.
// I nomi più lunghi vanno prima nell'alternanza della regex, in un solo
// passaggio, così un nome che è sottostringa di un altro non viene "rubato"
// a metà da un match più corto.
function linkificaDocumenti(testo: string, documenti: Documento[]): string {
  const validi = documenti.filter((d) => d.percorso);
  if (validi.length === 0) return testo;
  const ordinati = [...validi].sort((a, b) => b.nome.length - a.nome.length);
  const pattern = ordinati.map((d) => d.nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const regex = new RegExp(pattern, 'g');
  return testo.replace(regex, (match) => {
    const doc = ordinati.find((d) => d.nome === match);
    return doc ? `[${match}](jarai-doc://${doc.id})` : match;
  });
}

function apriDocumentoCitato(id: string, documenti: Documento[]): void {
  const doc = documenti.find((d) => d.id === id);
  if (doc?.percorso) void window.jarai.apriNellaCartella(doc.percorso);
}

function MessaggioBubble({ m, documenti, onApriBozza }: { m: Messaggio; documenti: Documento[]; onApriBozza: (b: Bozza) => void }) {
  const isUtente = m.ruolo === 'avvocato';
  return (
    <div className={`msg ${isUtente ? 'msg-user' : 'msg-assistant'}`}>
      <div className="msg-avatar">{isUtente ? 'TU' : 'AI'}</div>
      <div className="msg-body">
        <div className="msg-text">
          {isUtente ? (
            <p>{m.testo}</p>
          ) : (
            <>
              <Markdown onApriDocumento={(id) => apriDocumentoCitato(id, documenti)}>{linkificaDocumenti(m.testo, documenti)}</Markdown>
              {m.isStreaming && <span className="streaming-cursor" />}
            </>
          )}
        </div>
        {m.fonti && m.fonti.length > 0 && (
          <div className="source-chips">
            <span className="source-chips-label">Fonti:</span>
            {m.fonti.map((f) => (
              <span className="source-chip" key={f.documento}>
                {f.documento}
                {f.pagina && <span className="source-chip-page">p.{f.pagina}</span>}
              </span>
            ))}
          </div>
        )}
        {m.bozza && (
          <div className="doc-ready-row">
            <button className="doc-ready-chip" onClick={() => onApriBozza(m.bozza!)}>
              📄 {m.bozza.titolo} — apri
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function durataLeggibile(secondi: number): string {
  const minuti = Math.round(secondi / 60);
  if (minuti < 1) return 'meno di un minuto';
  if (minuti === 1) return '1 minuto';
  if (minuti < 60) return `${minuti} minuti`;
  const ore = Math.floor(minuti / 60);
  const resto = minuti % 60;
  return resto ? `${ore} h ${resto} min` : `${ore} h`;
}

// Stima dal ritmo tenuto finora; sotto il 5% è troppo presto per essere
// credibile e si preferisce non dire nulla.
function tempoRimanente(l: LavoroDocumento, ora: number): string | null {
  if (!l.iniziatoIl || !l.progresso || l.progresso < 0.05) return null;
  const trascorsi = (ora - l.iniziatoIl) / 1000;
  const rimanenti = (trascorsi / l.progresso) * (1 - l.progresso);
  return `circa ${durataLeggibile(rimanenti)} rimanenti`;
}

function descrizioneLavoro(l: LavoroDocumento, ora: number): string {
  switch (l.fase) {
    case 'completato':
      return 'Trascritto ✓';
    case 'in-coda':
      return 'In attesa — parte appena finisce quello precedente';
    case 'preparazione':
      return 'Preparo la trascrizione…';
    case 'modello':
      return 'Carico il modello di trascrizione (la prima volta lo scarica: può richiedere qualche minuto)';
    case 'ocr':
      return `Riconoscimento del testo (OCR) — pagina ${l.pagina} di ${l.pagineTotali}`;
    case 'trascrizione': {
      const parti = [`Trascrizione ${Math.round((l.progresso ?? 0) * 100)}%`];
      if (l.durataSec) parti.push(`audio di ${durataLeggibile(l.durataSec)}`);
      const stima = tempoRimanente(l, ora);
      if (stima) parti.push(stima);
      return parti.join(' · ');
    }
  }
}

function LavoriInCorso({ lavori }: { lavori: LavoroDocumento[] }) {
  // Ridisegno ogni secondo per tenere aggiornata la stima del tempo anche
  // quando dal processo non arriva un nuovo avanzamento.
  const [ora, setOra] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setOra(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const audio = lavori.filter((l) => l.tipo === 'trascrizione');
  const fatti = audio.filter((l) => l.fase === 'completato').length;
  const titolo =
    audio.length > 1
      ? `Trascrizione audio — ${fatti} di ${audio.length} completate (una alla volta)`
      : audio.length === 1
        ? 'Sto trascrivendo una registrazione audio'
        : 'Sto leggendo un documento scansionato';

  return (
    <div className="lavori-card" role="status" aria-live="polite">
      <div className="lavori-titolo">
        <span className="lavori-spinner" aria-hidden />
        {titolo}
      </div>
      {lavori.map((l) => {
        const determinato = l.fase === 'trascrizione' || l.fase === 'ocr' || l.fase === 'completato';
        return (
          <div key={l.id} className={`lavoro ${l.fase === 'in-coda' ? 'lavoro-attesa' : ''} ${l.fase === 'completato' ? 'lavoro-fatto' : ''}`}>
            <div className="lavoro-nome" title={l.nome}>{l.nome}</div>
            <div className="lavoro-barra">
              <div
                className={determinato ? 'lavoro-barra-riempimento' : 'lavoro-barra-indeterminata'}
                style={determinato ? { width: `${Math.max(2, (l.progresso ?? 0) * 100)}%` } : undefined}
              />
            </div>
            <div className="lavoro-stato">{descrizioneLavoro(l, ora)}</div>
          </div>
        );
      })}
      {audio.length > 0 && (
        <div className="lavori-nota">Le trascrizioni vengono salvate in «JarAI - Bozze»: la prossima volta saranno immediate.</div>
      )}
    </div>
  );
}
