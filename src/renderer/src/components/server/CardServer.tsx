import { useEffect, useState } from 'react';
import { byte, quando, useServerPrivato } from './useServerPrivato';

// "Server privato": copia delle pratiche su JarAI Server, per leggerle dal
// telefono anche a computer spento. Visibile solo se attivato dal CRM.

export default function CardServer() {
  const { server, sincronizza } = useServerPrivato();
  const [ora, setOra] = useState(Date.now());
  const [premuto, setPremuto] = useState(false);

  // "3 min fa" si aggiorna da solo.
  useEffect(() => {
    const t = setInterval(() => setOra(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!server?.attivo) return null;
  const s = server.stato;
  const inCorso = s.tipo === 'in_corso' || s.tipo === 'in_attesa';
  const usati = s.tipo === 'sincronizzata' ? s.usati : s.tipo === 'errore' ? s.usati : undefined;
  const limite = s.tipo === 'sincronizzata' ? s.limite : s.tipo === 'errore' ? s.limite : undefined;
  const quota = usati !== undefined && limite ? Math.min(1, usati / limite) : null;

  const [colore, titolo, dettaglio] =
    s.tipo === 'in_corso'
      ? ['var(--amber)', `Sincronizzo ${s.fatti + 1} di ${s.totale}`, `${byte(s.byteFatti)} di ${byte(s.byteTotali)}`]
      : s.tipo === 'in_attesa'
        ? ['var(--amber)', 'Controllo le pratiche…', '']
        : s.tipo === 'sincronizzata'
          ? [
              'var(--sage)',
              'Sincronizzato',
              `${s.file === 1 ? '1 file' : `${s.file} file`} · aggiornato ${quando(s.quando, ora)}`,
            ]
          : s.tipo === 'errore'
            ? ['var(--oxblood)', s.messaggio, s.ultimaRiuscita ? `Ultima sincronizzazione riuscita ${quando(s.ultimaRiuscita, ora)}` : 'Non ancora sincronizzato']
            : ['var(--faint)', 'Non attivo', ''];

  const avvia = async () => {
    setPremuto(true);
    await sincronizza();
    setPremuto(false);
  };

  return (
    <div className="s-card">
      <div className="s-card-head">
        <div className="s-card-title">Server privato</div>
        <div className="s-card-sub">
          I documenti delle pratiche sono copiati sul server dello studio, così si leggono dal telefono anche a computer spento. Quello che togli
          da una pratica qui sparisce anche dal server.
        </div>
      </div>
      <div className="s-card-body">
        <div className="s-row">
          <div>
            <div className="s-label">Stato</div>
            <div className="s-label-sub">{server.url?.replace(/^https?:\/\//, '')}</div>
          </div>
          <div className="api-key-row server-stato">
            <span className={`dot${inCorso ? ' server-dot-attivo' : ''}`} style={{ background: colore, boxShadow: 'none' }} />
            <span className="v" style={{ letterSpacing: 0 }}>
              <span style={{ color: s.tipo === 'errore' ? 'var(--oxblood)' : 'var(--ink)' }}>{titolo}</span>
              {dettaglio && <span className="server-dettaglio">{dettaglio}</span>}
            </span>
          </div>
          <div>
            <button className="btn" onClick={() => void avvia()} disabled={inCorso || premuto}>
              {inCorso || premuto ? 'Sincronizzo…' : 'Sincronizza ora'}
            </button>
          </div>
        </div>

        {s.tipo === 'in_corso' && (
          <div className="server-barra" aria-label="Avanzamento">
            <div style={{ width: `${s.byteTotali ? Math.max(3, (s.byteFatti / s.byteTotali) * 100) : 3}%` }} />
          </div>
        )}

        {usati !== undefined && (
          <div className="s-row">
            <div>
              <div className="s-label">Spazio</div>
              <div className="s-label-sub">{limite ? `${byte(usati)} di ${byte(limite)}` : `${byte(usati)} usati`}</div>
            </div>
            <div>
              {quota !== null && (
                <div className={`server-barra${quota > 0.9 ? ' piena' : ''}`}>
                  <div style={{ width: `${Math.max(1, quota * 100)}%` }} />
                </div>
              )}
            </div>
            <div />
          </div>
        )}

        {s.tipo === 'sincronizzata' && s.mancanti > 0 && (
          <div className="server-nota">
            <strong>{s.mancanti === 1 ? '1 documento non trovato.' : `${s.mancanti} documenti non trovati.`}</strong>{' '}
            {s.mancanti === 1 ? 'Il suo file è stato spostato' : 'I loro file sono stati spostati'} o rinominati su questo computer: restano
            fuori dal server finché non li ricolleghi alla pratica.
          </div>
        )}
      </div>
    </div>
  );
}
