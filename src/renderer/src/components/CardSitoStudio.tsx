import { useEffect, useState } from 'react';

// Impostazioni → Sito dello studio (Studio digitale): indirizzo del sito
// Payload, email e password del pannello. La password resta nello stato del
// componente solo fino al collegamento, poi vive cifrata nel main process.
export default function CardSitoStudio() {
  type StatoSito = Awaited<ReturnType<typeof window.jarai.sito.stato>>;
  const [stato, setStato] = useState<StatoSito | null>(null);
  const [articoli, setArticoli] = useState<number | null>(null);
  const [url, setUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [collegando, setCollegando] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);

  async function contaArticoli() {
    const esito = await window.jarai.sito.numeroArticoli();
    setArticoli(esito.ok ? esito.dati : null);
    if (!esito.ok) setErrore(esito.errore);
  }

  useEffect(() => {
    void window.jarai.sito.stato().then((s) => {
      setStato(s);
      if (s.collegato) void contaArticoli();
    });
  }, []);

  async function collega() {
    if (!url.trim() || !email.trim() || !password) return;
    setCollegando(true);
    setErrore(null);
    const esito = await window.jarai.sito.collega(url, email, password);
    setCollegando(false);
    if (!esito.ok) {
      setErrore(esito.errore);
      return;
    }
    setStato(esito.dati);
    setPassword('');
    void contaArticoli();
  }

  async function scollega() {
    await window.jarai.sito.scollega();
    setStato({ collegato: false });
    setArticoli(null);
    setErrore(null);
  }

  const dominio = stato?.url?.replace(/^https?:\/\//, '');

  return (
    <div className="s-card">
      <div className="s-card-head">
        <div className="s-card-title">Sito dello studio</div>
        <div className="s-card-sub">Per lo Studio digitale: l'assistente legge gli articoli pubblicati e prepara le bozze dei nuovi.</div>
      </div>
      <div className="s-card-body">
        <div className="s-row">
          <div>
            <div className="s-label">Sito Payload</div>
            <div className="s-label-sub">{stato?.collegato ? dominio : 'Indirizzo, email e password del pannello'}</div>
          </div>
          <div className="api-key-row">
            <span
              className="dot"
              style={{ background: stato === null ? 'var(--amber)' : stato.collegato ? 'var(--sage)' : 'var(--faint)' }}
            />
            <span className="v">
              {stato === null && 'Verifica…'}
              {stato?.collegato === true &&
                `Collegato come ${stato.email}${articoli !== null ? ` · ${articoli} articoli pubblicati` : ''}`}
              {stato?.collegato === false && 'Non collegato'}
            </span>
          </div>
          <div>
            {stato?.collegato && (
              <button className="btn danger" onClick={() => void scollega()}>
                Scollega
              </button>
            )}
          </div>
        </div>

        {stato?.collegato === false && (
          <>
            <div className="s-row">
              <div className="s-label">Indirizzo del sito</div>
              <input
                className="s-input"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="es. studiolegalerossi.it"
                autoComplete="off"
                spellCheck={false}
              />
              <div />
            </div>
            <div className="s-row">
              <div className="s-label">Email del pannello</div>
              <input
                className="s-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="la stessa usata per entrare in /admin"
                autoComplete="off"
                spellCheck={false}
              />
              <div />
            </div>
            <div className="s-row">
              <div className="s-label">Password</div>
              <input
                className="s-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void collega()}
                autoComplete="off"
              />
              <button
                className="btn primary"
                onClick={() => void collega()}
                disabled={!url.trim() || !email.trim() || !password || collegando}
              >
                {collegando ? 'Accesso…' : 'Collega'}
              </button>
            </div>
          </>
        )}

        {errore && (
          <div className="s-row">
            <div />
            <div style={{ fontSize: 12.5, color: 'var(--oxblood)' }}>{errore}</div>
          </div>
        )}

        <div className="s-row">
          <div />
          <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
            Le credenziali restano su questo computer, cifrate dal sistema operativo. JarAI invia gli articoli al sito solo
            come bozze, e li pubblica solo quando premi «Pubblica» e confermi. Consigliato: un utente del pannello
            dedicato a JarAI.
          </div>
        </div>
      </div>
    </div>
  );
}
