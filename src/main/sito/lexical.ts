import { marked, type Token, type Tokens } from 'marked';

// Conversione Markdown ↔ Lexical (il formato JSON del campo "content" degli
// articoli in Payload). Claude scrive l'articolo in Markdown; qui diventa
// l'albero di nodi che l'editor di Payload salva e mostra, con solo i nodi
// che il template web di Payload ha di serie (paragrafi, titoli H2-H4,
// elenchi, citazioni, link, linea orizzontale): niente blocchi o upload, così
// funziona su qualunque sito Payload costruito da quel template, senza
// codice in più lato sito.
//
// Il verso opposto (Lexical → testo) serve solo a far leggere a Claude gli
// articoli già pubblicati, per lo stile e i collegamenti interni.

type NodoLexical = Record<string, unknown> & { type: string; children?: NodoLexical[] };

// Bit di formato del testo in Lexical (TextNode.__format).
const GRASSETTO = 1;
const CORSIVO = 2;
const BARRATO = 4;
const CODICE = 16;

const ELEMENTO = { format: '', indent: 0, version: 1, direction: 'ltr' as const };

function testo(text: string, format: number): NodoLexical {
  return { type: 'text', text, format, mode: 'normal', style: '', detail: 0, version: 1 };
}

function paragrafo(children: NodoLexical[]): NodoLexical {
  return { type: 'paragraph', ...ELEMENTO, textFormat: 0, textStyle: '', children };
}

// Entità HTML che marked lascia nel testo (es. &quot; &#39; &amp;).
function decodificaEntita(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function inline(tokens: Token[] | undefined, format = 0): NodoLexical[] {
  const nodi: NodoLexical[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong':
        nodi.push(...inline((t as Tokens.Strong).tokens, format | GRASSETTO));
        break;
      case 'em':
        nodi.push(...inline((t as Tokens.Em).tokens, format | CORSIVO));
        break;
      case 'del':
        nodi.push(...inline((t as Tokens.Del).tokens, format | BARRATO));
        break;
      case 'codespan':
        nodi.push(testo(decodificaEntita((t as Tokens.Codespan).text), format | CODICE));
        break;
      case 'br':
        nodi.push({ type: 'linebreak', version: 1 });
        break;
      case 'link': {
        const link = t as Tokens.Link;
        nodi.push({
          type: 'link',
          ...ELEMENTO,
          version: 3,
          fields: { url: link.href, newTab: /^https?:\/\//.test(link.href), linkType: 'custom' },
          children: inline(link.tokens, format),
        });
        break;
      }
      case 'text': {
        const tt = t as Tokens.Text;
        if (tt.tokens && tt.tokens.length > 0) nodi.push(...inline(tt.tokens, format));
        else nodi.push(testo(decodificaEntita(tt.text), format));
        break;
      }
      case 'escape':
        nodi.push(testo((t as Tokens.Escape).text, format));
        break;
      case 'image':
        // Le immagini si caricano dal pannello del sito: qui resta solo il testo alternativo.
        if ((t as Tokens.Image).text) nodi.push(testo((t as Tokens.Image).text, format));
        break;
      default:
        if ('raw' in t && typeof t.raw === 'string' && t.raw.trim()) nodi.push(testo(t.raw, format));
    }
  }
  // Due nodi di testo consecutivi con lo stesso formato diventano uno solo,
  // come li salverebbe l'editor.
  const uniti: NodoLexical[] = [];
  for (const n of nodi) {
    const prec = uniti[uniti.length - 1];
    if (prec && prec.type === 'text' && n.type === 'text' && prec.format === n.format) {
      prec.text = `${prec.text as string}${n.text as string}`;
    } else {
      uniti.push(n);
    }
  }
  return uniti;
}

function elenco(lista: Tokens.List): NodoLexical {
  const ordinato = lista.ordered;
  const start = typeof lista.start === 'number' ? lista.start : 1;
  const voci: NodoLexical[] = [];
  for (const voce of lista.items) {
    const contenuto: NodoLexical[] = [];
    const annidati: NodoLexical[] = [];
    for (const t of voce.tokens) {
      if (t.type === 'list') annidati.push(elenco(t as Tokens.List));
      else if (t.type === 'text' || t.type === 'paragraph') {
        if (contenuto.length > 0) contenuto.push({ type: 'linebreak', version: 1 });
        contenuto.push(...inline((t as Tokens.Text).tokens ?? [{ type: 'text', raw: t.raw, text: t.raw } as Tokens.Text]));
      }
    }
    voci.push({ type: 'listitem', ...ELEMENTO, value: start + voci.length, children: contenuto });
    // In Lexical un sotto-elenco vive in una voce a sé, subito dopo quella a cui appartiene.
    for (const sotto of annidati) {
      voci.push({ type: 'listitem', ...ELEMENTO, value: start + voci.length, children: [sotto] });
    }
  }
  return {
    type: 'list',
    ...ELEMENTO,
    listType: ordinato ? 'number' : 'bullet',
    tag: ordinato ? 'ol' : 'ul',
    start,
    children: voci,
  };
}

function blocchi(tokens: Token[]): NodoLexical[] {
  const nodi: NodoLexical[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
        break;
      case 'heading': {
        const h = t as Tokens.Heading;
        // L'H1 della pagina è già il titolo dell'articolo: dentro il testo si parte da H2.
        const livello = Math.min(4, Math.max(2, h.depth));
        nodi.push({ type: 'heading', ...ELEMENTO, tag: `h${livello}`, children: inline(h.tokens) });
        break;
      }
      case 'paragraph':
        nodi.push(paragrafo(inline((t as Tokens.Paragraph).tokens)));
        break;
      case 'list':
        nodi.push(elenco(t as Tokens.List));
        break;
      case 'blockquote': {
        // La citazione di Lexical contiene solo testo in linea: i paragrafi interni vanno a capo.
        const interni = blocchi((t as Tokens.Blockquote).tokens);
        const figli: NodoLexical[] = [];
        interni.forEach((n, i) => {
          if (i > 0) figli.push({ type: 'linebreak', version: 1 });
          figli.push(...(n.children ?? []));
        });
        nodi.push({ type: 'quote', ...ELEMENTO, children: figli });
        break;
      }
      case 'hr':
        nodi.push({ type: 'horizontalrule', version: 1 });
        break;
      case 'code':
        nodi.push(paragrafo([testo((t as Tokens.Code).text, CODICE)]));
        break;
      case 'table': {
        // Tabelle non previste dall'editor di serie: una riga per paragrafo.
        const tab = t as Tokens.Table;
        nodi.push(paragrafo(tab.header.flatMap((c, i) => [...(i ? [testo(' · ', GRASSETTO)] : []), ...inline(c.tokens, GRASSETTO)])));
        for (const riga of tab.rows) {
          nodi.push(paragrafo(riga.flatMap((c, i) => [...(i ? [testo(' · ', 0)] : []), ...inline(c.tokens)])));
        }
        break;
      }
      default:
        if ('raw' in t && typeof t.raw === 'string' && t.raw.trim()) nodi.push(paragrafo([testo(t.raw.trim(), 0)]));
    }
  }
  return nodi;
}

