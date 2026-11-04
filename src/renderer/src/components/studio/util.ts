// Date e indirizzi per lo Studio digitale.

const due = (n: number) => String(n).padStart(2, '0');

/** ISO → valore di <input type="datetime-local"> (ora locale). */
export function aLocaleInput(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${due(d.getMonth() + 1)}-${due(d.getDate())}T${due(d.getHours())}:${due(d.getMinutes())}`;
}

/** Valore di <input type="datetime-local"> → ISO; vuoto → undefined. */
export function daLocaleInput(valore: string): string | undefined {
  if (!valore) return undefined;
  const d = new Date(valore);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Giorno locale AAAA-MM-GG. */
export function giornoDi(data: Date | string): string {
  const d = typeof data === 'string' ? new Date(data) : data;
  return `${d.getFullYear()}-${due(d.getMonth() + 1)}-${due(d.getDate())}`;
}

/** AAAA-MM-GG → Date a mezzanotte locale. */
export function daGiorno(giorno: string): Date {
  const [a, m, g] = giorno.split('-').map(Number);
  return new Date(a, m - 1, g);
}

export function oraBreve(iso: string): string {
  return new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

export function dataBreve(iso: string): string {
  return new Date(iso).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function dataOraBreve(iso: string): string {
  return `${dataBreve(iso)}, ${oraBreve(iso)}`;
}

export function dominioDi(url?: string | null): string {
  return (url ?? '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

/** Percorso di un indirizzo (/posts/slug), senza barra finale. */
export function percorsoDi(url: string): string {
  try {
    return new URL(url, 'https://x').pathname.replace(/\/+$/, '') || '/';
  } catch {
    return url;
  }
}

/** Lunedì della settimana di d, a mezzanotte. */
export function inizioSettimana(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

export function numero(n: number, decimali = 0): string {
  return n.toLocaleString('it-IT', { minimumFractionDigits: decimali, maximumFractionDigits: decimali });
}
