import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { WebContents } from 'electron';
import { cartellaConfigurazioneClaude, leggiChiave, salvaStatoCollegamento } from './claudeAuth';
import { percorsoClaudeIntegrato } from './claudeLogin';
import { registraErroreGrezzo } from './logger';
import { creaServerDocumenti, pulisciLettureConversazione, type DocumentoRif } from './documentTools';
import { creaServerBozze, type EventoBozza } from './bozze';
import { registraUso } from './usage';

// Prompt legale (spec §6.4). Le regole 1 e 4 (verificare che i documenti
// citati esistano, citare sempre la fonte) presuppongono che l'assistente
// possa davvero leggere i documenti — vero da quando la pratica ha
// documenti importati e i due strumenti jarai-documenti sono registrati.
const PROMPT_LEGALE = `Sei l'assistente legale di JarAI, integrato nello studio di un avvocato italiano.
Rispondi sempre in italiano, con un registro professionale ma chiaro — mai gergo tecnico informatico,
mai nomi di strumenti, file di sistema o dettagli implementativi.
Se la conversazione riguarda una pratica, usa elenca_documenti per vedere cosa c'è prima di rispondere,
poi leggi_documento solo sui documenti davvero rilevanti alla domanda — non leggere tutto l'elenco per
principio, la pratica può contenere decine di file. Ogni affermazione sui fatti porta la fonte: nome del
documento e, per i PDF, il numero di pagina (il testo estratto riporta "[Pagina N]" prima di ogni pagina).
Se un documento citato dall'avvocato non risulta tra quelli disponibili, dillo esplicitamente e chiedi
dove si trova, invece di inventarne il contenuto: meglio un segnaposto dichiarato che un'affermazione
infondata. Non fondare mai un ragionamento su fatti che esporrebbero il cliente a responsabilità proprie,
fiscali o penali senza segnalarlo chiaramente. Sii conciso: qui parli con un avvocato, non stai scrivendo
un atto.
Rispondi in Markdown ben strutturato: un titolo di sezione (##) solo se la risposta ha più parti, elenchi
puntati o numerati con ogni punto su una riga propria (mai punti numerati incollati in un unico paragrafo),
**grassetto** solo sui nomi propri e i termini chiave, non su frasi intere.
Quando l'avvocato chiede di redigere un atto, una lettera o un altro documento vero e proprio (non una
semplice spiegazione), usa lo strumento crea_bozza per proporlo: nel messaggio di testo normale spiega
brevemente cosa hai fatto e segnala eventuali criticità o verifiche da fare, poi chiama crea_bozza con il
testo integrale del documento in Markdown. Non incollare mai il testo integrale della bozza anche nel
messaggio normale: risulterebbe duplicato, la bozza si vede già nel pannello.`;

type Qualita = 'Standard' | 'Massima';

interface InvioPayload {
  conversazioneId: string;
  testo: string;
  qualita: Qualita;
  praticaNome?: string;
  documenti?: DocumentoRif[];
}

interface EventoDelta {
  tipo: 'delta';
  conversazioneId: string;
  testo: string;
}
interface EventoAttivita {
  tipo: 'attivita';
  conversazioneId: string;
  testo: string;
}
interface EventoCompletato {
  tipo: 'completato';
  conversazioneId: string;
  testo: string;
  costoUsd: number;
}
interface EventoErrore {
  tipo: 'errore';
  conversazioneId: string;
  messaggio: string;
}
interface EventoBozzaPronta {
  tipo: 'bozza';
  conversazioneId: string;
  titolo: string;
  contenuto: string;
}
type EventoAgente = EventoDelta | EventoAttivita | EventoCompletato | EventoErrore | EventoBozzaPronta;

// Traduzione delle attività (spec §5.5): il nome dello strumento non arriva
// mai in chiaro all'avvocato, solo questa frase in italiano.
function attivitaPerStrumento(nomeStrumento: string): string {
  if (nomeStrumento.endsWith('__leggi_documento')) return 'Sto leggendo un documento della pratica…';
  if (nomeStrumento.endsWith('__elenca_documenti')) return 'Sto guardando i documenti della pratica…';
  if (nomeStrumento.endsWith('__crea_bozza')) return 'Sto preparando la bozza…';
  return 'Sto lavorando…';
}

const abortControllers = new Map<string, AbortController>();
const sessioniPerConversazione = new Map<string, string>();

function modelloPer(qualita: Qualita): string {
  return qualita === 'Massima' ? 'claude-opus-5' : 'claude-sonnet-5';
}

