import { useEffect, useRef, useState } from 'react';
import { htmlAMarkdown, markdownAHtml } from './markdown';

interface ArticoloSito {
  titolo: string;
  url: string;
}

interface Props {
  contenuto: string;
  articoliSito: ArticoloSito[];
  onCambia: (markdown: string) => void;
}

// Editor dell'articolo come in un programma di scrittura. Non controllato:
// il contenuto si riscrive solo quando arriva da fuori (nuova versione
// dell'assistente o ripristino), così il cursore non salta mentre si scrive.
export default function EditorArticolo({ contenuto, articoliSito, onCambia }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const ultimo = useRef<string | null>(null);
  const selezione = useRef<Range | null>(null);
  const [link, setLink] = useState<'url' | 'sito' | null>(null);
  const [url, setUrl] = useState('https://');
  const [cerca, setCerca] = useState('');

  useEffect(() => {
    if (!ref.current || contenuto === ultimo.current) return;
    ref.current.innerHTML = markdownAHtml(contenuto);
    ultimo.current = contenuto;
  }, [contenuto]);

  function emetti() {
    if (!ref.current) return;
    const md = htmlAMarkdown(ref.current);
    ultimo.current = md;
    onCambia(md);
  }

  function comando(nome: string, valore?: string) {
    ref.current?.focus();
    // execCommand è deprecato ma resta il modo affidabile per un
    // contenteditable semplice in Chromium/Electron.
    document.execCommand(nome, false, valore);
    emetti();
  }

  function ricordaSelezione() {
    const sel = window.getSelection();
    selezione.current = sel && sel.rangeCount && ref.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
  }

  function inserisciLink(href: string, testo?: string) {
    ref.current?.focus();
    const sel = window.getSelection();
    if (selezione.current && sel) {
      sel.removeAllRanges();
      sel.addRange(selezione.current);
    }
    if (sel && sel.isCollapsed && testo) {
      document.execCommand('insertHTML', false, `<a href="${href.replace(/"/g, '&quot;')}">${testo.replace(/</g, '&lt;')}</a>`);
    } else {
      document.execCommand('createLink', false, href);
    }
    setLink(null);
    emetti();
  }

  const filtrati = articoliSito
    .filter((a) => !cerca.trim() || a.titolo.toLowerCase().includes(cerca.trim().toLowerCase()))
    .slice(0, 8);

  return (
    <div className="sd-editor-card">
      <div className="sd-toolbar" onMouseDown={(e) => e.target !== e.currentTarget && (e.target as HTMLElement).tagName === 'BUTTON' && e.preventDefault()}>
        <button title="Grassetto" onClick={() => comando('bold')}>
          <b>B</b>
        </button>
        <button title="Corsivo" onClick={() => comando('italic')}>
          <i>I</i>
        </button>
        <span className="sep" />
        <button onClick={() => comando('formatBlock', 'h2')}>Titolo</button>
        <button onClick={() => comando('formatBlock', 'h3')}>Sottotitolo</button>
        <button onClick={() => comando('formatBlock', 'p')}>Testo</button>
        <span className="sep" />
        <button onClick={() => comando('insertUnorderedList')}>• Elenco</button>
        <button onClick={() => comando('insertOrderedList')}>1. Elenco</button>
        <button title="Citazione" onClick={() => comando('formatBlock', 'blockquote')}>
          ❝
        </button>
        <span className="sep" />
        <button
          onClick={() => {
            ricordaSelezione();
            setUrl('https://');
            setLink('url');
          }}
        >
          🔗 Link
        </button>
        <button
          onClick={() => {
            ricordaSelezione();
            setCerca('');
            setLink('sito');
          }}
          disabled={!articoliSito.length}
          title={articoliSito.length ? undefined : 'Collega il sito per vedere i suoi articoli'}
        >
          Link a un articolo dello studio…
        </button>
      </div>

      {link === 'url' && (
        <form
          className="sd-link-pop"
          onSubmit={(e) => {
            e.preventDefault();
            if (/^https?:\/\/\S+\.\S+/.test(url)) inserisciLink(url);
          }}
        >
          <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn primary" type="submit">Inserisci</button>
          <button className="btn" type="button" onClick={() => setLink(null)}>Annulla</button>
        </form>
      )}
      {link === 'sito' && (
        <div className="sd-link-pop sd-link-sito">
          <input autoFocus value={cerca} onChange={(e) => setCerca(e.target.value)} placeholder="Cerca tra gli articoli pubblicati" />
          <button className="btn" onClick={() => setLink(null)}>Annulla</button>
          <div className="sd-link-elenco">
            {filtrati.map((a) => (
              <button key={a.url} onClick={() => inserisciLink(a.url, a.titolo)}>
                {a.titolo}
              </button>
            ))}
            {!filtrati.length && <span className="muted">Nessun articolo trovato.</span>}
          </div>
        </div>
      )}

      <div ref={ref} className="sd-editor" contentEditable suppressContentEditableWarning spellCheck onInput={emetti} />
    </div>
  );
}
