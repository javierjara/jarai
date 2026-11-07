// Lavoro sul testo estratto dai documenti: parti, pagine, ricerca, date.
// Funzioni pure, usate dal desktop (src/main/indice.ts, documentTools.ts) e
// dall'assistente di riserva sul server privato (src/server/).

// Lunghezza di una "parte" restituita da leggi_documento: i documenti più
// lunghi si leggono in più chiamate invece di essere troncati.
export const CARATTERI_PER_PARTE = 60_000;

// Divide il testo in parti di circa CARATTERI_PER_PARTE, spezzando dove
// possibile fra due paragrafi (o fra due pagine) e non a metà frase.
export function dividiInParti(testo: string): string[] {
  const parti: string[] = [];
  let resto = testo;
  while (resto.length > CARATTERI_PER_PARTE) {
    let taglio = resto.lastIndexOf('\n\n', CARATTERI_PER_PARTE);
    if (taglio < CARATTERI_PER_PARTE / 2) taglio = CARATTERI_PER_PARTE;
    parti.push(resto.slice(0, taglio));
    resto = resto.slice(taglio).replace(/^\n+/, '');
  }
  parti.push(resto);
  return parti;
}

// --- Indicizzazione in background -----------------------------------------

export interface Risultato {
  documento: string;
  pagina: number | null;
  estratto: string;
}

// Minuscole e senza accenti: "perche" trova anche "perché". Carattere per
// carattere, così la lunghezza resta identica all'originale e le posizioni
// trovate valgono anche per estrarre il brano dal testo vero.
function normalizza(testo: string): string {
  let risultato = '';
  for (let i = 0; i < testo.length; i++) {
    const c = testo[i].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    risultato += c.length > 0 ? c[0] : ' ';
  }
  return risultato;
}

export function cercaInTesto(nomeDocumento: string, testo: string, cercato: string, massimo: number): Risultato[] {
  const normale = normalizza(testo);
  const ago = normalizza(cercato.trim());
  if (!ago) return [];
  const risultati: Risultato[] = [];
  let da = 0;
  while (risultati.length < massimo) {
    const pos = normale.indexOf(ago, da);
    if (pos === -1) break;
    const pagina = paginaAllaPosizione(testo, pos);
    // Brani corti: con molti risultati sono questi a pesare sul contesto.
    const inizio = Math.max(0, pos - 120);
    const fine = Math.min(testo.length, pos + ago.length + 120);
    risultati.push({
      documento: nomeDocumento,
      pagina,
      estratto: `${inizio > 0 ? '…' : ''}${testo.slice(inizio, fine).replace(/\s+/g, ' ').trim()}${fine < testo.length ? '…' : ''}`,
    });
    da = pos + ago.length;
  }
  return risultati;
}

// --- Pagine, dimensioni e date ---------------------------------------------

// Stima grossolana dei token (italiano: ~3,5 caratteri per token). Serve solo
// a dare a Claude un'idea del peso di ogni documento prima di leggerlo.
export function stimaToken(testo: string): number {
  return Math.ceil(testo.length / 3.5);
}

// Numero dell'ultima pagina marcata "[Pagina N]" nel testo (solo PDF).
export function numeroPagine(testo: string): number | null {
  let massimo = 0;
  for (const m of testo.matchAll(/^\[Pagina (\d+)/gm)) massimo = Math.max(massimo, Number(m[1]));
  return massimo > 0 ? massimo : null;
}

// Solo le pagine da `da` ad `a` (comprese) di un PDF già estratto: una
// verifica puntuale costa poche centinaia di token invece di una parte intera.
export function estraiPagine(testo: string, da: number, a: number): string | null {
  const marcatori = [...testo.matchAll(/^\[Pagina (\d+)/gm)].map((m) => ({ pagina: Number(m[1]), pos: m.index! }));
  const primo = marcatori.find((m) => m.pagina >= da && m.pagina <= a);
  if (!primo) return null;
  // Fine al primo marcatore oltre `a` (le pagine non sono sempre consecutive).
  const successivo = marcatori.find((m) => m.pos > primo.pos && m.pagina > a);
  return testo.slice(primo.pos, successivo?.pos ?? testo.length).trim();
}

function paginaAllaPosizione(testo: string, pos: number): number | null {
  const precedente = testo.lastIndexOf('[Pagina ', pos);
  if (precedente === -1) return null;
  return Number(/^\[Pagina (\d+)/.exec(testo.slice(precedente))?.[1] ?? NaN) || null;
}

const MESI: Record<string, number> = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
  luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
};

export interface DataTrovata {
  data: string; // AAAA-MM-GG, ordinabile
  documento: string;
  pagina: number | null;
  contesto: string;
}

// Date nel testo, in forma numerica (12/03/2024, 12.03.24, 12-3-2024) o
// estesa ("12 marzo 2024", "1° aprile 2023"), con una riga di contesto: una
// cronologia dei fatti si costruisce da qui senza leggere tutti i documenti.
export function trovaDate(nomeDocumento: string, testo: string): DataTrovata[] {
  const risultati: DataTrovata[] = [];
  const aggiungi = (pos: number, lunghezza: number, g: number, m: number, a: number) => {
    if (a < 100) a += a > 50 ? 1900 : 2000;
    if (m < 1 || m > 12 || g < 1 || a < 1900 || a > 2100) return;
    if (g > new Date(Date.UTC(a, m, 0)).getUTCDate()) return; // 31/02 e simili
    const inizio = Math.max(0, pos - 90);
    const fine = Math.min(testo.length, pos + lunghezza + 90);
    risultati.push({
      data: `${a}-${String(m).padStart(2, '0')}-${String(g).padStart(2, '0')}`,
      documento: nomeDocumento,
      pagina: paginaAllaPosizione(testo, pos),
      contesto: testo.slice(inizio, fine).replace(/\[Pagina[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim(),
    });
  };
  for (const m of testo.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g)) {
    aggiungi(m.index!, m[0].length, Number(m[1]), Number(m[2]), Number(m[3]));
  }
  const nomiMesi = Object.keys(MESI).join('|');
  for (const m of testo.matchAll(new RegExp(`\\b(\\d{1,2})(?:°|º)?\\s+(${nomiMesi})\\s+(\\d{4})\\b`, 'gi'))) {
    aggiungi(m.index!, m[0].length, Number(m[1]), MESI[m[2].toLowerCase()], Number(m[3]));
  }
  return risultati;
}