async function opzioniBase(
  qualita: Qualita,
  conversazioneId: string,
  documenti: DocumentoRif[],
  onBozza: (bozza: EventoBozza) => void,
): Promise<Options> {
  const chiave = await leggiChiave();
  const abort = new AbortController();
  abortControllers.set(conversazioneId, abort);

  return {
    model: modelloPer(qualita),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: PROMPT_LEGALE },
    tools: [], // Nessuno strumento nativo (Bash/Write/Edit/...): solo i jarai-* sotto.
    mcpServers: {
      'jarai-documenti': creaServerDocumenti(conversazioneId, documenti),
      'jarai-bozze': creaServerBozze(onBozza),
    },
    allowedTools: [
      'mcp__jarai-documenti__elenca_documenti',
      'mcp__jarai-documenti__leggi_documento',
      'mcp__jarai-bozze__crea_bozza',
    ],
    settingSources: [], // Le istruzioni dello studio arrivano da SQLite (Fase 5), mai dal disco.
    includePartialMessages: true,
    maxTurns: 12, // Margine per qualche lettura di documenti prima della risposta finale.
    resume: sessioniPerConversazione.get(conversazioneId),
    abortController: abort,
    // Stesso motivo del login (claudeLogin.ts): senza questo l'SDK cerca da
    // solo l'eseguibile di Claude Code con una risoluzione che dentro l'app
    // impacchettata (asarUnpack) non si è dimostrata affidabile.
    pathToClaudeCodeExecutable: percorsoClaudeIntegrato() ?? undefined,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: cartellaConfigurazioneClaude(),
      ...(chiave ? { ANTHROPIC_API_KEY: chiave } : {}),
    },
  };
}

function conParzialeEventuale(parziale: string, messaggioErrore: string): string {
  return parziale ? `${parziale}\n\n⚠ ${messaggioErrore}` : messaggioErrore;
}

function messaggioErroreItaliano(err: unknown): string {
  const testo = err instanceof Error ? err.message : String(err);
  if (/native cli binary|enoent|not found/i.test(testo)) {
    return 'Serve un componente aggiuntivo: installa Claude Code per collegare JarAI.';
  }
  if (/credit balance|billing/i.test(testo)) {
    return 'Il credito della chiave dello studio è esaurito. Controlla il piano su console.anthropic.com.';
  }
  if (/401|unauthoriz|authentication|invalid.?x-api-key|permission denied|not logged in|\/login/i.test(testo)) {
    return 'Non risulta un accesso a Claude attivo. Vai in Impostazioni e collega Claude.';
  }
  if (/abort/i.test(testo)) {
    return 'Richiesta interrotta.';
  }
  return 'Non riesco a raggiungere Claude. Controlla la connessione e riprova.';
}

export async function inviaMessaggio(payload: InvioPayload, webContents: WebContents): Promise<void> {
  const { conversazioneId, testo, qualita, documenti } = payload;
  const invia = (evento: EventoAgente) => {
    if (!webContents.isDestroyed()) webContents.send('claude:evento', evento);
  };

  let testoCompleto = '';
  try {
    const options = await opzioniBase(qualita, conversazioneId, documenti ?? [], (bozza) => {
      invia({ tipo: 'bozza', conversazioneId, titolo: bozza.titolo, contenuto: bozza.contenuto });
    });
    for await (const message of query({ prompt: testo, options })) {
      if (message.type === 'stream_event') {
        const event = message.event;
        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          invia({ tipo: 'attivita', conversazioneId, testo: attivitaPerStrumento(event.content_block.name) });
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          testoCompleto += event.delta.text;
          invia({ tipo: 'delta', conversazioneId, testo: event.delta.text });
        }
      } else if (message.type === 'result') {
        sessioniPerConversazione.set(conversazioneId, message.session_id);
        if (message.subtype === 'success' && !message.is_error) {
          invia({ tipo: 'completato', conversazioneId, testo: message.result, costoUsd: message.total_cost_usd });
          void registraUso(modelloPer(qualita), message.total_cost_usd);
        } else {
          // Con subtype "success" ma is_error true, il testo dell'errore sta
          // in message.result (es. "Not logged in · Please run /login") — è
          // lo stesso testo grezzo già arrivato via streaming in
          // testoCompleto, quindi qui si mostra solo la traduzione italiana,
          // mai il messaggio del CLI (spec §0: zero codice a schermo).
          // Negli altri subtype non c'è altro che il nome del subtype stesso,
          // e testoCompleto può invece contenere una risposta parziale
          // genuina da preservare (es. connessione caduta a metà).
          const erroreGrezzo = message.subtype === 'success' ? message.result : message.subtype;
          void registraErroreGrezzo('risultato-non-riuscito', erroreGrezzo);
          const messaggioAmico = messaggioErroreItaliano(new Error(erroreGrezzo));
          const messaggioFinale = message.subtype === 'success' ? messaggioAmico : conParzialeEventuale(testoCompleto, messaggioAmico);
          invia({ tipo: 'errore', conversazioneId, messaggio: messaggioFinale });
        }
      }
    }
  } catch (err) {
    const dettaglio = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    void registraErroreGrezzo('eccezione-invio', dettaglio);
    invia({ tipo: 'errore', conversazioneId, messaggio: conParzialeEventuale(testoCompleto, messaggioErroreItaliano(err)) });
  } finally {
    abortControllers.delete(conversazioneId);
  }
}

