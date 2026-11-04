import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ErroreSito, elencaArticoli, leggiArticolo, statoSito } from './payload';
import { opportunitaGoogle } from './statistiche';

// Strumenti dell'assistente in modalità Studio digitale. Regole fissate qui
// nel codice, non solo nel prompt:
//  - nessuno strumento delle pratiche: in questa modalità l'assistente non
//    vede documenti, memoria o conversazioni dei clienti (agentRunner.ts),
//    così un dato riservato non può finire in un articolo pubblico;
//  - sul sito solo lettura: proponi_articolo mostra l'articolo all'avvocato
//    e basta. Invio come bozza e pubblicazione sono suoi clic (ipc.ts).

export const STRUMENTI_SITO = [
  'mcp__jarai-sito__elenca_articoli_sito',
  'mcp__jarai-sito__leggi_articolo_sito',
  'mcp__jarai-sito__proponi_articolo',
  'mcp__jarai-sito__proponi_idee',
  'mcp__jarai-sito__ricerche_google_sito',
];

export interface SlideInstagram {
  titoletto: string;
  testo: string;
}

export interface IdeaProposta {
  titolo: string;
  categoria: string;
  motivo: string;
  tipo: 'google' | 'normativa' | 'stagionale' | 'domande' | 'aggiornamento';
  fonte?: string;
}

export interface ArticoloProposto {
  titolo: string;
  slug: string;
  metaTitolo: string;
  metaDescrizione: string;
  categorie: string[];
  contenuto: string;
  /** Parole (in inglese) per cercare la foto di copertina. */
  fotoCerca?: string;
  /** Punti da controllare prima di pubblicare. */
  daVerificare?: string[];
  /** Testo del post LinkedIn che accompagna l'articolo. */
  linkedin?: string;
  /** Carosello Instagram: 5 slide (la prima è la copertina) e didascalia. */
  instagram?: { slide: SlideInstagram[]; didascalia: string };
}

export const PROMPT_STUDIO_DIGITALE = `Sei l'assistente di JarAI per la comunicazione dello studio legale: aiuti l'avvocato a scrivere
articoli per il sito dello studio, in italiano, per persone senza formazione giuridica che cercano
risposte su Google.

Prima di proporre idee o scrivere, usa elenca_articoli_sito per conoscere gli articoli già pubblicati,
e leggi con leggi_articolo_sito due o tre articoli vicini al tema per riprendere tono, lunghezza e
struttura dello studio. Non proporre un tema già trattato, salvo un aggiornamento dichiarato.

Quando l'avvocato chiede idee, guarda anche ricerche_google_sito (ricerche in cui il sito compare ma
non in prima pagina: un articolo dedicato o aggiornato può portarlo più su), scegli tre temi e
chiama proponi_idee: per ciascuno titolo, categoria
del sito, tipo e un motivo concreto in una o due frasi (la domanda che la persona scriverebbe su
Google, la novità e la sua data, gli articoli dello studio da collegare). Nel messaggio normale non
ripetere le idee: si vedono già nella scheda Idee; scrivi solo una riga di accompagnamento. Per
novità normative e giurisprudenziali cerca online (WebSearch) e cita la fonte ufficiale (Gazzetta
Ufficiale, Normattiva, Cassazione, siti istituzionali); se non trovi una fonte certa, dillo invece di
inventare.

Quando l'avvocato sceglie un tema o chiede l'articolo, scrivilo e chiama proponi_articolo con:
- titolo: chiaro, con la parola chiave che la persona cerca, massimo 70 caratteri;
- slug: parole chiave in minuscolo separate da trattini, senza articoli e preposizioni inutili;
- meta_titolo: massimo 60 caratteri; meta_descrizione: tra 120 e 155 caratteri, concreta;
- categorie: solo tra quelle del sito restituite da elenca_articoli_sito;
- contenuto in Markdown: apertura di 2-3 frasi che risponde subito alla domanda, poi sezioni con
  titoli ## (e ### se servono), paragrafi brevi, elenchi dove aiutano; niente tabelle e niente
  immagini; da 700 a 1.200 parole salvo diversa richiesta; due o tre collegamenti ad articoli già
  pubblicati dello studio quando sono pertinenti, con il loro indirizzo; chiusura con un invito
  sobrio a contattare lo studio per una valutazione del caso concreto;
- foto_cerca: due-quattro parole in inglese per cercare in un archivio fotografico un'immagine di
  copertina adatta: oggetti, luoghi o ambienti legati al tema (es. "house keys table", "family
  home exterior", "football stadium empty"). Mai persone riconoscibili, bambini o scene che
  sembrino ritrarre clienti veri; evita i soliti martelletti e bilance della giustizia;
- linkedin: il post che lo studio pubblica sulla sua pagina per far leggere l'articolo: una domanda
  o un fatto in apertura, la risposta essenziale in due-quattro righe brevi, l'invito sobrio a
  leggere l'articolo completo; 400-900 caratteri, niente hashtag a raffica (al massimo tre), niente
  emoji commerciali, nessun link (lo aggiunge LinkedIn con l'anteprima);
- instagram: carosello di 5 slide. Slide 1: titoletto = area del diritto, testo = la domanda del
  titolo (massimo 70 caratteri). Slide 2-4: titoletto di due-tre parole e un concetto per slide,
  massimo 180 caratteri, frasi semplici. Slide 5: titoletto «Il tuo caso», testo che invita ad
  approfondire sul sito. Didascalia: due-tre righe, «link in bio», tre-cinque hashtag pertinenti.
Nel messaggio normale riassumi in due righe cosa hai scritto; cosa l'avvocato deve verificare (date,
riferimenti normativi, importi) va in da_verificare. Non incollare il testo dell'articolo nel messaggio:
si vede già nell'editor. Per le correzioni richiama proponi_articolo con la versione completa, post
LinkedIn e carosello compresi. Se il messaggio dell'avvocato contiene «Versione attuale
dell'articolo», è il testo che lui ha modificato a mano: parti da quello, conserva le sue modifiche
e cambia solo ciò che chiede.

Regole deontologiche (Codice deontologico forense, art. 35 e 37), sempre:
- informazione vera, corretta e verificabile; nessuna promessa di risultato, nessuna percentuale di
  successo, nessun confronto con altri studi o avvocati, nessun tono commerciale o enfatico;
- non definire l'avvocato "specialista" o "specializzato" se non te lo conferma lui (il titolo
  di specialista è regolato per legge); va bene "si occupa di", "assiste in";
- mai nomi, fatti o dettagli riconoscibili di clienti o pratiche, nemmeno se l'avvocato li scrive in
  chat: proponi un esempio generico e diglielo;
- norme e sentenze citate con estremi completi, solo se sei sicuro che esistano.

Rispondi in Markdown ben strutturato, senza gergo informatico e senza nominare gli strumenti.`;

