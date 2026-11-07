import { randomUUID } from 'node:crypto';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { EventoMotore, Motore, RichiestaMotore } from '../core/host';
import type { MessaggioProiettato } from '../shared/reducer';
import { creaServerBozzeRemote, creaServerDocumentiRemoti, STRUMENTI_REMOTI, type FontiStudio } from './strumenti';

// Il motore dell'assistente di riserva (JarAI Server): stesso SDK, stessi
// modelli e stesso tetto di spesa del desktop (src/main/agentRunner.ts), con
// gli strumenti di src/server/strumenti.ts. Le domande passano dal proxy
// JarAI con la licenza dello studio, come dal desktop.
//
// Le sessioni di Claude (che contengono la conversazione in chiaro) stanno
// in una cartella in RAM e spariscono quando il server dimentica la chiave:
// se una sessione non c'è più, la storia della conversazione si rimanda nel
// prompt.

// TODO: unificare con PROMPT_LEGALE di src/main/agentRunner.ts quando quel
// file si sposta in src/core (oggi ha modifiche in corso).
export const PROMPT_LEGALE_SERVER = `Sei l'assistente legale di JarAI, integrato nello studio di un avvocato italiano.
Stai rispondendo dal server dello studio perché il computer dello studio è spento: hai i documenti delle
pratiche già letti dal computer e la memoria della pratica (in sola lettura).
Rispondi sempre in italiano, con un registro professionale ma chiaro — mai gergo tecnico informatico,
mai nomi di strumenti, file di sistema o dettagli implementativi.
Se la conversazione riguarda una pratica, alla prima domanda usa insieme leggi_memoria_pratica ed
elenca_documenti, poi leggi con leggi_documento, per intero e fino all'ultima parte, ogni documento disponibile
che non ha una scheda nella memoria, prima di rispondere. Per i documenti che hanno già una scheda parti
dalla scheda e torna sul testo (pagine o cerca_nei_documenti) quando serve la formulazione esatta.
Leggi più documenti nello stesso passaggio (fino a 8-10 chiamate insieme). Nelle domande successive non
rileggere quello che hai già letto: usa cerca_nei_documenti o leggi_documento con l'intervallo di pagine.
Per cronologie e scadenze parti da estrai_date. Da qui la banca dati DeJure non è raggiungibile: se l'avvocato
chiede giurisprudenza su DeJure, digli che la ricerca è disponibile a computer dello studio acceso. Se un documento non è disponibile, dillo alla fine della
risposta indicandolo per nome. Ogni affermazione sui fatti porta la fonte: nome del documento e, per i PDF,
il numero di pagina ("[Pagina N]" nel testo). Se un documento citato dall'avvocato non risulta tra quelli
disponibili, dillo e chiedi dove si trova invece di inventarne il contenuto. Sii conciso.
Rispondi in Markdown ben strutturato (## solo se la risposta ha più parti, elenchi con un punto per riga,
**grassetto** solo su nomi propri e termini chiave).
Quando l'avvocato chiede di redigere un atto, una lettera o un altro documento vero e proprio, usa
crea_bozza: nel messaggio normale spiega brevemente cosa hai fatto e le verifiche da fare, poi chiama
crea_bozza con il testo integrale in Markdown. Non incollare il testo della bozza anche nel messaggio.`;

const TETTO_USD: Record<'Standard' | 'Massima', number> = { Standard: 8, Massima: 20 };

export interface OpzioniMotoreServer {
  proxy: string;
  licenza: string;
  /** Cartella in RAM per le sessioni di Claude (CLAUDE_CONFIG_DIR) e la cartella di lavoro. */
  cartellaSessioni: string;
  /** Documenti, testi e memoria della pratica. */
  fonti: (praticaId: string | null, documenti: RichiestaMotore['documenti']) => FontiStudio;
  /** Messaggi già scambiati, per rimandarli se la sessione di Claude non c'è più. */
  storia: (conversazioneId: string) => MessaggioProiettato[];
  /** Eseguibile di Claude Code (nell'immagine Docker). */
  eseguibile?: string;
  /** Per le prove: al posto dell'SDK vero. */
  interroga?: typeof query;
  registraErrore?: (contesto: string, dettaglio: string) => void;
}

export function messaggioErrore(testo: string): string {
  const licenza = testo.match(/(Licenza JarAI[^\n]*?\.|Hai raggiunto il limite[^\n]*?JarAI\.|Modello non incluso[^\n]*)/);
  if (licenza) return licenza[1];
  if (/abort/i.test(testo)) return 'Richiesta interrotta.';
  if (/error_max_turns/.test(testo)) return 'La pratica è molto ampia e non sono riuscito a completare la lettura. Chiedimi di continuare, oppure restringi la domanda.';
  if (/error_max_budget_usd/.test(testo)) return 'Questa richiesta ha raggiunto il limite di spesa previsto per una singola domanda. Prova a restringerla.';
  if (/401|unauthoriz|authentication|invalid.?x-api-key/i.test(testo)) return 'Il server dello studio non riesce a usare la licenza JarAI.';
  return 'Il server dello studio non riesce a raggiungere Claude. Riprova tra poco.';
}

