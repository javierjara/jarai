// Tipi del "Server privato" condivisi da main, preload e finestra
// (la logica sta in src/core/sincronizzazione.ts).

export interface FileRemoto {
  chiave: string;
  /** Byte sul server (file cifrato). */
  dimensione: number;
  /** Impronta opaca del contenuto (HMAC con la chiave dello studio). */
  impronta: string;
}

export interface ElencoRemoto {
  file: FileRemoto[];
  /** Byte occupati e limite (null = senza limite). */
  usati: number;
  limite: number | null;
}

export type StatoSincronizzazione =
  | { tipo: 'disattivata' }
  | { tipo: 'in_attesa' }
  | { tipo: 'in_corso'; fatti: number; totale: number; byteFatti: number; byteTotali: number }
  | { tipo: 'sincronizzata'; quando: string; file: number; usati: number; limite: number | null; mancanti: number }
  | { tipo: 'errore'; messaggio: string; quando: string; ultimaRiuscita: string | null; usati?: number; limite?: number | null };
