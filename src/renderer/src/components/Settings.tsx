import { useEffect, useState } from 'react';
import type { Studio } from '../types';

interface Props {
  studio: Studio;
  onSalvaStudio: (studio: Studio) => void;
}

export default function Settings({ studio, onSalvaStudio }: Props) {
  // Licenza JarAI (src/main/licenza.ts): con una licenza valida lo studio
  // non ha bisogno di nessun account Claude: si collega tramite l'API e il
  // proxy JarAI. Lo stato viene dal servizio JarAI
  // e non consuma domande, quindi si legge a ogni apertura.
  type StatoLicenza = Awaited<ReturnType<typeof window.jarai.claude.statoLicenza>>;
  const [licenza, setLicenza] = useState<StatoLicenza | null>(null);
  const [licenzaInput, setLicenzaInput] = useState('');
  const [licenzaAttivando, setLicenzaAttivando] = useState(false);
  const [licenzaErrore, setLicenzaErrore] = useState<string | null>(null);
  const licenzaAttiva = licenza?.valida === true;

  useEffect(() => {
    void window.jarai.claude.statoLicenza().then(setLicenza);
  }, []);

  async function attivaLicenza() {
    if (!licenzaInput.trim()) return;
    setLicenzaAttivando(true);
    setLicenzaErrore(null);
    const stato = await window.jarai.claude.attivaLicenza(licenzaInput);
    setLicenzaAttivando(false);
    if (stato.valida) {
      setLicenza(stato);
      setLicenzaInput('');
    } else {
      setLicenzaErrore(stato.messaggio ?? 'Licenza non valida.');
    }
  }

  async function disconnettiLicenza() {
    await window.jarai.claude.disconnetti();
    setLicenza(null);
  }

  // Trascrizione audio (spec §12): la trascrizione vera e propria richiede
  // Python 3 sul computer (trascrizione.ts, pythonRuntime.ts) — qui si vede
  // solo "attiva o no", mai il dettaglio (Python di sistema o quello privato
  // scaricato da questo pulsante), stesso principio del collegamento JarAI.
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

  // Aggiornamenti (spec §12): un solo pulsante esplicito "Cerca
  // aggiornamenti" — mai un controllo automatico all'avvio, stesso
  // principio del resto di jarai. Il download è un passo a parte,
  // altrettanto esplicito ("Scarica"), e "Riavvia e aggiorna" resta l'ultimo
  // gesto dell'avvocato: l'app non si chiude mai da sola senza che sia lui a
  // deciderlo.
  type StatoAggiornamento = 'inattivo' | 'controllo' | 'aggiornato' | 'disponibile' | 'scaricando' | 'pronto' | 'errore';
  const [statoAgg, setStatoAgg] = useState<StatoAggiornamento>('inattivo');
  const [versioneNuova, setVersioneNuova] = useState<string | null>(null);
  const [percentualeAgg, setPercentualeAgg] = useState(0);
  const [erroreAgg, setErroreAgg] = useState<string | null>(null);

  useEffect(() => {
    return window.jarai.aggiornamenti.onEvento((evento) => {
      if (evento.tipo === 'controllo') {
        setStatoAgg('controllo');
        setErroreAgg(null);
      } else if (evento.tipo === 'disponibile') {
        setStatoAgg('disponibile');
        setVersioneNuova(evento.versione);
      } else if (evento.tipo === 'non-disponibile') {
        setStatoAgg('aggiornato');
      } else if (evento.tipo === 'progresso') {
        setStatoAgg('scaricando');
        setPercentualeAgg(evento.percentuale);
      } else if (evento.tipo === 'scaricato') {
        setStatoAgg('pronto');
        setVersioneNuova(evento.versione);
      } else if (evento.tipo === 'errore') {
        setStatoAgg('errore');
        setErroreAgg(evento.messaggio);
      }
    });
  }, []);

  function controllaAggiornamenti() {
    setStatoAgg('controllo');
    setErroreAgg(null);
    void window.jarai.aggiornamenti.controlla();
  }

  function scaricaAggiornamento() {
    setPercentualeAgg(0);
    void window.jarai.aggiornamenti.scarica();
  }

  return (
    <div className="content">
      <div className="content-inner">
        <div className="page-head">
          <div>
            <h1>Impostazioni</h1>
            <p>Studio, collegamento JarAI e privacy</p>
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
              <div className="s-card-title">Collegamento JarAI</div>
              <div className="s-card-sub">
                {licenzaAttiva
                  ? 'Licenza JarAI attiva.'
                  : "Inserisci la chiave di licenza JarAI ricevuta con l'abbonamento."}
              </div>
            </div>
            <div className="s-card-body">
              <div className="s-row">
                <div>
                  <div className="s-label">Licenza JarAI</div>
                  <div className="s-label-sub">
                    {licenzaAttiva
                      ? `${licenza?.studio ?? ''}${licenza?.piano ? ` · piano ${licenza.piano}` : ''}`
                      : 'chiave che inizia con jarai_'}
                  </div>
                </div>
                {licenzaAttiva ? (
                  <div className="plan-usage-row" style={{ padding: 0, border: 'none' }}>
                    <div className="plan-usage-head">
                      <span className="plan-usage-label">Domande questo mese</span>
                      <span className="plan-usage-pct">
                        {licenza?.domandeUsate ?? 0} di {licenza?.domandeMese ?? 0}
                      </span>
                    </div>
                    <div className={`plan-usage-bar ${(licenza?.domandeUsate ?? 0) >= 0.8 * (licenza?.domandeMese ?? 1) ? 'warn' : ''}`}>
                      <div
                        style={{
                          width: `${Math.min(100, ((licenza?.domandeUsate ?? 0) / Math.max(1, licenza?.domandeMese ?? 1)) * 100)}%`,
                        }}
                      />
                    </div>
                    <div className="plan-usage-reset">Si azzera il primo del mese</div>
                  </div>
                ) : (
                  <div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        className="s-input mono"
                        value={licenzaInput}
                        onChange={(e) => setLicenzaInput(e.target.value)}
                        placeholder="jarai_…"
                        onKeyDown={(e) => e.key === 'Enter' && void attivaLicenza()}
                        spellCheck={false}
                      />
                      <button
                        className="btn primary"
                        onClick={() => void attivaLicenza()}
                        disabled={!licenzaInput.trim() || licenzaAttivando}
                      >
                        {licenzaAttivando ? 'Verifica…' : 'Attiva'}
                      </button>
                    </div>
                    {licenzaErrore && (
                      <div
                        style={{
                          color: 'var(--oxblood)',
                          fontSize: 12,
                          marginTop: 6,
                        }}
                      >
                        {licenzaErrore}
                      </div>
                    )}
                  </div>
                )}
                {licenzaAttiva ? (
                  <button className="btn danger" onClick={disconnettiLicenza}>
                    Disconnetti
                  </button>
                ) : (
                  <div />
                )}
              </div>

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

          {/* Aggiornamenti */}
          <div className="s-card">
            <div className="s-card-head">
              <div className="s-card-title">Aggiornamenti</div>
              <div className="s-card-sub">Versione installata: {window.jarai.version}</div>
            </div>
            <div className="s-card-body">
              <div className="s-row">
                <div>
                  <div className="s-label">jarai</div>
                  <div className="s-label-sub">
                    {statoAgg === 'disponibile' || statoAgg === 'scaricando' || statoAgg === 'pronto'
                      ? `versione ${versioneNuova}`
                      : 'controllo manuale, mai automatico'}
                  </div>
                </div>
                <div className="api-key-row">
                  <span
                    className="dot"
                    style={{
                      background:
                        statoAgg === 'errore'
                          ? 'var(--oxblood)'
                          : statoAgg === 'aggiornato' || statoAgg === 'pronto'
                            ? 'var(--sage)'
                            : 'var(--amber)',
                    }}
                  />
                  <span className="v">
                    {statoAgg === 'inattivo' && 'Non ancora verificato'}
                    {statoAgg === 'controllo' && 'Verifica in corso…'}
                    {statoAgg === 'aggiornato' && 'Sei già aggiornato'}
                    {statoAgg === 'disponibile' && 'Nuova versione disponibile'}
                    {statoAgg === 'scaricando' && `Download… ${Math.round(percentualeAgg)}%`}
                    {statoAgg === 'pronto' && 'Pronta da installare'}
                    {statoAgg === 'errore' && 'Non riuscito'}
                  </span>
                </div>
                <div>
                  {(statoAgg === 'inattivo' || statoAgg === 'aggiornato' || statoAgg === 'errore') && (
                    <button className="btn" onClick={controllaAggiornamenti}>
                      Cerca aggiornamenti
                    </button>
                  )}
                  {statoAgg === 'controllo' && (
                    <button className="btn" disabled>
                      Verifica…
                    </button>
                  )}
                  {statoAgg === 'disponibile' && (
                    <button className="btn primary" onClick={scaricaAggiornamento}>
                      Scarica
                    </button>
                  )}
                  {statoAgg === 'scaricando' && (
                    <button className="btn" disabled>
                      Download…
                    </button>
                  )}
                  {statoAgg === 'pronto' && (
                    <button className="btn primary" onClick={() => void window.jarai.aggiornamenti.installa()}>
                      Riavvia e aggiorna
                    </button>
                  )}
                </div>
              </div>
              {erroreAgg && (
                <div className="s-row">
                  <div />
                  <div style={{ fontSize: 12.5, color: 'var(--oxblood)' }}>{erroreAgg}</div>
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
