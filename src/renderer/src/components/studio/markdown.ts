import { marked } from 'marked';

// Editor dell'articolo: il testo resta in Markdown (formato dell'assistente e
// di lexical.ts), l'avvocato lo modifica come in un programma di scrittura.
// Solo gli elementi che il sito sa mostrare: titoli, paragrafi, elenchi,
// citazioni, grassetto, corsivo, link.

export function markdownAHtml(md: string): string {
  return marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
}

function testoSicuro(t: string): string {
  return t.replace(/\u00a0/g, ' ').replace(/([*_`[\]])/g, '\\$1');
}

function inline(nodo: Node): string {
  let out = '';
  nodo.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      out += testoSicuro(n.textContent ?? '');
      return;
    }
    if (!(n instanceof HTMLElement)) return;
    const dentro = inline(n);
    switch (n.tagName) {
      case 'B':
      case 'STRONG':
        out += dentro.trim() ? `**${dentro}**` : dentro;
        break;
      case 'I':
      case 'EM':
        out += dentro.trim() ? `*${dentro}*` : dentro;
        break;
      case 'A': {
        const href = n.getAttribute('href') ?? '';
        out += href ? `[${dentro}](${href})` : dentro;
        break;
      }
      case 'CODE':
        out += `\`${n.textContent ?? ''}\``;
        break;
      case 'BR':
        out += '\n';
        break;
      default:
        out += dentro;
    }
  });
  return out;
}

function elenco(el: HTMLElement, ordinato: boolean, livello: number): string {
  const righe: string[] = [];
  let i = 1;
  el.childNodes.forEach((n) => {
    if (!(n instanceof HTMLElement) || n.tagName !== 'LI') return;
    const rientro = '   '.repeat(livello);
    const segno = ordinato ? `${i++}.` : '-';
    const testo: string[] = [];
    const sotto: string[] = [];
    n.childNodes.forEach((c) => {
      if (c instanceof HTMLElement && (c.tagName === 'UL' || c.tagName === 'OL')) sotto.push(elenco(c, c.tagName === 'OL', livello + 1));
      else if (c instanceof HTMLElement && c.tagName === 'P') testo.push(inline(c));
      else if (c instanceof HTMLElement) {
        // Grassetto, corsivo e link direttamente nel punto elenco.
        const involucro = document.createElement('span');
        involucro.appendChild(c.cloneNode(true));
        testo.push(inline(involucro));
      } else if (c.nodeType === Node.TEXT_NODE) testo.push(testoSicuro(c.textContent ?? ''));
    });
    righe.push(`${rientro}${segno} ${testo.join('').replace(/\s+/g, ' ').trim()}`);
    righe.push(...sotto);
  });
  return righe.join('\n');
}

export function htmlAMarkdown(radice: HTMLElement): string {
  const blocchi: string[] = [];
  radice.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = (n.textContent ?? '').trim();
      if (t) blocchi.push(t);
      return;
    }
    if (!(n instanceof HTMLElement)) return;
    switch (n.tagName) {
      case 'H1':
      case 'H2':
        blocchi.push(`## ${inline(n).trim()}`);
        break;
      case 'H3':
      case 'H4':
        blocchi.push(`### ${inline(n).trim()}`);
        break;
      case 'UL':
      case 'OL':
        blocchi.push(elenco(n, n.tagName === 'OL', 0));
        break;
      case 'BLOCKQUOTE':
        blocchi.push(
          htmlAMarkdown(n)
            .split('\n')
            .map((r) => `> ${r}`)
            .join('\n'),
        );
        break;
      case 'HR':
        blocchi.push('---');
        break;
      default: {
        // P, DIV (Invio in contenteditable) e il resto: un paragrafo.
        const t = inline(n).trim();
        if (t) blocchi.push(t);
      }
    }
  });
  return blocchi.filter(Boolean).join('\n\n');
}
