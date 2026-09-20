import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Schema fittizio usato da ConversazioneView (linkificaDocumenti) per
// segnare, dentro il markdown, un nome di documento che corrisponde a un
// file vero della pratica — mai una vera URL, intercettato prima che
// arrivi a un link cliccabile normale.
const PREFISSO_DOCUMENTO = 'jarai-doc://';

// react-markdown azzera per sicurezza ogni URL con un protocollo che non
// riconosce (http/https/mailto/...) — senza questa eccezione il nostro
// schema "jarai-doc://" arriverebbe già vuoto al componente `a` qui sotto,
// prima ancora di poter controllare il prefisso. Tutto il resto passa
// comunque dal sanificatore originale della libreria, invariato.
function urlTransform(url: string): string {
  return url.startsWith(PREFISSO_DOCUMENTO) ? url : defaultUrlTransform(url);
}

export default function Markdown({ children, onApriDocumento }: { children: string; onApriDocumento?: (id: string) => void }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={urlTransform}
      components={{
        a: ({ href, children: label }) => {
          if (href?.startsWith(PREFISSO_DOCUMENTO)) {
            const id = href.slice(PREFISSO_DOCUMENTO.length);
            return (
              <a href="#" className="doc-cita-link" onClick={(e) => { e.preventDefault(); onApriDocumento?.(id); }}>
                {label}
              </a>
            );
          }
          // Link esterni sempre via il browser di sistema (spec §2.3), mai
          // una navigazione dentro la finestra dell'app.
          return (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {label}
            </a>
          );
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
