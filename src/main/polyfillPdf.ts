// pdf-parse (pdf.js) referenzia `DOMMatrix` anche nella build pensata per
// Node — un'API del browser che il processo main di Electron non ha, a
// differenza del processo renderer (che gira dentro Chromium). Su Windows
// questo fa fallire l'app appena avviata con "DOMMatrix is not defined",
// mai visto durante lo sviluppo perché lì non si è mai arrivati a
// impacchettare ed eseguire l'app da zero come utente finale.
//
// Deve essere il primissimo import di src/main/index.ts: i moduli ES si
// valutano in profondità nell'ordine in cui compaiono, quindi qualunque
// import scritto dopo — anche quello che porta a pdf-parse — parte solo a
// polyfill già installato.
import DOMMatrixPolyfill from 'dommatrix';

if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = DOMMatrixPolyfill;
}
