import { useCallback, useEffect, useState } from 'react';

// Stato del "Server privato" (src/main/serverPrivato.ts), aggiornato a ogni
// cambio. Lo usano la scheda nelle Impostazioni e l'indicatore nella barra.

export type StatoServer = Awaited<ReturnType<typeof window.jarai.server.stato>>;

export function useServerPrivato(): { server: StatoServer | null; sincronizza: () => Promise<void>; aggiorna: () => void } {
  const [server, setServer] = useState<StatoServer | null>(null);
  const aggiorna = useCallback(() => void window.jarai.server.stato().then(setServer), []);
  useEffect(() => {
    aggiorna();
    return window.jarai.server.onCambio(aggiorna);
  }, [aggiorna]);
  const sincronizza = useCallback(async () => {
    setServer(await window.jarai.server.sincronizza());
  }, []);
  return { server, sincronizza, aggiorna };
}

export function byte(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0).replace('.', ',')} MB`;
  return `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
}

/** "adesso", "3 min fa", "alle 14:05", "ieri alle 18:30". */
export function quando(iso: string, ora = Date.now()): string {
  const t = new Date(iso).getTime();
  const min = Math.round((ora - t) / 60_000);
  if (min < 1) return 'adesso';
  if (min < 60) return `${min} min fa`;
  const d = new Date(t);
  const orario = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date(ora).toDateString()) return `alle ${orario}`;
  return `${d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} alle ${orario}`;
}
