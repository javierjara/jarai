import { useServerPrivato } from './useServerPrivato';

// Piede della barra laterale: dove stanno i dati dello studio e, con il
// server privato, se è allineato (cliccando si va alle Impostazioni).

export default function IndicatoreServer({ onApri }: { onApri: () => void }) {
  const { server } = useServerPrivato();
  if (!server?.attivo) {
    return (
      <div className="privacy-pill-sidebar">
        <span className="dot" />
        Locale · cifrata · GDPR
      </div>
    );
  }
  const s = server.stato;
  const [classe, testo] =
    s.tipo === 'in_corso'
      ? ['attivo', `Server · ${s.fatti + 1} di ${s.totale}`]
      : s.tipo === 'in_attesa'
        ? ['attivo', 'Server · controllo…']
        : s.tipo === 'sincronizzata'
          ? ['ok', 'Server · sincronizzato']
          : s.tipo === 'errore'
            ? ['errore', 'Server · da controllare']
            : ['spento', 'Server · non attivo'];
  return (
    <>
      <button className={`server-pill ${classe}`} onClick={onApri} title={s.tipo === 'errore' ? s.messaggio : 'Server privato: apri le Impostazioni'}>
        <span className="dot" />
        {testo}
      </button>
      {/* I documenti non sono più solo su questo computer: lo si dice. */}
      <div className="privacy-pill-sidebar">
        <span className="dot" />
        Locale + server privato · GDPR
      </div>
    </>
  );
}