export function markdownALexical(markdown: string): { root: NodoLexical } {
  const figli = blocchi(marked.lexer(markdown, { gfm: true }));
  return {
    root: { type: 'root', format: '', indent: 0, version: 1, direction: 'ltr', children: figli.length ? figli : [paragrafo([])] },
  };
}

// ─── Lexical → testo leggibile (Markdown semplice) ────────────────────────

function testoInline(nodi: NodoLexical[] | undefined): string {
  return (nodi ?? [])
    .map((n) => {
      if (n.type === 'text') {
        const t = String(n.text ?? '');
        const f = Number(n.format ?? 0);
        return f & GRASSETTO ? `**${t}**` : f & CORSIVO ? `*${t}*` : t;
      }
      if (n.type === 'linebreak') return '\n';
      if (n.type === 'link' || n.type === 'autolink') {
        const campi = (n.fields ?? {}) as { url?: string; doc?: { value?: { slug?: string } } };
        const url = campi.url ?? (campi.doc?.value?.slug ? `/posts/${campi.doc.value.slug}` : '');
        return `[${testoInline(n.children)}](${url})`;
      }
      return testoInline(n.children);
    })
    .join('');
}

export function lexicalATesto(contenuto: unknown): string {
  const root = (contenuto as { root?: NodoLexical } | null)?.root;
  if (!root) return '';
  const righe: string[] = [];
  const visita = (nodi: NodoLexical[] | undefined, livelloElenco = 0) => {
    for (const n of nodi ?? []) {
      switch (n.type) {
        case 'heading':
          righe.push(`${'#'.repeat(Number(String(n.tag ?? 'h2').slice(1)) || 2)} ${testoInline(n.children)}`);
          break;
        case 'paragraph': {
          const t = testoInline(n.children).trim();
          if (t) righe.push(t);
          break;
        }
        case 'quote':
          righe.push(`> ${testoInline(n.children)}`);
          break;
        case 'list': {
          const numerato = n.listType === 'number';
          const voci: string[] = [];
          let numero = 0;
          for (const voce of n.children ?? []) {
            const sotto = voce.children?.find((c) => c.type === 'list');
            if (sotto) {
              // Il sotto-elenco si attacca alla voce precedente, una riga per voce.
              const prima = righe.length;
              visita([sotto], livelloElenco + 1);
              voci.push(...righe.splice(prima));
            } else {
              numero += 1;
              voci.push(`${'  '.repeat(livelloElenco)}${numerato ? `${numero}.` : '-'} ${testoInline(voce.children)}`);
            }
          }
          righe.push(voci.join('\n'));
          break;
        }
        case 'horizontalrule':
          righe.push('---');
          break;
        case 'upload':
        case 'block':
          break;
        default:
          visita(n.children, livelloElenco);
      }
    }
  };
  visita(root.children);
  return righe.join('\n\n');
}
