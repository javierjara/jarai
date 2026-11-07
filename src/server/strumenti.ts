import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Documento } from '../shared/protocollo';
import { cercaInTesto, dividiInParti, estraiPagine, numeroPagine, stimaToken, trovaDate, type DataTrovata, type Risultato } from '../core/testi';

// Strumenti dell'assistente di riserva (JarAI Server): stessi nomi e stessi
// parametri di quelli del desktop (src/main/documentTools.ts, bozze.ts), così
// il prompt legale vale uguale. Differenze:
// - il testo dei documenti è quello già estratto dal computer dello studio
//   (indice dei testi), arrivato cifrato e decifrato qui solo in memoria;
// - la memoria della pratica si legge ma non si scrive (la scrive il computer);
// - niente OCR né trascrizioni: un documento che il computer non ha ancora
//   letto non è disponibile, e lo si dice.

export interface FontiStudio {
  documenti: Documento[];
  /** Testo estratto di un documento; null se il computer non l'ha ancora mandato. */
  testo: (documentoId: string) => Promise<string | null>;
  memoria: unknown;
}

const testoRisposta = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) });

export function creaServerDocumentiRemoti(fonti: FontiStudio): McpSdkServerConfigWithInstance {
  const { documenti } = fonti;
  const cache = new Map<string, string | null>();
  const testoDi = async (d: Documento) => {
    if (!cache.has(d.id)) cache.set(d.id, await fonti.testo(d.id).catch(() => null));
    return cache.get(d.id) ?? null;
  };
  const testiPratica = async (filtro?: string[]) => {
    const testi: Array<{ nome: string; testo: string }> = [];
    const esclusi: string[] = [];
    for (const d of documenti) {
      if (filtro && !filtro.includes(d.nome)) continue;
      const t = await testoDi(d);
      if (t === null) esclusi.push(d.nome);
      else testi.push({ nome: d.nome, testo: t });
    }
    return { testi, esclusi };
  };
  const notaEsclusi = (esclusi: string[]) =>
    esclusi.length ? `\n\n(Non disponibili ora, il computer dello studio non li ha ancora letti: ${esclusi.join(', ')})` : '';

  const elenca = tool(
    'elenca_documenti',
    'Elenca i documenti della pratica con cartella, numero di pagine, peso stimato in token e in quante parti va letto ciascuno. Usalo per pianificare le letture.',
    {},
    async () => {
      if (documenti.length === 0) return testoRisposta('Nessun documento importato in questa pratica.');
      let totale = 0;
      const righe: string[] = [];
      let nonDisponibili = 0;
      for (const d of documenti) {
        const t = await testoDi(d);
        if (t === null) {
          nonDisponibili++;
          righe.push(`- ${d.nome} — ${d.cartella} (non disponibile ora)`);
          continue;
        }
        const token = stimaToken(t);
        totale += token;
        const pagine = numeroPagine(t);
        const parti = dividiInParti(t).length;
        righe.push(`- ${d.nome} — ${d.cartella} (${[pagine ? `${pagine} pag.` : null, `~${token} token`, parti > 1 ? `${parti} parti` : null].filter(Boolean).join(', ')})`);
      }
      const riepilogo = [`${documenti.length - nonDisponibili} documenti leggibili su ${documenti.length}`, totale ? `~${totale} token` : null]
        .filter(Boolean)
        .join(' · ');
      return testoRisposta(`${riepilogo}:\n${righe.join('\n')}`);
    },
  );

  const leggi = tool(
    'leggi_documento',
    'Legge il testo di un documento della pratica, dato il suo nome esatto come mostrato da elenca_documenti. I documenti lunghi sono divisi in parti: la risposta indica "Parte N di M" e le parti successive vanno lette richiamando lo strumento con parte = N+1, fino all\'ultima. Per i PDF si può chiedere solo un intervallo di pagine con `pagine` (per esempio "12" o "12-15").',
    {
      nome: z.string().describe('Nome esatto del file, come mostrato da elenca_documenti'),
      parte: z.number().int().min(1).optional().describe('Parte da leggere, a partire da 1 (predefinita: 1)'),
      pagine: z.string().regex(/^\d+(-\d+)?$/).optional().describe('Solo per i PDF: una pagina ("12") o un intervallo ("12-15").'),
    },
    async ({ nome, parte = 1, pagine }) => {
      const d = documenti.find((x) => x.nome === nome);
      if (!d) return testoRisposta(`Nessun documento chiamato "${nome}" in questa pratica. Usa elenca_documenti per vedere i nomi esatti.`, true);
      const t = await testoDi(d);
      if (t === null) return testoRisposta(`"${nome}" non è disponibile ora: il computer dello studio non l'ha ancora letto.`, true);
      if (pagine) {
        const [da, a] = pagine.split('-').map(Number);
        const brano = estraiPagine(t, da, a ?? da);
        return brano === null ? testoRisposta(`Pagine ${pagine} non trovate in "${nome}".`, true) : testoRisposta(`${nome}, pagine ${pagine}:\n\n${brano}`);
      }
      const parti = dividiInParti(t);
      if (parte > parti.length) return testoRisposta(`"${nome}" ha ${parti.length} parti.`, true);
      return testoRisposta(`${nome} — Parte ${parte} di ${parti.length}\n\n${parti[parte - 1]}`);
    },
  );

  const cerca = tool(
    'cerca_nei_documenti',
    'Cerca una o più parole o frasi esatte in tutti i documenti della pratica (maiuscole e accenti ignorati) e restituisce i brani in cui compaiono, con documento e pagina. Passa più termini nella stessa chiamata.',
    { termini: z.array(z.string().min(2)).min(1).max(10) },
    async ({ termini }) => {
      const { testi, esclusi } = await testiPratica();
      const sezioni = termini.map((termine) => {
        const risultati: Risultato[] = [];
        let totale = 0;
        for (const { nome, testo } of testi) {
          const trovati = cercaInTesto(nome, testo, termine, 1000);
          totale += trovati.length;
          if (risultati.length < 15) risultati.push(...trovati.slice(0, Math.min(4, 15 - risultati.length)));
        }
        if (totale === 0) return `## "${termine}": nessun risultato`;
        const righe = risultati.map((r) => `- ${r.documento}${r.pagina ? `, p. ${r.pagina}` : ''}: ${r.estratto}`);
        return `## "${termine}": ${totale} occorrenze\n${righe.join('\n')}${totale > risultati.length ? `\n(altre ${totale - risultati.length} occorrenze non mostrate)` : ''}`;
      });
      return testoRisposta(sezioni.join('\n\n') + notaEsclusi(esclusi));
    },
  );

  const date = tool(
    'estrai_date',
    'Estrae le date presenti nei documenti della pratica in ordine cronologico, con documento, pagina e una riga di contesto.',
    {
      documenti: z.array(z.string()).optional(),
      dal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      al: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    },
    async ({ documenti: filtro, dal, al }) => {
      const { testi, esclusi } = await testiPratica(filtro);
      const visti = new Set<string>();
      const trovate: DataTrovata[] = [];
      for (const { nome, testo } of testi) {
        for (const d of trovaDate(nome, testo)) {
          if ((dal && d.data < dal) || (al && d.data > al)) continue;
          const k = `${d.data}|${d.documento}|${d.pagina}`;
          if (visti.has(k)) continue;
          visti.add(k);
          trovate.push(d);
        }
      }
      trovate.sort((x, y) => x.data.localeCompare(y.data));
      if (!trovate.length) return testoRisposta('Nessuna data trovata.' + notaEsclusi(esclusi));
      const righe = trovate.slice(0, 150).map((d) => `- ${d.data} — ${d.documento}${d.pagina ? `, p. ${d.pagina}` : ''}: ${d.contesto}`);
      return testoRisposta(`${trovate.length} date trovate:\n${righe.join('\n')}${notaEsclusi(esclusi)}`);
    },
  );

  const memoria = tool(
    'leggi_memoria_pratica',
    'Legge la memoria della pratica salvata dal computer dello studio: i fatti accertati e le schede dei documenti già letti integralmente.',
    {},
    async () => {
      const m = (fonti.memoria ?? {}) as { fatti?: Record<string, { valore: string }>; schede?: Record<string, { nome: string; testo: string }> };
      const fatti = Object.entries(m.fatti ?? {}).map(([k, f]) => `- **${k}**: ${f.valore}`);
      const schede = Object.values(m.schede ?? {}).map((s) => `### ${s.nome}\n${s.testo}`);
      if (!fatti.length && !schede.length) return testoRisposta('La memoria di questa pratica è vuota.');
      return testoRisposta([fatti.length ? `## Fatti\n${fatti.join('\n')}` : null, schede.length ? `## Schede dei documenti\n${schede.join('\n\n')}` : null].filter(Boolean).join('\n\n'));
    },
  );

  return createSdkMcpServer({ name: 'jarai-documenti', tools: [elenca, leggi, cerca, date, memoria] });
}

export function creaServerBozzeRemote(onBozza: (b: { titolo: string; contenuto: string }) => void): McpSdkServerConfigWithInstance {
  const crea = tool(
    'crea_bozza',
    "Propone una bozza di documento all'avvocato (atto, lettera, comparsa...). Il testo va in Markdown ben strutturato: ## per i titoli di sezione, elenchi puntati/numerati riga per riga, **grassetto** solo sui punti chiave.",
    { titolo: z.string(), contenuto: z.string() },
    async ({ titolo, contenuto }) => {
      onBozza({ titolo, contenuto });
      return testoRisposta(`Bozza «${titolo}» mostrata all'avvocato.`);
    },
  );
  return createSdkMcpServer({ name: 'jarai-bozze', tools: [crea] });
}

export const STRUMENTI_REMOTI = [
  'mcp__jarai-documenti__elenca_documenti',
  'mcp__jarai-documenti__leggi_documento',
  'mcp__jarai-documenti__cerca_nei_documenti',
  'mcp__jarai-documenti__estrai_date',
  'mcp__jarai-documenti__leggi_memoria_pratica',
  'mcp__jarai-bozze__crea_bozza',
];
