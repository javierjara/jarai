import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { extname } from 'node:path';
import { ESTENSIONI_AUDIO } from './formatiDocumenti';
import type { AvanzamentoTrascrizione } from './trascrizione';
import type { DocumentoRif } from './estrazioneTesto';
import {
  cercaInTesto,
  dividiInParti,
  estraiPagine,
  indicizzabile,
  numeroPagine,
  stimaToken,
  testoDocumento,
  testoSeIndicizzato,
  trovaDate,
  type DataTrovata,
  type Risultato,
} from './indice';
import { improntaFile, leggiMemoria, modificaMemoria, MAX_CARATTERI_FATTO, MAX_CARATTERI_SCHEDA, MAX_FATTI } from './memoriaPratica';

export type { DocumentoRif };

// Strumenti jarai-documenti (spec §6.2): solo lettura, scoperti per nome fra
// i documenti già indicizzati della pratica — mai un percorso libero passato
// dal modello. Un file fuori da questo elenco non è raggiungibile.

// Lavori lunghi in corso (trascrizioni audio, OCR di PDF scansionati),
// mostrati all'avvocato uno per riga con il loro avanzamento: con più audio
// nella stessa richiesta deve essere chiaro quale si sta trascrivendo e
// quali aspettano il proprio turno.
export interface LavoroDocumento {
  id: string;
  nome: string;
  tipo: 'trascrizione' | 'ocr';
  fase: AvanzamentoTrascrizione['fase'] | 'ocr' | 'completato';
  progresso?: number;
  durataSec?: number;
  // Quando è partita la fase con il progresso: serve per stimare il tempo rimanente.
  iniziatoIl?: number;
  pagina?: number;
  pagineTotali?: number;
}

// Dedup delle letture ripetute nella stessa conversazione (come in legis),
// tenuto per conversazioneId così sopravvive ai turni successivi via resume.
const lettiPerConversazione = new Map<string, Set<string>>();

