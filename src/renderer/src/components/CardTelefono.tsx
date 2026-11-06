import { useCallback, useEffect, useState } from 'react';

// "Sul telefono": QR per collegare l'app JarAI e telefoni già collegati
// (src/main/telefono.ts). Il QR vale pochi minuti e una volta sola.

type Stato = Awaited<ReturnType<typeof window.jarai.telefono.stato>>;

const ETICHETTA: Record<Stato['stato'], string> = {
  collegato: 'Raggiungibile dai telefoni',
  collegamento: 'Collegamento al servizio…',
  scollegato: 'Servizio non raggiungibile: riprovo',
  sostituito: 'JarAI è aperto su un altro computer con questa stessa identità',
  rifiutato: 'Identità di questo computer non riconosciuta dal servizio',
  fermo: 'Nessun telefono collegato',
};

export default function CardTelefono() {
  const [stato, setStato] = useState<Stato | null>(null);
  const [invito, setInvito] = useState<{ immagine: string; scade: number } | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [inCorso, setInCorso] = useState(false);
  const [ora, setOra] = useState(Date.now());

  const aggiorna = useCallback(() => void window.jarai.telefono.stato().then(setStato), []);

  useEffect(() => {
    aggiorna();
    return window.jarai.telefono.onCambio(() => {
      aggiorna();
      // Un telefono si è appena collegato: il QR non serve più.
      setInvito(null);
    });
  }, [aggiorna]);

  useEffect(() => {
    if (!invito) return;
    const t = setInterval(() => setOra(Date.now()), 1000);
    return () => clearInterval(t);
  }, [invito]);

  const scaduto = invito !== null && ora > invito.scade;
  const attivi = stato?.dispositivi.filter((d) => !d.revocatoIl) ?? [];

  async function mostraQr() {
    setInCorso(true);
    setErrore(null);
    const r = await window.jarai.telefono.invito();
    setInCorso(false);
    if (r.ok) {
      setOra(Date.now());
      setInvito({ immagine: r.immagine, scade: r.scade });
    } else setErrore(r.errore);
    aggiorna();
  }

  async function revoca(id: string, nome: string) {
    if (!window.confirm(`Scollegare "${nome}"? Il telefono non potrà più accedere a JarAI finché non lo ricolleghi.`)) return;
    await window.jarai.telefono.revoca(id);
    aggiorna();
  }

  if (stato && !stato.disponibile) {
    return (
      <div className="s-card">
        <div className="s-card-head">
          <div className="s-card-title">Sul telefono</div>
          <div className="s-card-sub">La cifratura del sistema non è disponibile su questo computer: il collegamento del telefono non si può attivare.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="s-card">
      <div className="s-card-head">
        <div className="s-card-title">Sul telefono</div>
        <div className="s-card-sub">
          Continua le conversazioni dall'app JarAI. Il telefono parla con questo computer, cifrato da un capo all'altro: deve restare acceso e
          con JarAI aperto.
        </div>
      </div>
      <div className="s-card-body">
        <div className="s-row">
          <div>
            <div className="s-label">Stato</div>
            <div className="s-label-sub">{attivi.length === 1 ? '1 telefono collegato' : `${attivi.length} telefoni collegati`}</div>
          </div>
          <div className="api-key-row">
            <span
              className="dot"
              style={{
                background:
                  stato?.stato === 'collegato' ? 'var(--sage)' : stato?.stato === 'fermo' || !stato ? 'var(--faint)' : 'var(--amber)',
              }}
            />
            <span className="v">{stato ? ETICHETTA[stato.stato] : 'Verifica…'}</span>
          </div>
          <div>
            <button className="btn primary" onClick={() => void mostraQr()} disabled={inCorso}>
              {inCorso ? 'Preparo…' : invito && !scaduto ? 'Nuovo QR' : 'Collega un telefono'}
            </button>
          </div>
        </div>

        {errore && <div style={{ color: 'var(--oxblood)', fontSize: 12, margin: '6px 0' }}>{errore}</div>}

        {invito && (
          <div className="s-row" style={{ alignItems: 'center' }}>
            <div>
              <div className="s-label">Inquadra con l'app JarAI</div>
              <div className="s-label-sub">
                {scaduto
                  ? 'QR scaduto: generane uno nuovo.'
                  : `Vale ancora ${Math.max(0, Math.ceil((invito.scade - ora) / 60_000))} min, una volta sola. Ti chiederò conferma qui.`}
              </div>
            </div>
            <img
              src={invito.immagine}
              alt="QR per collegare il telefono"
              width={200}
              height={200}
              style={{ opacity: scaduto ? 0.15 : 1, borderRadius: 8, background: '#fff' }}
            />
            <div>
              <button className="btn" onClick={() => setInvito(null)}>
                Nascondi
              </button>
            </div>
          </div>
        )}

        {attivi.map((d) => (
          <div className="s-row" key={d.id}>
            <div>
              <div className="s-label">{d.nome}</div>
              <div className="s-label-sub">collegato il {new Date(d.collegatoIl).toLocaleDateString('it-IT')}</div>
            </div>
            <div />
            <div>
              <button className="btn danger" onClick={() => void revoca(d.id, d.nome)}>
                Scollega
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
