import { useEffect, useState } from 'react';
import type { Studio } from '../types';

interface Props {
  studio: Studio;
  onSalvaStudio: (studio: Studio) => void;
}

type StatoCollegamento = 'sconosciuto' | 'verificando' | 'collegato' | 'non_collegato';

function formattaQuando(iso: string): string {
  return new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function FinestraUtilizzoRow({
  etichetta,
  finestra,
}: {
  etichetta: string;
  finestra: { percentuale: number | null; siAzzeraIl: string | null };
}) {
  const pct = finestra.percentuale ?? 0;
  return (
    <div className="plan-usage-row">
      <div className="plan-usage-head">
        <span className="plan-usage-label">{etichetta}</span>
        <span className="plan-usage-pct">{finestra.percentuale === null ? '—' : `${Math.round(finestra.percentuale)}% usato`}</span>
      </div>
      <div className={`plan-usage-bar ${pct >= 80 ? 'warn' : ''}`}>
        <div style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
      {finestra.siAzzeraIl && <div className="plan-usage-reset">Si azzera il {formattaQuando(finestra.siAzzeraIl)}</div>}
    </div>
  );
}

export default function Settings({ studio, onSalvaStudio }: Props) {
  const [statoCollegamento, setStatoCollegamento] = useState<StatoCollegamento>('sconosciuto');
  const [modalitaCollegamento, setModalitaCollegamento] = useState<'chiave' | 'account' | null>(null);
  const [erroreCollegamento, setErroreCollegamento] = useState<string | null>(null);
  const [ultimaVerificaIl, setUltimaVerificaIl] = useState<string | null>(null);

  useEffect(() => {
    // Mostra subito l'ultimo esito noto invece di "Non ancora collegato" —
    // resta comunque la cache dell'ultima verifica esplicita, non fa
    // scattare una nuova richiesta a Claude da sola (spec §12, Fase 2).
    window.jarai.claude.statoCollegamentoSalvato().then((salvato) => {
      if (!salvato) return;
      setStatoCollegamento(salvato.collegato ? 'collegato' : 'non_collegato');
      setModalitaCollegamento(salvato.modalita ?? null);
      setUltimaVerificaIl(salvato.verificatoIl);
      if (!salvato.collegato) setErroreCollegamento(salvato.messaggio ?? 'Non collegato');
    });
  }, []);

  async function verificaCollegamento() {
    setStatoCollegamento('verificando');
    setErroreCollegamento(null);
    const esito = await window.jarai.claude.verifica();
    setUltimaVerificaIl(new Date().toISOString());
    if (esito.collegato) {
      setStatoCollegamento('collegato');
      setModalitaCollegamento(esito.modalita ?? null);
    } else {
      setStatoCollegamento('non_collegato');
      setErroreCollegamento(esito.messaggio ?? 'Non riesco a raggiungere Claude.');
    }
  }

  async function disconnettiClaude() {
    await window.jarai.claude.disconnetti();
    setStatoCollegamento('sconosciuto');
    setModalitaCollegamento(null);
    setErroreCollegamento(null);
    setUltimaVerificaIl(null);
  }

  // Login ufficiale (spec §3): lo stesso `claude auth login` di T3 Code, ma
  // puntato sulla cartella di configurazione isolata di JarAI. Un solo
  // pulsante avvia sempre l'accesso con l'account personale (Pro/Max) — lo
  // stesso schema a due stati di T3 Code. La chiave API e il login
  // Console/Team dello studio restano supportati lato main process (spec §3)
  // ma non sono più nella UI: si può riesporli in un pannello avanzato se
  // servirà a uno studio con fatturazione centralizzata.
  const [loginAttivo, setLoginAttivo] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [loginAttesaCodice, setLoginAttesaCodice] = useState(false);
  const [loginCodice, setLoginCodice] = useState('');
  const [loginErrore, setLoginErrore] = useState<string | null>(null);

  useEffect(() => {
    return window.jarai.claude.onEventoLogin((evento) => {
      if (evento.tipo === 'url') {
        setLoginUrl(evento.url);
      } else if (evento.tipo === 'attesa-codice') {
        setLoginAttesaCodice(true);
      } else if (evento.tipo === 'completato') {
        setLoginAttivo(false);
        setLoginUrl(null);
        setLoginAttesaCodice(false);
        setLoginCodice('');
        setLoginErrore(null);
        void verificaCollegamento();
      } else if (evento.tipo === 'errore') {
        setLoginAttivo(false);
        setLoginAttesaCodice(false);
        setLoginErrore(evento.messaggio);
      }
    });
  }, []);

  function collegaClaude() {
    setLoginAttivo(true);
    setLoginUrl(null);
    setLoginAttesaCodice(false);
    setLoginCodice('');
    setLoginErrore(null);
    void window.jarai.claude.avviaLogin('claudeai');
  }

  function confermaCodiceLogin() {
    if (!loginCodice.trim()) return;
    void window.jarai.claude.inviaCodiceLogin(loginCodice);
  }

  function annullaLoginAccount() {
    void window.jarai.claude.annullaLogin();
    setLoginAttivo(false);
    setLoginUrl(null);
    setLoginAttesaCodice(false);
    setLoginCodice('');
  }
  // Utilizzo dell'abbonamento (spec §5.9 "Consumo"), gli stessi numeri del
  // comando /usage di Claude Code: sessione e settimana in percentuale, non
  // in dollari. Disponibile solo con un account a piano (Pro/Max/Team/
  // Enterprise) — con la chiave o un account a consumo torna "non
  // disponibile". Non parte da sola: ogni controllo è una richiesta reale,
  // seppure minima, quindi solo su pressione di "Aggiorna".
  type FinestraUtilizzo = { percentuale: number | null; siAzzeraIl: string | null };
  const [usoAbbonamento, setUsoAbbonamento] = useState<
    | undefined
    | null
    | { disponibile: boolean; tipoAbbonamento: string | null; sessione: FinestraUtilizzo | null; settimana: FinestraUtilizzo | null; settimanaOpus: FinestraUtilizzo | null }
  >(undefined);
  const [usoAbbonamentoCaricando, setUsoAbbonamentoCaricando] = useState(false);

  async function caricaUsoAbbonamento() {
    setUsoAbbonamentoCaricando(true);
    setUsoAbbonamento(await window.jarai.claude.usoAbbonamento());
    setUsoAbbonamentoCaricando(false);
  }

  // Trascrizione audio (spec §12): la trascrizione vera e propria richiede
  // Python 3 sul computer (trascrizione.ts, pythonRuntime.ts) — qui si vede
  // solo "attiva o no", mai il dettaglio (Python di sistema o quello privato
  // scaricato da questo pulsante), stesso principio del collegamento Claude.
  const [audioDisponibile, setAudioDisponibile] = useState<boolean | null>(null);
  const [installazioneAutoDisponibile, setInstallazioneAutoDisponibile] = useState(false);
  const [installandoAudio, setInstallandoAudio] = useState(false);
  const [faseAudio, setFaseAudio] = useState<string | null>(null);
  const [erroreAudio, setErroreAudio] = useState<string | null>(null);

  const FASI_AUDIO: Record<string, string> = {
    'download-python': 'Scaricamento di Python…',
    estrazione: 'Preparazione…',
    'download-pip': 'Scaricamento componenti…',
    'installazione-pip': 'Installazione…',
  };

  async function caricaStatoAudio() {
    const stato = await window.jarai.audio.stato();
    setAudioDisponibile(stato.disponibile);
    setInstallazioneAutoDisponibile(stato.installazioneAutomaticaDisponibile);
  }

  useEffect(() => {
    void caricaStatoAudio();
    return window.jarai.audio.onProgresso((fase) => setFaseAudio(fase));
  }, []);

  async function attivaTrascrizioneAudio() {
    setInstallandoAudio(true);
    setErroreAudio(null);
    setFaseAudio(null);
    const esito = await window.jarai.audio.installa();
    setInstallandoAudio(false);
    setFaseAudio(null);
    if (esito.ok) {
      await caricaStatoAudio();
    } else {
      setErroreAudio(esito.errore);
    }
  }

  return (
    <div className="content">
      <div className="content-inner">
        <div className="page-head">
          <div>
            <h1>Impostazioni</h1>
            <p>Studio, collegamento Claude e privacy</p>
          </div>
        </div>

        <div className="settings-stack">
          {/* Studio */}
          <div className="s-card">
            <div className="s-card-head">
              <div className="s-card-title">Studio</div>
              <div className="s-card-sub">Nome studio e avvocato, mostrati nella sidebar.</div>
            </div>
            <div className="s-card-body">
              <div className="s-row">
                <div className="s-label">Nome dello studio</div>
                <input
                  className="s-input"
                  value={studio.nome}
                  onChange={(e) => onSalvaStudio({ ...studio, nome: e.target.value })}
                />
                <div />
              </div>
              <div className="s-row">
                <div className="s-label">Avvocato</div>
                <input
                  className="s-input"
                  value={studio.avvocato}
                  onChange={(e) => onSalvaStudio({ ...studio, avvocato: e.target.value })}
                />
                <div />
              </div>
            </div>
          </div>

          {/* Collegamento Claude */}
          <div className="s-card">
            <div className="s-card-head">
              <div className="s-card-title">Collegamento Claude</div>
              <div className="s-card-sub">
                Ogni avvocato usa il proprio accesso. JarAI non gestisce mai credenziali di abbonamento direttamente.
              </div>
            </div>
            <div className="s-card-body">
              <div className="s-row">
                <div>
                  <div className="s-label">Claude</div>
                  <div className="s-label-sub">
                    {ultimaVerificaIl && statoCollegamento !== 'verificando'
                      ? `verificato il ${formattaQuando(ultimaVerificaIl)}`
                      : 'login ufficiale, lo stesso di T3 Code'}
                  </div>
                </div>
                <div className="api-key-row">
                  <span
                    className="dot"
                    style={{
                      background:
                        statoCollegamento === 'collegato'
                          ? 'var(--sage)'
                          : statoCollegamento === 'non_collegato'
                            ? 'var(--oxblood)'
                            : 'var(--amber)',
                    }}
                  />
                  <span className="v">
                    {statoCollegamento === 'verificando' && 'Verifica in corso…'}
                    {statoCollegamento === 'collegato' &&
                      `Collegato${modalitaCollegamento === 'chiave' ? ' · chiave dello studio' : modalitaCollegamento === 'account' ? ' · account Claude Code' : ''}`}
                    {statoCollegamento === 'non_collegato' && (erroreCollegamento ?? 'Non collegato')}
                    {statoCollegamento === 'sconosciuto' && 'Non ancora collegato'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {statoCollegamento === 'collegato' ? (
                    <>
                      <button className="btn" style={{ height: 28, fontSize: 11 }} onClick={verificaCollegamento} title="Aggiorna stato">
                        ↻
                      </button>
                      <button className="btn danger" onClick={disconnettiClaude}>
                        Disconnetti
                      </button>
                    </>
                  ) : (
                    <button className="btn primary" onClick={collegaClaude} disabled={loginAttivo}>
                      {loginAttivo ? 'Collegamento…' : 'Collega Claude'}
                    </button>
                  )}
                </div>
              </div>

              {(loginAttivo || loginErrore) && (
                <div className="s-row">
                  <div />
                  <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>
                    {loginAttivo && !loginUrl && 'Si sta aprendo il browser per il login…'}
                    {loginUrl && !loginAttesaCodice && (
                      <div>
                        Se il browser non si è aperto da solo, apri questo link:
                        <div className="api-key-row" style={{ marginTop: 6 }}>
                          <span className="v" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                            {loginUrl}
                          </span>
                          <button className="s-suffix" onClick={() => void navigator.clipboard.writeText(loginUrl)}>
                            Copia
                          </button>
                        </div>
                      </div>
                    )}
                    {loginAttesaCodice && (
                      <div>
                        <div className="s-label-sub" style={{ marginBottom: 6 }}>
                          Completa l'accesso nel browser, poi incolla qui il codice mostrato
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <input
                            className="s-input mono"
                            value={loginCodice}
                            onChange={(e) => setLoginCodice(e.target.value)}
                            placeholder="codice…"
                            onKeyDown={(e) => e.key === 'Enter' && confermaCodiceLogin()}
                            autoFocus
                          />
                          <button className="btn primary" onClick={confermaCodiceLogin} disabled={!loginCodice.trim()}>
                            Conferma
                          </button>
                        </div>
                      </div>
                    )}
                    {!loginAttivo && loginErrore && <div style={{ color: 'var(--oxblood)' }}>{loginErrore}</div>}
                  </div>
                  {loginAttivo && (
                    <button className="btn danger" onClick={annullaLoginAccount}>
                      Annulla
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Utilizzo Claude */}
          <div className="s-card">
            <div className="s-card-head">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div className="s-card-title">Utilizzo Claude</div>
                <button className="btn" style={{ height: 28, fontSize: 11 }} onClick={caricaUsoAbbonamento} disabled={usoAbbonamentoCaricando}>
                  {usoAbbonamentoCaricando ? 'Verifica…' : '↻ Aggiorna'}
                </button>
              </div>
              <div className="s-card-sub">
                Sessione e settimana, come nel pannello /usage di Claude Code. Ogni controllo è una richiesta reale e minima, per questo non
                parte da solo.
              </div>
            </div>
            <div className="s-card-body" style={{ paddingTop: 14 }}>
              {usoAbbonamento === undefined && !usoAbbonamentoCaricando && (
                <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Premi "Aggiorna" per controllare.</div>
              )}
              {usoAbbonamentoCaricando && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Verifica in corso…</div>}
              {!usoAbbonamentoCaricando && usoAbbonamento === null && (
                <div style={{ fontSize: 12.5, color: 'var(--oxblood)' }}>Non sono riuscito a leggere l'utilizzo. Riprova.</div>
              )}
              {!usoAbbonamentoCaricando && usoAbbonamento && !usoAbbonamento.disponibile && (
                <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5 }}>
                  Non disponibile con l'accesso attuale{usoAbbonamento.tipoAbbonamento ? ` (${usoAbbonamento.tipoAbbonamento})` : ''}: questa vista
                  compare solo con un account Claude Pro, Max, Team o Enterprise — non con la chiave dello studio o un accesso a consumo
                  (Console).
                </div>
              )}
              {!usoAbbonamentoCaricando && usoAbbonamento?.disponibile && (
                <>
                  {usoAbbonamento.sessione && <FinestraUtilizzoRow etichetta="Sessione attuale" finestra={usoAbbonamento.sessione} />}
                  {usoAbbonamento.settimana && <FinestraUtilizzoRow etichetta="Questa settimana (tutti i modelli)" finestra={usoAbbonamento.settimana} />}
                  {usoAbbonamento.settimanaOpus && <FinestraUtilizzoRow etichetta="Questa settimana (Opus)" finestra={usoAbbonamento.settimanaOpus} />}
                </>
              )}
            </div>
          </div>

          {/* Trascrizione audio */}
          <div className="s-card">
            <div className="s-card-head">
              <div className="s-card-title">Trascrizione audio</div>
              <div className="s-card-sub">Per leggere telefonate e deposizioni registrate come documenti della pratica.</div>
            </div>
            <div className="s-card-body">
              <div className="s-row">
                <div>
                  <div className="s-label">Componente audio</div>
                  <div className="s-label-sub">
                    {audioDisponibile === null ? 'verifica…' : 'richiede Python 3, una sola volta'}
                  </div>
                </div>
                <div className="api-key-row">
                  <span
                    className="dot"
                    style={{
                      background: audioDisponibile === null ? 'var(--amber)' : audioDisponibile ? 'var(--sage)' : 'var(--oxblood)',
                    }}
                  />
                  <span className="v">
                    {audioDisponibile === null && 'Verifica in corso…'}
                    {audioDisponibile === true && 'Attiva'}
                    {audioDisponibile === false && 'Non attiva'}
                  </span>
                </div>
                <div>
                  {audioDisponibile === false &&
                    (installazioneAutoDisponibile ? (
                      <button className="btn primary" onClick={attivaTrascrizioneAudio} disabled={installandoAudio}>
                        {installandoAudio ? (faseAudio ? FASI_AUDIO[faseAudio] ?? 'Installazione…' : 'Installazione…') : 'Attiva trascrizione audio'}
                      </button>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>Chiedi al tuo tecnico di installare Python 3</span>
                    ))}
                </div>
              </div>
              {erroreAudio && (
                <div className="s-row">
                  <div />
                  <div style={{ fontSize: 12.5, color: 'var(--oxblood)' }}>{erroreAudio}</div>
                </div>
              )}
              {audioDisponibile === false && installazioneAutoDisponibile && !erroreAudio && (
                <div className="s-row">
                  <div />
                  <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                    Scarica un componente aggiuntivo (una sola volta, serve una connessione internet) dentro i dati dell'app — non
                    installa nulla sul resto del computer.
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="privacy-card">
            <div className="privacy-icn">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <div className="privacy-text">
              <strong>Tutto resta sul computer dello studio.</strong> Nessun documento passa in chiaro da server di terzi, a parte il testo
              inviato al modello Claude quando colleghi l'assistente.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
