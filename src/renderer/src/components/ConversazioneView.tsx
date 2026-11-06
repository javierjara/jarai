import { useEffect, useRef, useState } from 'react';
import { messaggiVisibili } from '../../../shared/reducer';
import { comando, useConversazione } from '../host';
import type { Bozza, Documento, LavoroDocumento, Messaggio, Pratica, Procedura } from '../types';
import { PROCEDURE } from '../types';
import PlanPanel from './PlanPanel';
import Markdown from './Markdown';
import PannelloDocumento from './PannelloDocumento';
import { FolderIcon, SendIcon, StopIcon } from './icons';

interface Props {
  pratiche: Pratica[];
  praticaId: string | null;
  /** null: conversazione nuova, nasce al primo invio. */
  conversazioneId: string | null;
  documenti: Record<string, Documento[]>;
  /** Salva subito pratiche e documenti: l'host li legge al momento dell'invio. */
  onPrimaDiInviare: () => Promise<void>;
}

// crypto.randomUUID(), non un contatore: un contatore in memoria riparte da
// zero a ogni riavvio, mentre le conversazioni restano salvate — due
// conversazioni create in sessioni diverse potevano finire con lo stesso id.
const nextId = () => crypto.randomUUID();

// La conversazione la possiede l'host (src/core/host.ts): qui si mandano
// comandi e si disegna la proiezione che arriva dagli eventi. Cambiare vista
// durante una risposta non perde più niente: tornando, lo snapshot contiene
// anche il testo già scritto.
export default function ConversazioneView({ pratiche, praticaId, conversazioneId, documenti, onPrimaDiInviare }: Props) {
  const idRef = useRef(conversazioneId ?? nextId());
  const conversazione = useConversazione(idRef.current);
  const pratica = pratiche.find((p) => p.id === (conversazione?.praticaId ?? praticaId)) ?? null;
  const documentiPratica = pratica ? (documenti[pratica.id] ?? []) : [];

  const turno = conversazione?.turno ?? null;
  const messaggi: Messaggio[] = conversazione ? messaggiVisibili(conversazione) : [];
  const piano = conversazione?.piano;
  const lavori: LavoroDocumento[] = turno?.lavori ?? [];
  const [proceduraScelta, setProcedura] = useState<Procedura | null>(null);
  const procedura = proceduraScelta ?? conversazione?.procedura ?? PROCEDURE[0];
  const [input, setInput] = useState('');
  const [inviando, setInviando] = useState(false);
  const [erroreInvio, setErroreInvio] = useState<string | null>(null);
  const elaborando = inviando || turno !== null;
  // Come prima: "Sto pensando…" finché non arriva un'attività o del testo.
  const attivita = turno ? (turno.attivita ?? (turno.testoParziale ? null : 'Sto pensando…')) : inviando ? 'Sto pensando…' : null;
  const [qualita, setQualita] = useState<'Standard' | 'Massima'>('Standard');
  const [confermaChiusa, setConfermaChiusa] = useState(false);
  const confermaVisibile = conversazione?.stato === 'attesa' && !confermaChiusa;
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [bozzaAperta, setBozzaAperta] = useState<Bozza | null>(null);

  // Il composer si allarga con il testo, come su T3 Code, fino al limite in
  // CSS (composer-input, max-height) — oltre scorre invece di crescere.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  const ultimoTesto = messaggi.at(-1)?.testo.length ?? 0;
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
  }, [messaggi.length, ultimoTesto, attivita, lavori.length]);

  async function invia() {
    const testo = input.trim();
    if (!testo || elaborando) return;
    const id = idRef.current;
    setInput('');
    setInviando(true);
    setErroreInvio(null);
    try {
      await onPrimaDiInviare();
      if (!conversazione) {
        const creata = await comando({
          tipo: 'conversazione.crea',
          argomenti: { conversazioneId: id, modalita: 'pratica', praticaId: pratica?.id ?? null, titolo: '', procedura, qualita },
        });
        if (!creata.ok) throw new Error(creata.errore);
      }
      const inviata = await comando({ tipo: 'conversazione.invia', argomenti: { conversazioneId: id, testo, qualita } });
      if (!inviata.ok) throw new Error(inviata.errore);
    } catch (err) {
      // La domanda torna nel composer: non si perde.
      setInput(testo);
      setErroreInvio(err instanceof Error ? err.message : String(err));
    } finally {
      setInviando(false);
    }
  }

  function ferma() {
    void comando({ tipo: 'conversazione.ferma', argomenti: { conversazioneId: idRef.current } });
  }

  return (
    <div className="doc-panel-wrap">
      <div className="home-page">
        <div className="home-topbar">
          <div className="home-topbar-title">
            <h2>{pratica ? pratica.nome : 'Fai una domanda'}</h2>
            <select
              className="procedura-select"
              value={procedura}
              onChange={(e) => {
                const scelta = e.target.value as Procedura;
                setProcedura(scelta);
                // Conversazione già nata: la scelta si salva nell'host.
                if (conversazione) {
                  void comando({ tipo: 'conversazione.cambiaProcedura', argomenti: { conversazioneId: idRef.current, procedura: scelta } });
                }
              }}
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
                    <button className="btn danger" onClick={() => setConfermaChiusa(true)}>
                      Rifiuta
                    </button>
                    <button className="btn primary" onClick={() => setConfermaChiusa(true)}>
                      Approva
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="composer-wrap">
          {erroreInvio && (
            <div className="artifact-processing" role="alert">
              ⚠ {erroreInvio}
            </div>
          )}
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
                  void invia();
                }
              }}
            />
            {elaborando ? (
              <button className="composer-send ready" onClick={ferma} title="Ferma">
                <StopIcon />
              </button>
            ) : (
              <button className={`composer-send ${input.trim() ? 'ready' : ''}`} onClick={() => void invia()} disabled={!input.trim()}>
                <SendIcon size={15} />
              </button>
            )}
          </div>
        </div>
      </div>

      {bozzaAperta && <PannelloDocumento bozza={bozzaAperta} onChiudi={() => setBozzaAperta(null)} />}
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