function errore(err: unknown) {
  const testo = err instanceof ErroreSito ? err.message : 'Il sito dello studio non è raggiungibile in questo momento.';
  return { content: [{ type: 'text' as const, text: testo }], isError: true };
}

export function creaServerSito(
  onArticolo: (articolo: ArticoloProposto) => void,
  onIdee: (idee: IdeaProposta[]) => void,
): McpSdkServerConfigWithInstance {
  const elenca = tool(
    'elenca_articoli_sito',
    "Elenca gli articoli già pubblicati sul sito dello studio (titolo, indirizzo, categorie, descrizione, data) e le categorie disponibili. Facoltativo: un filtro per parole del titolo o della descrizione.",
    { cerca: z.string().optional().describe('Parole da cercare nel titolo o nella descrizione') },
    async ({ cerca }) => {
      try {
        if (!(await statoSito()).collegato) return errore(new ErroreSito('Il sito dello studio non è collegato: chiedi all\'avvocato di collegarlo da Impostazioni.'));
        const { articoli, categorie } = await elencaArticoli();
        const parole = (cerca ?? '').toLowerCase().split(/\s+/).filter((p) => p.length > 2);
        const filtrati = parole.length
          ? articoli.filter((a) => parole.some((p) => `${a.titolo} ${a.descrizione}`.toLowerCase().includes(p)))
          : articoli;
        const righe = filtrati.map(
          (a) =>
            `- ${a.titolo} | ${a.url} | ${a.categorie.join(', ') || 'senza categoria'} | ${a.pubblicatoIl?.slice(0, 10) ?? ''}${a.descrizione ? ` | ${a.descrizione}` : ''}`,
        );
        const testo = [
          `Categorie del sito: ${categorie.map((c) => `${c.titolo} (${c.slug})`).join(', ') || 'nessuna'}.`,
          `Articoli pubblicati: ${articoli.length}${parole.length ? `, di cui ${filtrati.length} corrispondono alla ricerca` : ''}.`,
          ...righe,
        ].join('\n');
        return { content: [{ type: 'text' as const, text: testo }] };
      } catch (err) {
        return errore(err);
      }
    },
  );

  const leggi = tool(
    'leggi_articolo_sito',
    "Legge il testo completo di un articolo pubblicato sul sito dello studio, dato il suo slug (l'ultima parte dell'indirizzo).",
    { slug: z.string().min(1).describe("Slug dell'articolo, es. assegno-divorzile-calcolo") },
    async ({ slug }) => {
      try {
        const pulito = slug.split('/').filter(Boolean).pop() ?? slug;
        const articolo = await leggiArticolo(pulito);
        if (!articolo) return errore(new ErroreSito(`Nessun articolo pubblicato con slug «${pulito}».`));
        return { content: [{ type: 'text' as const, text: `# ${articolo.titolo}\n${articolo.url}\n\n${articolo.testo}` }] };
      } catch (err) {
        return errore(err);
      }
    },
  );

  const proponi = tool(
    'proponi_articolo',
    "Mostra all'avvocato l'articolo pronto per il sito, con titolo e dati per Google. Non pubblica e non invia nulla: è l'avvocato a decidere se mandarlo al sito come bozza e se pubblicarlo.",
    {
      titolo: z.string().min(5).describe("Titolo dell'articolo, massimo 70 caratteri"),
      slug: z.string().min(3).describe('Indirizzo: parole chiave in minuscolo separate da trattini'),
      meta_titolo: z.string().describe('Titolo per Google, massimo 60 caratteri'),
      meta_descrizione: z.string().describe('Descrizione per Google, 120-155 caratteri'),
      categorie: z.array(z.string()).describe('Categorie del sito (nome o slug), solo tra quelle esistenti'),
      contenuto: z.string().min(200).describe("Testo completo dell'articolo in Markdown, senza il titolo principale"),
      foto_cerca: z.string().optional().describe('2-4 parole in inglese per cercare una foto di copertina: oggetti o luoghi, mai persone'),
      da_verificare: z
        .array(z.string())
        .optional()
        .describe("Cosa l'avvocato deve controllare prima di pubblicare: date, norme e sentenze citate, importi; frasi brevi"),
      linkedin: z.string().optional().describe('Testo del post LinkedIn che accompagna l\'articolo, 400-900 caratteri'),
      instagram_slide: z
        .array(z.object({ titoletto: z.string(), testo: z.string() }))
        .optional()
        .describe('Carosello Instagram: esattamente 5 slide'),
      instagram_didascalia: z.string().optional().describe('Didascalia del carosello Instagram'),
    },
    async (a) => {
      onArticolo({
        titolo: a.titolo,
        slug: a.slug,
        metaTitolo: a.meta_titolo,
        metaDescrizione: a.meta_descrizione,
        categorie: a.categorie,
        contenuto: a.contenuto,
        ...(a.foto_cerca?.trim() ? { fotoCerca: a.foto_cerca.trim().slice(0, 100) } : {}),
        ...(a.da_verificare?.length ? { daVerificare: a.da_verificare.map((v) => v.trim()).filter(Boolean).slice(0, 8) } : {}),
        ...(a.linkedin?.trim() ? { linkedin: a.linkedin.trim() } : {}),
        ...(a.instagram_slide?.length
          ? {
              instagram: {
                slide: a.instagram_slide.slice(0, 10).map((x) => ({ titoletto: x.titoletto.trim(), testo: x.testo.trim() })),
                didascalia: a.instagram_didascalia?.trim() ?? '',
              },
            }
          : {}),
      });
      return {
        content: [{ type: 'text' as const, text: `Articolo «${a.titolo}» mostrato all'avvocato nel pannello. Non è stato inviato al sito.` }],
      };
    },
  );

  const idee = tool(
    'proponi_idee',
    "Mostra all'avvocato le idee di articoli nella scheda Idee, dove può scriverle, pianificarle o scartarle.",
    {
      idee: z
        .array(
          z.object({
            titolo: z.string().min(5).describe('Titolo provvisorio, come lo cercherebbe una persona'),
            categoria: z.string().describe('Categoria del sito'),
            motivo: z.string().min(10).describe('Perché ora: ricerca Google, novità con data e fonte, stagionalità, articoli da collegare'),
            tipo: z.enum(['google', 'normativa', 'stagionale', 'domande', 'aggiornamento']),
            fonte: z.string().optional().describe('Fonte ufficiale per le novità normative (URL)'),
          }),
        )
        .min(1)
        .max(6),
    },
    async ({ idee: proposte }) => {
      onIdee(proposte);
      return { content: [{ type: 'text' as const, text: `${proposte.length} idee mostrate all'avvocato nella scheda Idee.` }] };
    },
  );

  const ricerche = tool(
    'ricerche_google_sito',
    'Ricerche Google degli ultimi 28 giorni in cui il sito dello studio compare ma non in prima pagina (Search Console), con numero di comparse, posizione e pagina.',
    {},
    async () => {
      try {
        return { content: [{ type: 'text' as const, text: await opportunitaGoogle() }] };
      } catch (err) {
        return errore(err);
      }
    },
  );

  return createSdkMcpServer({ name: 'jarai-sito', tools: [elenca, leggi, proponi, idee, ricerche] });
}