export function fermaMessaggio(conversazioneId: string): void {
  abortControllers.get(conversazioneId)?.abort();
}

export interface EsitoVerifica {
  collegato: boolean;
  modalita?: 'chiave' | 'account';
  messaggio?: string;
}

export interface FinestraUtilizzo {
  percentuale: number | null;
  siAzzeraIl: string | null;
}

export interface UtilizzoAbbonamento {
  disponibile: boolean;
  tipoAbbonamento: string | null;
  sessione: FinestraUtilizzo | null;
  settimana: FinestraUtilizzo | null;
  settimanaOpus: FinestraUtilizzo | null;
}

// Dati dietro il comando /usage di Claude Code stesso — sessione e settimana
// per gli account con un piano (Pro/Max/Team/Enterprise), diverso dal costo
// in dollari (quello si vede sempre, questo solo con un abbonamento). API
// sperimentale dell'SDK: richiede una vera richiesta di controllo su una
// query aperta, quindi consuma un turno minimo (haiku, ~$0) ogni volta che
// viene chiamata — per questo non parte da sola, solo su richiesta esplicita.
export async function leggiUtilizzoAbbonamento(): Promise<UtilizzoAbbonamento | null> {
  try {
    const chiave = await leggiChiave();
    const q = query({
      prompt: 'ok',
      options: {
        model: 'claude-haiku-4-5',
        tools: [],
        settingSources: [],
        maxTurns: 1,
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: cartellaConfigurazioneClaude(),
          ...(chiave ? { ANTHROPIC_API_KEY: chiave } : {}),
        },
      },
    });

    const scarto = (async () => {
      for await (const _messaggio of q) {
        // Il turno serve solo ad aprire la sessione; il contenuto non interessa.
      }
    })().catch(() => undefined);

    const risposta = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    await q.interrupt().catch(() => undefined);
    await scarto;

    const finestra = (f?: { utilization: number | null; resets_at: string | null } | null): FinestraUtilizzo | null =>
      f ? { percentuale: f.utilization, siAzzeraIl: f.resets_at } : null;

    return {
      disponibile: risposta.rate_limits_available,
      tipoAbbonamento: risposta.subscription_type,
      sessione: finestra(risposta.rate_limits?.five_hour),
      settimana: finestra(risposta.rate_limits?.seven_day),
      settimanaOpus: finestra(risposta.rate_limits?.seven_day_opus),
    };
  } catch {
    return null;
  }
}

export async function verificaCollegamento(): Promise<EsitoVerifica> {
  const esito = await eseguiVerifica();
  void salvaStatoCollegamento({ ...esito, verificatoIl: new Date().toISOString() });
  return esito;
}

async function eseguiVerifica(): Promise<EsitoVerifica> {
  try {
    const chiave = await leggiChiave();
    const options: Options = {
      model: 'claude-haiku-4-5',
      systemPrompt: 'Rispondi soltanto con la parola: ok',
      tools: [],
      settingSources: [],
      maxTurns: 1,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: cartellaConfigurazioneClaude(),
        ...(chiave ? { ANTHROPIC_API_KEY: chiave } : {}),
      },
    };
    let modalita: 'chiave' | 'account' | undefined;
    for await (const message of query({ prompt: 'ok?', options })) {
      if (message.type === 'system' && message.subtype === 'init') {
        // Il processo si avvia comunque anche senza un accesso valido: qui si
        // registra solo la modalità, l'esito vero arriva col messaggio result.
        modalita = message.apiKeySource === 'ANTHROPIC_API_KEY' ? 'chiave' : 'account';
      }
      if (message.type === 'result') {
        if (message.subtype === 'success' && !message.is_error) {
          void registraUso('claude-haiku-4-5', message.total_cost_usd);
          return { collegato: true, modalita };
        }
        const erroreGrezzo = message.subtype === 'success' ? message.result : message.subtype;
        return { collegato: false, messaggio: messaggioErroreItaliano(new Error(erroreGrezzo)) };
      }
    }
    return { collegato: false, messaggio: 'Non ho ricevuto risposta da Claude.' };
  } catch (err) {
    return { collegato: false, messaggio: messaggioErroreItaliano(err) };
  }
}