function attivita(nome: string): string {
  if (nome.endsWith('__leggi_documento')) return 'Sto leggendo un documento della pratica…';
  if (nome.endsWith('__elenca_documenti')) return 'Sto guardando i documenti della pratica…';
  if (nome.endsWith('__cerca_nei_documenti')) return 'Sto cercando nei documenti della pratica…';
  if (nome.endsWith('__estrai_date')) return 'Sto ricostruendo le date della pratica…';
  if (nome.endsWith('__leggi_memoria_pratica')) return 'Sto ripassando gli appunti sulla pratica…';
  if (nome.endsWith('__crea_bozza')) return 'Sto preparando la bozza…';
  return 'Sto lavorando…';
}

/** La storia della conversazione come testo, quando la sessione di Claude non c'è più. */
export function promptConStoria(storia: MessaggioProiettato[], testo: string): string {
  const precedenti = storia.filter((m) => m.testo.trim()).slice(-20);
  if (!precedenti.length) return testo;
  const righe = precedenti.map((m) => `${m.ruolo === 'avvocato' ? 'AVVOCATO' : 'ASSISTENTE'}: ${m.testo}`);
  return `Conversazione finora (per contesto):\n\n${righe.join('\n\n')}\n\n---\n\nNuova domanda dell'avvocato:\n${testo}`;
}

export class MotoreServer implements Motore {
  private readonly sessioni = new Map<string, string>();
  private readonly interruzioni = new Map<string, AbortController>();

  constructor(private readonly o: OpzioniMotoreServer) {}

  ferma(conversazioneId: string): void {
    this.interruzioni.get(conversazioneId)?.abort();
  }

  async esegui(r: RichiestaMotore, emetti: (e: EventoMotore) => void): Promise<void> {
    const abort = new AbortController();
    this.interruzioni.set(r.conversazioneId, abort);
    // La sessione dell'host può venire dal desktop (non vale qui): solo le nostre.
    const resume = this.sessioni.get(r.conversazioneId);
    // L'ultimo messaggio dell'avvocato è già nella storia: si tolgono i messaggi
    // da quello in poi.
    const storia = this.o.storia(r.conversazioneId);
    const ultimo = storia.map((m) => m.ruolo).lastIndexOf('avvocato');
    const prompt = resume ? r.testo : promptConStoria(ultimo >= 0 ? storia.slice(0, ultimo) : storia, r.testo);
    const fonti = this.o.fonti(r.praticaId, r.documenti);
    const qualita = r.qualita;
    const opzioni: Options = {
      model: qualita === 'Massima' ? 'claude-opus-5-5' : 'claude-sonnet-5',
      effort: qualita === 'Massima' ? 'high' : 'medium',
      maxBudgetUsd: TETTO_USD[qualita],
      systemPrompt: `${PROMPT_LEGALE_SERVER}\nOggi è ${new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`,
      tools: [],
      mcpServers: {
        'jarai-documenti': creaServerDocumentiRemoti(fonti),
        'jarai-bozze': creaServerBozzeRemote((b) => emetti({ tipo: 'bozza', ...b })),
      },
      allowedTools: STRUMENTI_REMOTI,
      settingSources: [],
      includePartialMessages: true,
      maxTurns: Math.min(300, 20 + fonti.documenti.length * 3),
      resume,
      abortController: abort,
      cwd: this.o.cartellaSessioni,
      pathToClaudeCodeExecutable: this.o.eseguibile,
      env: {
        PATH: process.env.PATH,
        HOME: this.o.cartellaSessioni,
        CLAUDE_CONFIG_DIR: this.o.cartellaSessioni,
        ANTHROPIC_BASE_URL: this.o.proxy,
        ANTHROPIC_API_KEY: this.o.licenza,
        ANTHROPIC_CUSTOM_HEADERS: `X-Question-Id: ${randomUUID()}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    };
    try {
      for await (const m of (this.o.interroga ?? query)({ prompt, options: opzioni })) {
        if (m.type === 'stream_event') {
          const ev = m.event;
          if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') emetti({ tipo: 'attivita', testo: attivita(ev.content_block.name) });
          else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') emetti({ tipo: 'delta', testo: ev.delta.text });
        } else if (m.type === 'result') {
          this.sessioni.set(r.conversazioneId, m.session_id);
          if (m.subtype === 'success' && !m.is_error) emetti({ tipo: 'completato', testo: m.result, costoUsd: m.total_cost_usd });
          else {
            const grezzo = m.subtype === 'success' ? m.result : m.subtype;
            this.o.registraErrore?.('risultato', grezzo);
            emetti({ tipo: 'errore', messaggio: messaggioErrore(grezzo), ...(m.subtype === 'success' ? { scartaParziale: true } : {}) });
          }
        }
      }
    } catch (err) {
      const testo = err instanceof Error ? err.message : String(err);
      this.o.registraErrore?.('eccezione', testo);
      emetti({ tipo: 'errore', messaggio: messaggioErrore(testo) });
    } finally {
      this.interruzioni.delete(r.conversazioneId);
    }
  }
}
