import { randomUUID } from 'node:crypto';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { WebContents } from 'electron';
import { haChiave, salvaStatoCollegamento } from './claudeAuth';
import { ambienteClaude, leggiLicenza, statoLicenza } from './licenza';
import { percorsoClaudeIntegrato } from './claudeLogin';
import { registraErroreGrezzo } from './logger';
import { creaServerDocumenti, pulisciLettureConversazione, type DocumentoRif, type LavoroDocumento } from './documentTools';
import { creaServerBozze, type EventoBozza } from './bozze';
import { registraUso } from './usage';
import { indicizzaInBackground } from './indice';
import { creaServerDejure, dejureAttiva, PROMPT_DEJURE, STRUMENTI_DEJURE } from './dejure';
import { creaServerSito, PROMPT_STUDIO_DIGITALE, STRUMENTI_SITO, type ArticoloProposto, type IdeaProposta } from './sito/strumenti';
import { funzioneAttiva } from './licenza';
import { FUNZIONE_STUDIO_DIGITALE } from './sito/ipc';

// Prompt legale (spec §6.4). Le regole 1 e 4 (verificare che i documenti
// citati esistano, citare sempre la fonte) presuppongono che l'assistente
// possa davvero leggere i documenti — vero da quando la pratica ha
// documenti importati e i due strumenti jarai-documenti sono registrati.
const PROMPT_LEGALE = `Sei l'assistente legale di JarAI, integrato nello studio di un avvocato italiano.
Rispondi sempre in italiano, con un registro professionale ma chiaro — mai gergo tecnico informatico,
mai nomi di strumenti, file di sistema o dettagli implementativi.
Se la conversazione riguarda una pratica, alla prima domanda usa insieme leggi_memoria_pratica ed
elenca_documenti, poi leggi con leggi_documento, per intero e fino all'ultima parte, OGNI documento leggibile
che non ha una scheda valida nella memoria, nessuno escluso, prima di rispondere: l'avvocato preferisce una
risposta più lenta a una fondata su una lettura parziale. Per i documenti che hanno già una scheda parti
dalla scheda e torna sul testo (pagine indicate nella scheda o cerca_nei_documenti) ogni volta che la
domanda richiede la formulazione esatta o un dettaglio che la scheda non riporta. Leggi più documenti nello
stesso passaggio (fino a 8-10 chiamate insieme), non uno alla volta: ogni passaggio in più costa tempo e
denaro. Appena hai letto per intero dei documenti senza scheda, salvane le schede con
salva_in_memoria_pratica (più schede nella stessa chiamata): sintetiche ma con le pagine, così le prossime
conversazioni non devono rileggerli. Salva lì anche i fatti stabili della pratica quando li accerti o
l'avvocato li precisa. Nelle domande successive della stessa conversazione non rileggere quello che hai già
letto: per verificare un punto preciso usa cerca_nei_documenti (più termini in una sola chiamata) o
leggi_documento con l'intervallo di pagine. Per cronologie, scadenze e sequenze di fatti parti da
estrai_date e verifica sul testo solo i passaggi che contano. Se un documento non si riesce a
leggere, dillo alla fine della risposta indicandolo per nome. Ogni affermazione sui fatti porta la fonte: nome
del documento e, per i PDF, il numero di pagina (il testo estratto riporta "[Pagina N]" prima di ogni pagina).
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

// "pratica": l'assistente legale di sempre. "studio-digitale": articoli per
// il sito dello studio, con strumenti propri e nessun accesso alle pratiche.
type Modalita = 'pratica' | 'studio-digitale';

interface InvioPayload {
  conversazioneId: string;
  modalita?: Modalita;
  testo: string;
  qualita: Qualita;
  praticaId?: string;
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
interface EventoLavori {
  tipo: 'lavori';
  conversazioneId: string;
  lavori: LavoroDocumento[];
}
interface EventoArticolo {
  tipo: 'articolo';
  conversazioneId: string;
  articolo: ArticoloProposto;
}
interface EventoIdee {
  tipo: 'idee';
  conversazioneId: string;
  idee: IdeaProposta[];
}
type EventoAgente =
  | EventoDelta
  | EventoAttivita
  | EventoCompletato
  | EventoErrore
  | EventoBozzaPronta
  | EventoLavori
  | EventoArticolo
  | EventoIdee;

// Traduzione delle attività (spec §5.5): il nome dello strumento non arriva
// mai in chiaro all'avvocato, solo questa frase in italiano.
function attivitaPerStrumento(nomeStrumento: string): string {
  if (nomeStrumento.endsWith('__leggi_documento')) return 'Sto leggendo un documento della pratica…';
  if (nomeStrumento.endsWith('__elenca_documenti')) return 'Sto guardando i documenti della pratica…';
  if (nomeStrumento.endsWith('__cerca_nei_documenti')) return 'Sto cercando nei documenti della pratica…';
  if (nomeStrumento.endsWith('__estrai_date')) return 'Sto ricostruendo le date della pratica…';
  if (nomeStrumento.endsWith('__leggi_memoria_pratica')) return 'Sto ripassando gli appunti sulla pratica…';
  if (nomeStrumento.endsWith('__salva_in_memoria_pratica')) return 'Sto annotando i punti chiave della pratica…';
  if (nomeStrumento.endsWith('__crea_bozza')) return 'Sto preparando la bozza…';
  if (nomeStrumento.endsWith('__cerca_dejure')) return 'Sto cercando giurisprudenza su DeJure…';
  if (nomeStrumento.endsWith('__leggi_dejure')) return 'Sto leggendo una pronuncia su DeJure…';
  if (nomeStrumento.endsWith('__elenca_articoli_sito')) return 'Sto guardando gli articoli del sito…';
  if (nomeStrumento.endsWith('__leggi_articolo_sito')) return 'Sto leggendo un articolo del sito…';
  if (nomeStrumento.endsWith('__proponi_articolo')) return 'Sto preparando l\'articolo…';
  if (nomeStrumento.endsWith('__proponi_idee')) return 'Sto preparando le idee…';
  if (nomeStrumento.endsWith('__ricerche_google_sito')) return 'Sto guardando le ricerche su Google…';
  if (nomeStrumento === 'WebSearch' || nomeStrumento === 'web_search') return 'Sto cercando novità online…';
  return 'Sto lavorando…';
}

const abortControllers = new Map<string, AbortController>();
const sessioniPerConversazione = new Map<string, string>();

function modelloPer(qualita: Qualita): string {
  return qualita === 'Massima' ? 'claude-opus-5-5' : 'claude-sonnet-5';
}

// Il ragionamento si paga come testo in uscita (la voce più cara): per le
// domande di tutti i giorni basta un livello medio, "Massima" ragiona a fondo.
function effortPer(qualita: Qualita): 'medium' | 'high' {
  return qualita === 'Massima' ? 'high' : 'medium';
}

// Tetto di spesa per singola domanda, solo con la licenza JarAI (lì il costo
// è di JarAI, non dello studio): protegge da una domanda che scatena letture
// a catena su una pratica enorme. Con la stima di una pratica media da 100
// file (~$3 Standard, ~$8 Massima) resta un margine ampio.
const TETTO_USD_PER_DOMANDA: Record<Qualita, number> = { Standard: 8, Massima: 20 };

// Ogni lettura di documento è almeno un turno (di più per i documenti divisi
// in parti), e il prompt chiede di leggere tutta la pratica: il margine
// cresce con il numero di documenti invece di fermarsi a metà elenco.
function turniMassimi(numeroDocumenti: number): number {
  return Math.min(300, 20 + numeroDocumenti * 3);
}

// Il preset "claude_code" porta con sé migliaia di token di istruzioni per
// programmare, rimandati a ogni passaggio e fuori tema per un avvocato. Con
// una chiave API (dello studio o dietro la licenza JarAI) si usa solo il
// prompt legale. Con l'accesso tramite account Claude il preset resta: quel
// tipo di accesso è pensato per Claude Code e va usato con la sua identità.
function promptDiSistema(soloPromptLegale: boolean, prompt: string): Options['systemPrompt'] {
  if (!soloPromptLegale) return { type: 'preset', preset: 'claude_code', append: prompt };
  const oggi = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return `${prompt}\nOggi è ${oggi}.`;
}

// Studio digitale: prompt e strumenti propri. Nessuno strumento delle
// pratiche (documenti, memoria, bozze, DeJure): un dato di un cliente non
// può arrivare in un articolo destinato al pubblico. WebSearch serve per
// le novità normative.
async function opzioniStudioDigitale(
  qualita: Qualita,
  conversazioneId: string,
  onArticolo: (articolo: ArticoloProposto) => void,
  onIdee: (idee: IdeaProposta[]) => void,
): Promise<Options> {
  const abort = new AbortController();
  abortControllers.set(conversazioneId, abort);
  const conLicenza = (await leggiLicenza()) !== null;
  const conChiave = !conLicenza && (await haChiave());
  return {
    model: modelloPer(qualita),
    effort: effortPer(qualita),
    maxBudgetUsd: conLicenza ? TETTO_USD_PER_DOMANDA[qualita] : undefined,
    systemPrompt: promptDiSistema(conLicenza || conChiave, PROMPT_STUDIO_DIGITALE),
    tools: ['WebSearch'],
    mcpServers: { 'jarai-sito': creaServerSito(onArticolo, onIdee) },
    allowedTools: ['WebSearch', ...STRUMENTI_SITO],
    settingSources: [],
    includePartialMessages: true,
    maxTurns: 40,
    resume: sessioniPerConversazione.get(conversazioneId),
    abortController: abort,
    pathToClaudeCodeExecutable: percorsoClaudeIntegrato() ?? undefined,
    env: await ambienteClaude(randomUUID()),
  };
}

async function opzioniBase(
  qualita: Qualita,
  conversazioneId: string,
  praticaId: string | undefined,
  documenti: DocumentoRif[],
  onBozza: (bozza: EventoBozza) => void,
  onLavori: (lavori: LavoroDocumento[]) => void,
): Promise<Options> {
  const abort = new AbortController();
  abortControllers.set(conversazioneId, abort);

  const conLicenza = (await leggiLicenza()) !== null;
  const conChiave = !conLicenza && (await haChiave());
  // DeJure (src/main/dejure.ts): gli strumenti esistono solo se l'avvocato
  // ha collegato la banca dati da Impostazioni → Integrazioni.
  const conDejure = await dejureAttiva();

  return {
    model: modelloPer(qualita),
    effort: effortPer(qualita),
    maxBudgetUsd: conLicenza ? TETTO_USD_PER_DOMANDA[qualita] : undefined,
    systemPrompt: promptDiSistema(conLicenza || conChiave, conDejure ? `${PROMPT_LEGALE}\n${PROMPT_DEJURE}` : PROMPT_LEGALE),
    tools: [], // Nessuno strumento nativo (Bash/Write/Edit/...): solo i jarai-* sotto.
    mcpServers: {
      'jarai-documenti': creaServerDocumenti(conversazioneId, documenti, onLavori, praticaId),
      'jarai-bozze': creaServerBozze(onBozza),
      ...(conDejure ? { 'jarai-dejure': creaServerDejure() } : {}),
    },
    allowedTools: [
      'mcp__jarai-documenti__elenca_documenti',
      'mcp__jarai-documenti__leggi_documento',
      'mcp__jarai-documenti__cerca_nei_documenti',
      'mcp__jarai-documenti__estrai_date',
      'mcp__jarai-documenti__leggi_memoria_pratica',
      'mcp__jarai-documenti__salva_in_memoria_pratica',
      'mcp__jarai-bozze__crea_bozza',
      ...(conDejure ? STRUMENTI_DEJURE : []),
    ],
    settingSources: [], // Le istruzioni dello studio arrivano da SQLite (Fase 5), mai dal disco.
    includePartialMessages: true,
    maxTurns: turniMassimi(documenti.length),
    resume: sessioniPerConversazione.get(conversazioneId),
    abortController: abort,
    // Stesso motivo del login (claudeLogin.ts): senza questo l'SDK cerca da
    // solo l'eseguibile di Claude Code con una risoluzione che dentro l'app
    // impacchettata (asarUnpack) non si è dimostrata affidabile.
    pathToClaudeCodeExecutable: percorsoClaudeIntegrato() ?? undefined,
    // Un id nuovo per ogni messaggio inviato: con la licenza JarAI il proxy
    // conta le domande, non le singole chiamate a Claude di questo turno.
    env: await ambienteClaude(randomUUID()),
  };
}

function conParzialeEventuale(parziale: string, messaggioErrore: string): string {
  return parziale ? `${parziale}\n\n⚠ ${messaggioErrore}` : messaggioErrore;
}

function messaggioErroreItaliano(err: unknown): string {
  const testo = err instanceof Error ? err.message : String(err);
  // Errori del proxy JarAI (licenza, limite del mese, modello non incluso):
  // sono già scritti per l'avvocato, si mostrano così come arrivano.
  const erroreLicenza = testo.match(/(Licenza JarAI[^\n]*?\.|Hai raggiunto il limite[^\n]*?JarAI\.|Modello non incluso[^\n]*)/);
  if (erroreLicenza) return erroreLicenza[1];
  if (/native cli binary|enoent|not found/i.test(testo)) {
    // Con il claude.exe incluso in JarAI presente, l'errore non dipende da
    // un'installazione a parte: dire "installa Claude Code" a chi l'ha già
    // installato manda fuori strada. Senza, è l'app a essere incompleta.
    return percorsoClaudeIntegrato()
      ? 'Non riesco ad avviare il componente Claude incluso in JarAI. Riavvia JarAI e riprova.'
      : 'Questa installazione di JarAI è incompleta (manca il componente Claude incluso). Reinstalla l\'ultima versione di JarAI.';
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
  if (/error_max_turns/.test(testo)) {
    return 'La pratica è molto ampia e non sono riuscito a completare la lettura in questa richiesta. Chiedimi di continuare, oppure restringi la domanda a una parte dei documenti.';
  }
  if (/error_max_budget_usd/.test(testo)) {
    return 'Questa richiesta ha raggiunto il limite di spesa previsto per una singola domanda. Prova a restringerla a una parte dei documenti o a una questione più precisa.';
  }
  return 'Non riesco a raggiungere Claude. Controlla la connessione e riprova.';
}

export async function inviaMessaggio(payload: InvioPayload, webContents: WebContents): Promise<void> {
  const { conversazioneId, testo, qualita, praticaId, documenti } = payload;
  const studioDigitale = payload.modalita === 'studio-digitale';
  const invia = (evento: EventoAgente) => {
    if (!webContents.isDestroyed()) webContents.send('claude:evento', evento);
  };

  // Pratiche importate prima dell'indice, o file cambiati nel frattempo:
  // l'indicizzazione parte comunque, così le letture successive sono pronte.
  if (!studioDigitale) indicizzaInBackground(documenti ?? []);

  let testoCompleto = '';
  try {
    if (studioDigitale && !(await funzioneAttiva(FUNZIONE_STUDIO_DIGITALE))) {
      invia({ tipo: 'errore', conversazioneId, messaggio: 'Lo Studio digitale non è attivo per questa licenza JarAI.' });
      return;
    }
    const options = studioDigitale
      ? await opzioniStudioDigitale(
          qualita,
          conversazioneId,
          (articolo) => invia({ tipo: 'articolo', conversazioneId, articolo }),
          (idee) => invia({ tipo: 'idee', conversazioneId, idee }),
        )
      : await opzioniBase(
          qualita,
          conversazioneId,
          praticaId,
          documenti ?? [],
          (bozza) => invia({ tipo: 'bozza', conversazioneId, titolo: bozza.titolo, contenuto: bozza.contenuto }),
          (lavori) => invia({ tipo: 'lavori', conversazioneId, lavori }),
        );
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
  modalita?: 'chiave' | 'account' | 'licenza';
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
  // Con la licenza JarAI l'utilizzo si legge dal proxy (statoLicenza) e
  // questa richiesta conterebbe come una domanda del mese: non si fa.
  if (await leggiLicenza()) return null;
  try {
    const q = query({
      prompt: 'ok',
      options: {
        model: 'claude-haiku-4-5',
        tools: [],
        settingSources: [],
        maxTurns: 1,
        pathToClaudeCodeExecutable: percorsoClaudeIntegrato() ?? undefined,
        env: await ambienteClaude(),
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
  // Con la licenza si chiede lo stato al proxy: nessuna richiesta a Claude,
  // quindi la verifica non consuma domande del mese.
  if (await leggiLicenza()) {
    const stato = await statoLicenza();
    return stato.valida ? { collegato: true, modalita: 'licenza' } : { collegato: false, messaggio: stato.messaggio };
  }
  try {
    const options: Options = {
      model: 'claude-haiku-4-5',
      systemPrompt: 'Rispondi soltanto con la parola: ok',
      tools: [],
      settingSources: [],
      maxTurns: 1,
      // Stesso motivo di opzioniBase() sopra: senza questo l'SDK cerca da
      // solo l'eseguibile di Claude Code con una risoluzione inaffidabile
      // dentro l'app impacchettata.
      pathToClaudeCodeExecutable: percorsoClaudeIntegrato() ?? undefined,
      env: await ambienteClaude(),
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
    void registraErroreGrezzo('eccezione-verifica', err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
    return { collegato: false, messaggio: messaggioErroreItaliano(err) };
  }
}
