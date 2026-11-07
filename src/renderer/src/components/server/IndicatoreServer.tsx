import { useServerPrivato } from './useServerPrivato';

// Indicatore in fondo alla barra laterale: si vede a colpo d'occhio se il
// server privato è allineato. Cliccando si va alle Impostazioni.

export default function IndicatoreServer({ onApri }: { onApri: () => void }) {
  const { server } = useServerPrivato();
  if (!server?.attivo) return null;
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
    <button className={`server-pill ${classe}`} onClick={onApri} title={s.tipo === 'errore' ? s.messaggio : 'Server privato: apri le Impostazioni'}>
      <span className="dot" />
      {testo}
    </button>
  );
}