export function creaServerDocumenti(
  conversazioneId: string,
  documenti: DocumentoRif[],
  onLavori: (lavori: LavoroDocumento[]) => void = () => undefined,
  praticaId?: string,
): McpSdkServerConfigWithInstance {
  if (!lettiPerConversazione.has(conversazioneId)) lettiPerConversazione.set(conversazioneId, new Set());
  const letti = lettiPerConversazione.get(conversazioneId)!;

  const lavori = new Map<string, LavoroDocumento>();
  // Il progresso della trascrizione arriva a ogni segmento (anche più volte
  // al secondo): all'interfaccia basta un aggiornamento ogni tanto.
  let ultimoInvio = 0;
  const pubblica = (forza: boolean) => {
    const ora = Date.now();
    if (!forza && ora - ultimoInvio < 500) return;
    ultimoInvio = ora;
    onLavori([...lavori.values()]);
  };
  const aggiorna = (id: string, modifiche: Partial<LavoroDocumento> & Pick<LavoroDocumento, 'nome' | 'tipo' | 'fase'>) => {
    const precedente = lavori.get(id);
    const cambioFase = precedente?.fase !== modifiche.fase;
    lavori.set(id, {
      ...precedente,
      ...modifiche,
      id,
      iniziatoIl: cambioFase ? Date.now() : precedente?.iniziatoIl,
    });
    pubblica(cambioFase);
  };
  // Una trascrizione finita resta nell'elenco (come "completata") per il
  // resto del turno: se Claude legge gli audio uno dopo l'altro, l'avvocato
  // vede comunque a che punto è ("2 di 3"). L'OCR invece sparisce e basta.
  // Il server si ricrea a ogni messaggio, quindi l'elenco riparte da zero.
  const concludi = (id: string, riuscito: boolean) => {
    const lavoro = lavori.get(id);
    if (!lavoro) return;
    if (riuscito && lavoro.tipo === 'trascrizione') lavori.set(id, { ...lavoro, fase: 'completato', progresso: 1 });
    else lavori.delete(id);
    pubblica(true);
  };

  // Testi di tutti i documenti leggibili, per gli strumenti che lavorano
  // sull'intera pratica (ricerca, date). L'audio non si trascrive per questo:
  // si usa solo se è già stato trascritto.
  const testiPratica = async (filtro?: string[]) => {
    const testi: { nome: string; testo: string }[] = [];
    const esclusi: string[] = [];
    for (const doc of documenti) {
      if (!indicizzabile(doc) || (filtro && !filtro.includes(doc.nome))) continue;
      const audio = ESTENSIONI_AUDIO.has(extname(doc.nome).slice(1).toLowerCase());
      try {
        const testo = audio ? await testoSeIndicizzato(doc) : await testoDocumento(doc);
        if (testo === null) esclusi.push(doc.nome);
        else testi.push({ nome: doc.nome, testo });
      } catch {
        esclusi.push(doc.nome);
      }
    }
    return { testi, esclusi };
  };
  const notaEsclusi = (esclusi: string[]) =>
    esclusi.length > 0 ? `\n\nEsclusi (non leggibili o audio non trascritti): ${esclusi.join(', ')}` : '';

  const elencaDocumenti = tool(
    'elenca_documenti',
    'Elenca i documenti della pratica con cartella e, se già indicizzati, numero di pagine, peso stimato in token e in quante parti va letto ciascuno. Usalo per pianificare le letture.',
    {},
    async () => {
      if (documenti.length === 0) {
        return { content: [{ type: 'text' as const, text: 'Nessun documento importato in questa pratica.' }] };
      }
      let totaleToken = 0;
      let inPreparazione = 0;
      const righe = await Promise.all(
        documenti.map(async (d) => {
          if (!indicizzabile(d)) return `- ${d.nome} — ${d.cartella} (non leggibile automaticamente)`;
          const testo = await testoSeIndicizzato(d);
          if (testo === null) {
            inPreparazione++;
            return `- ${d.nome} — ${d.cartella}`;
          }
          const token = stimaToken(testo);
          totaleToken += token;
          const pagine = numeroPagine(testo);
          const parti = dividiInParti(testo).length;
          const dettagli = [pagine ? `${pagine} pag.` : null, `~${token} token`, parti > 1 ? `${parti} parti` : null].filter(Boolean);
          return `- ${d.nome} — ${d.cartella} (${dettagli.join(', ')})`;
        }),
      );
      const leggibili = documenti.filter(indicizzabile).length;
      const riepilogo = [
        `${leggibili} documenti leggibili su ${documenti.length}`,
        totaleToken > 0 ? `~${totaleToken} token già indicizzati` : null,
        inPreparazione > 0 ? `${inPreparazione} ancora in preparazione` : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return { content: [{ type: 'text' as const, text: `${riepilogo}:\n${righe.join('\n')}` }] };
    },
  );

  const leggiDocumento = tool(
    'leggi_documento',
    'Legge il testo di un documento della pratica, dato il suo nome esatto come mostrato da elenca_documenti. I documenti lunghi sono divisi in parti: la risposta indica "Parte N di M" e le parti successive vanno lette richiamando lo strumento con parte = N+1, fino all\'ultima. Per i PDF si può chiedere solo un intervallo di pagine con `pagine` (per esempio "12" o "12-15"): molto più economico per verificare un passaggio già individuato. Le pagine scansionate sono lette con OCR. Per i file audio restituisce la trascrizione — può richiedere qualche minuto per registrazioni lunghe.',
    {
      nome: z.string().describe('Nome esatto del file, incluso il caso, come mostrato da elenca_documenti'),
      parte: z.number().int().min(1).optional().describe('Parte da leggere, a partire da 1 (predefinita: 1)'),
      pagine: z
        .string()
        .regex(/^\d+(-\d+)?$/)
        .optional()
        .describe('Solo per i PDF: una pagina ("12") o un intervallo ("12-15"). Se indicato, `parte` viene ignorata.'),
      rileggi: z
        .boolean()
        .optional()
        .describe('true per rileggere una parte già letta in questa conversazione, se il suo testo non è più disponibile'),
    },
    async ({ nome, parte = 1, pagine, rileggi = false }) => {
      const doc = documenti.find((d) => d.nome === nome);
      if (!doc) {
        return {
          content: [{ type: 'text' as const, text: `Nessun documento chiamato "${nome}" in questa pratica. Usa elenca_documenti per vedere i nomi esatti.` }],
          isError: true,
        };
      }
      if (!doc.percorso) {
        return {
          content: [{ type: 'text' as const, text: `"${nome}" non ha un contenuto leggibile: non è stato importato da una cartella reale.` }],
          isError: true,
        };
      }
      const percorso = doc.percorso;
      const chiaveLettura = pagine ? `${percorso}#p${pagine}` : `${percorso}#${parte}`;
      if (letti.has(chiaveLettura) && !rileggi && !pagine) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Hai già letto la parte ${parte} di "${nome}" in questa conversazione: usa quanto hai già estratto. Se quel testo non è più disponibile, richiama con rileggi: true.`,
            },
          ],
        };
      }
      const id = percorso;
      let riuscito = false;
      try {
        const testo = await testoDocumento(
          { ...doc, percorso },
          (a) => aggiorna(id, { nome: doc.nome, tipo: 'trascrizione', fase: a.fase, progresso: a.progresso, durataSec: a.durataSec }),
          (pagina, totale) =>
            aggiorna(id, { nome: doc.nome, tipo: 'ocr', fase: 'ocr', pagina, pagineTotali: totale, progresso: (pagina - 1) / totale }),
        );
        riuscito = true;
        if (pagine) {
          const [da, a = da] = pagine.split('-').map(Number);
          const brano = estraiPagine(testo, Math.min(da, a), Math.max(da, a));
          if (brano === null) {
            const totale = numeroPagine(testo);
            return {
              content: [
                {
                  type: 'text' as const,
                  text: totale
                    ? `"${nome}" ha ${totale} pagine: la pagina ${da} non esiste.`
                    : `"${nome}" non è diviso in pagine: leggilo per parti.`,
                },
              ],
              isError: true,
            };
          }
          letti.add(chiaveLettura);
          return { content: [{ type: 'text' as const, text: `[${nome}, pagine ${pagine}]\n\n${brano}` }] };
        }
        const parti = dividiInParti(testo);
        if (parte > parti.length) {
          return {
            content: [{ type: 'text' as const, text: `"${nome}" ha solo ${parti.length} ${parti.length === 1 ? 'parte' : 'parti'}.` }],
            isError: true,
          };
        }
        letti.add(chiaveLettura);
        const corpo = parti[parte - 1] || '(il documento risulta vuoto o senza testo estraibile)';
        if (parti.length === 1) return { content: [{ type: 'text' as const, text: corpo }] };
        const seguito =
          parte < parti.length
            ? `[Fine della parte ${parte} di ${parti.length}: continua con parte = ${parte + 1}.]`
            : `[Fine del documento: questa era l'ultima parte.]`;
        return { content: [{ type: 'text' as const, text: `[Parte ${parte} di ${parti.length} — ${nome}]\n\n${corpo}\n\n${seguito}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
      } finally {
        concludi(id, riuscito);
      }
    },
  );

  const cercaNeiDocumenti = tool(
    'cerca_nei_documenti',
    'Cerca una o più parole o frasi esatte in tutti i documenti della pratica (maiuscole e accenti ignorati) e restituisce i brani in cui compaiono, con documento e pagina. Passa più termini nella stessa chiamata invece di fare più ricerche. Utile per ritrovare nomi, date, importi o clausole. Non sostituisce la lettura: serve a verificare e ritrovare.',
    {
      termini: z
        .array(z.string().min(2))
        .min(1)
        .max(10)
        .describe('Parole o frasi da cercare, per esempio ["decreto ingiuntivo", "Rossi", "12/03/2024"]'),
    },
    async ({ termini }) => {
      // Tetti per termine e per documento: un nome che compare cento volte in
      // un solo atto non deve riempire il contesto a scapito degli altri.
      const MASSIMO_PER_TERMINE = 15;
      const MASSIMO_PER_DOCUMENTO = 4;
      const { testi, esclusi } = await testiPratica();
      const sezioni = termini.map((termine) => {
        const risultati: Risultato[] = [];
        let totale = 0;
        for (const { nome, testo } of testi) {
          const trovati = cercaInTesto(nome, testo, termine, 1000);
          totale += trovati.length;
          if (risultati.length < MASSIMO_PER_TERMINE) {
            risultati.push(...trovati.slice(0, Math.min(MASSIMO_PER_DOCUMENTO, MASSIMO_PER_TERMINE - risultati.length)));
          }
        }
        if (totale === 0) return `## "${termine}": nessun risultato`;
        const righe = risultati.map((r) => `- ${r.documento}${r.pagina ? `, p. ${r.pagina}` : ''}: ${r.estratto}`);
        const altri = totale > risultati.length ? `\n(altre ${totale - risultati.length} occorrenze non mostrate: restringi la ricerca)` : '';
        return `## "${termine}": ${totale} occorrenze\n${righe.join('\n')}${altri}`;
      });
      return { content: [{ type: 'text' as const, text: sezioni.join('\n\n') + notaEsclusi(esclusi) }] };
    },
  );

  const estraiDate = tool(
    'estrai_date',
    'Estrae tutte le date presenti nei documenti della pratica (numeriche o scritte per esteso) in ordine cronologico, ciascuna con documento, pagina e una riga di contesto. Utile per costruire una cronologia dei fatti o trovare scadenze senza rileggere i documenti interi. Le date estratte vanno verificate sul contesto: alcune possono essere numeri di protocollo o riferimenti normativi.',
    {
      documenti: z.array(z.string()).optional().describe('Nomi esatti dei documenti da considerare; se omesso, tutta la pratica'),
      dal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Solo date da questo giorno in poi (AAAA-MM-GG)'),
      al: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Solo date fino a questo giorno (AAAA-MM-GG)'),
    },
    async ({ documenti: filtro, dal, al }) => {
      const MASSIMO = 150;
      const { testi, esclusi } = await testiPratica(filtro);
      const visti = new Set<string>();
      const date: DataTrovata[] = [];
      for (const { nome, testo } of testi) {
        for (const d of trovaDate(nome, testo)) {
          if ((dal && d.data < dal) || (al && d.data > al)) continue;
          // La stessa data ripetuta nella stessa pagina (intestazioni, firme)
          // vale una riga sola.
          const chiave = `${d.data}|${d.documento}|${d.pagina}`;
          if (visti.has(chiave)) continue;
          visti.add(chiave);
          date.push(d);
        }
      }
      date.sort((x, y) => x.data.localeCompare(y.data));
      if (date.length === 0) return { content: [{ type: 'text' as const, text: 'Nessuna data trovata.' + notaEsclusi(esclusi) }] };
      const mostrate = date.slice(0, MASSIMO);
      const righe = mostrate.map((d) => `- ${d.data} — ${d.documento}${d.pagina ? `, p. ${d.pagina}` : ''}: ${d.contesto}`);
      const altre =
        date.length > MASSIMO ? `\n\n(Altre ${date.length - MASSIMO} date non mostrate: restringi con dal/al o con documenti.)` : '';
      return { content: [{ type: 'text' as const, text: `${date.length} date trovate:\n${righe.join('\n')}${altre}${notaEsclusi(esclusi)}` }] };
    },
  );

  // ─── Memoria della pratica (memoriaPratica.ts) ───────────────────────────
  const leggiMemoriaPratica = tool(
    'leggi_memoria_pratica',
    'Legge la memoria della pratica salvata nelle conversazioni precedenti: i fatti accertati e le schede dei documenti già letti integralmente (ancora validi: un documento modificato perde la scheda). Indica anche quali documenti leggibili non hanno una scheda e vanno quindi letti per intero.',
    {},
    async () => {
      const memoria = await leggiMemoria(praticaId!);
      const fatti = Object.entries(memoria.fatti).map(([chiave, f]) => `- **${chiave}**: ${f.valore}`);
      const conScheda: string[] = [];
      const daLeggere: string[] = [];
      for (const doc of documenti) {
        if (!indicizzabile(doc) || !doc.percorso) continue;
        const scheda = memoria.schede[doc.percorso];
        if (scheda && scheda.impronta === (await improntaFile(doc.percorso))) {
          conScheda.push(`### ${doc.nome}\n${scheda.testo}`);
        } else {
          daLeggere.push(`- ${doc.nome}${scheda ? ' (modificato dopo l\'ultima lettura)' : ''}`);
        }
      }
      const sezioni = [
        fatti.length > 0 ? `## Fatti accertati\n${fatti.join('\n')}` : '## Fatti accertati\nNessuno.',
        conScheda.length > 0 ? `## Schede dei documenti già letti\n${conScheda.join('\n\n')}` : null,
        daLeggere.length > 0 ? `## Documenti da leggere per intero (nessuna scheda valida)\n${daLeggere.join('\n')}` : '## Tutti i documenti leggibili hanno una scheda valida.',
      ].filter(Boolean);
      return { content: [{ type: 'text' as const, text: sezioni.join('\n\n') }] };
    },
  );

  const salvaInMemoriaPratica = tool(
    'salva_in_memoria_pratica',
    `Salva nella memoria della pratica, per le conversazioni future. Due usi, anche insieme nella stessa chiamata: (1) fatti stabili della pratica (parti e ruoli, giudice, numero di ruolo, scadenze, importi chiave, precisazioni dell'avvocato) come chiave → valore; un valore vuoto cancella il fatto; (2) la scheda di un documento appena letto per intero in questa conversazione (tutte le parti): tipo di atto, autore e destinatario, date, importi, punti chiave e domande/eccezioni, ciascuno con il numero di pagina. Massimo ${MAX_CARATTERI_SCHEDA} caratteri per scheda. Salva più schede nella stessa chiamata.`,
    {
      fatti: z
        .array(z.object({ chiave: z.string().min(1).max(100), valore: z.string().max(MAX_CARATTERI_FATTO) }))
        .max(30)
        .optional(),
      schede: z
        .array(z.object({ documento: z.string().describe('Nome esatto del documento'), scheda: z.string().min(1).max(MAX_CARATTERI_SCHEDA) }))
        .max(30)
        .optional(),
    },
    async ({ fatti = [], schede = [] }) => {
      const problemi: string[] = [];
      const daSalvare: { percorso: string; nome: string; impronta: string; testo: string }[] = [];
      for (const { documento, scheda } of schede) {
        const doc = documenti.find((d) => d.nome === documento);
        if (!doc?.percorso) {
          problemi.push(`"${documento}": non è un documento di questa pratica.`);
          continue;
        }
        // Una scheda vale come lettura integrale nelle conversazioni future:
        // si accetta solo se in questa conversazione il documento è stato
        // letto davvero tutto, parte per parte.
        const percorso = doc.percorso;
        const testo = await testoSeIndicizzato({ ...doc, percorso });
        const parti = testo === null ? 0 : dividiInParti(testo).length;
        const mancanti = Array.from({ length: parti }, (_, i) => i + 1).filter((n) => !letti.has(`${percorso}#${n}`));
        if (testo === null || mancanti.length > 0) {
          problemi.push(
            `"${documento}": leggilo prima per intero${mancanti.length > 0 ? ` (mancano le parti ${mancanti.join(', ')})` : ''}, poi salva la scheda.`,
          );
          continue;
        }
        const impronta = await improntaFile(doc.percorso);
        if (!impronta) {
          problemi.push(`"${documento}": file non più raggiungibile.`);
          continue;
        }
        daSalvare.push({ percorso: doc.percorso, nome: doc.nome, impronta, testo: scheda });
      }
      const ora = new Date().toISOString();
      let fattiIgnorati = 0;
      if (fatti.length > 0 || daSalvare.length > 0) {
        await modificaMemoria(praticaId!, (m) => {
          for (const { chiave, valore } of fatti) {
            if (!valore.trim()) delete m.fatti[chiave];
            else if (m.fatti[chiave] || Object.keys(m.fatti).length < MAX_FATTI) m.fatti[chiave] = { valore: valore.trim(), aggiornatoIl: ora };
            else fattiIgnorati++;
          }
          for (const s of daSalvare) m.schede[s.percorso] = { nome: s.nome, impronta: s.impronta, testo: s.testo.trim(), aggiornataIl: ora };
        });
      }
      const esito = [
        `Salvati: ${fatti.length - fattiIgnorati} fatti, ${daSalvare.length} schede.`,
        fattiIgnorati > 0 ? `${fattiIgnorati} fatti non salvati: la memoria ha già ${MAX_FATTI} fatti, accorpa o cancella quelli superati.` : null,
        ...problemi,
      ].filter(Boolean);
      return { content: [{ type: 'text' as const, text: esito.join('\n') }], isError: daSalvare.length === 0 && fatti.length === 0 && problemi.length > 0 };
    },
  );

  return createSdkMcpServer({
    name: 'jarai-documenti',
    tools: [
      elencaDocumenti,
      leggiDocumento,
      cercaNeiDocumenti,
      estraiDate,
      ...(praticaId ? [leggiMemoriaPratica, salvaInMemoriaPratica] : []),
    ],
  });
}

export function pulisciLettureConversazione(conversazioneId: string): void {
  lettiPerConversazione.delete(conversazioneId);
}
