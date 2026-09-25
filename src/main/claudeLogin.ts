import { existsSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { app } from 'electron';
import { cartellaConfigurazioneClaude } from './claudeAuth';
import { ambienteConPath, pathCompletoWindows } from './pathSistema';

// L'SDK (@anthropic-ai/claude-agent-sdk) porta con sé una copia privata
// dell'eseguibile Claude Code, una per piattaforma — la stessa che usa da
// sola per le conversazioni quando non gli si passa `pathToClaudeCodeExecutable`.
// Usare QUESTA per il login invece di cercare "claude" nel PATH di sistema
// evita alla radice ogni problema di PATH incompleto, PowerShell, policy di
// esecuzione o "Claude Code non installato" — non dipende da nulla che
// l'avvocato debba installare a parte.
//
// Nell'app impacchettata il pacchetto sta fuori dall'asar (asarUnpack in
// package.json, obbligatorio: un .exe dentro un archivio non è lanciabile) —
// qui si costruisce quel percorso direttamente, invece di affidarsi a
// `require.resolve()` attraverso il livello di redirection dell'asar, che si
// è rivelato inaffidabile in pratica. In sviluppo (niente asar) si passa
// dalla vecchia cartella node_modules del progetto. Se nessuna delle due
// esiste (pacchetto futuro dell'SDK con struttura diversa), si ripiega sul
// vecchio comportamento: cercare "claude" nel PATH.
// Esportata: serve anche fuori da questo file, per passare esplicitamente
// `pathToClaudeCodeExecutable` all'SDK (agentRunner.ts) quando si inviano i
// messaggi in chat — senza quel parametro l'SDK ricade sulla propria
// auto-detection interna, la stessa che qui si è dimostrata inaffidabile
// dentro l'app impacchettata.
export function percorsoClaudeIntegrato(): string | null {
  const nomePacchetto = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const nomeFile = process.platform === 'win32' ? 'claude.exe' : 'claude';

  // npm mette il pacchetto della piattaforma in due posti diversi a seconda
  // di come lo risolve: in cima a node_modules se è una dipendenza diretta
  // di JarAI (caso di claude-agent-sdk-win32-x64, aggiunta a mano nel nostro
  // package.json), oppure annidato dentro node_modules del pacchetto
  // "claude-agent-sdk" stesso se è solo una sua optionalDependency risolta
  // per la piattaforma corrente (caso di norma per quella della piattaforma
  // su cui giri, es. darwin-arm64 su questo Mac). Vanno controllati entrambi.
  const basi = app.isPackaged
    ? [join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')]
    : [join(app.getAppPath(), 'node_modules')];

  const candidati = basi.flatMap((base) => [
    join(base, nomePacchetto, nomeFile),
    join(base, '@anthropic-ai', 'claude-agent-sdk', 'node_modules', nomePacchetto, nomeFile),
  ]);

  for (const candidato of candidati) {
    if (existsSync(candidato)) return candidato;
  }

  try {
    const richiedi = createRequire(import.meta.url);
    return richiedi.resolve(`${nomePacchetto}/${nomeFile}`);
  } catch {
    return null;
  }
}

// Login ufficiale di Claude Code (`claude auth login`), lo stesso di T3
// Code, ma puntato sulla cartella di configurazione isolata di JarAI
// (spec §3, punto 3). Il comando stampa un link da aprire nel browser e poi
// aspetta un codice da incollare — non c'è un redirect verso localhost, è
// un vero e proprio scambio manuale del codice.
export type ModalitaLogin = 'console' | 'claudeai';

export type EventoLogin =
  | { tipo: 'url'; url: string }
  | { tipo: 'attesa-codice' }
  | { tipo: 'completato' }
  | { tipo: 'errore'; messaggio: string };

let processoAttivo: ChildProcessWithoutNullStreams | null = null;
let avviamentoInCorso = false;

function messaggioErroreLogin(testoGrezzo: string): string {
  // "not found" (macOS/Linux), "CommandNotFoundException" (PowerShell, senza
  // spazio fra "Not" e "Found") e "non riconosciuto" (lo stesso errore ma
  // in italiano, sempre PowerShell) sono lo stesso identico caso: claude non
  // è installato o non è nel PATH.
  if (/enoent|not[\s-]?found|non riconosciuto/i.test(testoGrezzo)) {
    return 'Serve un componente aggiuntivo: installa Claude Code per collegare JarAI.';
  }
  if (/invalid.*code|codice.*non valido|expired/i.test(testoGrezzo)) {
    return 'Il codice inserito non è valido o è scaduto. Riprova l\'accesso.';
  }
  if (/network|econnrefused|enotfound|timeout/i.test(testoGrezzo)) {
    return 'Non riesco a raggiungere Claude. Controlla la connessione e riprova.';
  }
  return 'Accesso non riuscito. Riprova, oppure usa la chiave dello studio qui sopra.';
}

export async function avviaLogin(modalita: ModalitaLogin, onEvento: (evento: EventoLogin) => void): Promise<void> {
  if (processoAttivo || avviamentoInCorso) {
    onEvento({ tipo: 'errore', messaggio: 'Un accesso è già in corso.' });
    return;
  }
  avviamentoInCorso = true;

  // Su Windows un'app avviata con un doppio clic (come JarAI) può ereditare
  // un PATH più corto o più vecchio di quello che l'avvocato vede aprendo
  // PowerShell a mano — da qui "serve Claude Code" anche quando è davvero
  // installato. pathCompletoWindows() chiede il PATH vero a Windows stesso
  // invece di fidarsi di quello ereditato (spec: mai un terminale mostrato
  // all'avvocato, ma internamente possiamo comunque consultare il sistema).
  const path = await pathCompletoWindows();
  avviamentoInCorso = false;
  if (processoAttivo) {
    onEvento({ tipo: 'errore', messaggio: 'Un accesso è già in corso.' });
    return;
  }

  const flag = modalita === 'console' ? '--console' : '--claudeai';
  const eseguibile = percorsoClaudeIntegrato();
  const child = spawn(eseguibile ?? 'claude', ['auth', 'login', flag], {
    env: { ...ambienteConPath(path), CLAUDE_CONFIG_DIR: cartellaConfigurazioneClaude() },
    // Il ripiego su "claude" nudo (eseguibile === null) ha lo stesso identico
    // problema di sempre su Windows: è quasi certamente uno script .cmd/.ps1
    // installato da npm, non un vero .exe — senza `shell: true` Node non lo
    // trova nemmeno se è davvero nel PATH.
    shell: !eseguibile && process.platform === 'win32',
  });
  processoAttivo = child;

  let buffer = '';
  let urlInviato = false;
  let attesaCodiceInviata = false;

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();

    if (!urlInviato) {
      const match = buffer.match(/https:\/\/\S+/);
      if (match) {
        urlInviato = true;
        onEvento({ tipo: 'url', url: match[0] });
      }
    }
    if (!attesaCodiceInviata && /paste code here/i.test(buffer)) {
      attesaCodiceInviata = true;
      onEvento({ tipo: 'attesa-codice' });
    }
  });

  let erroreBuffer = '';
  child.stderr.on('data', (chunk: Buffer) => {
    erroreBuffer += chunk.toString();
  });

  child.on('close', (code) => {
    processoAttivo = null;
    if (code === 0) {
      onEvento({ tipo: 'completato' });
    } else {
      onEvento({ tipo: 'errore', messaggio: messaggioErroreLogin(erroreBuffer || buffer) });
    }
  });

  child.on('error', (err) => {
    processoAttivo = null;
    onEvento({ tipo: 'errore', messaggio: messaggioErroreLogin(err.message) });
  });
}

export function inviaCodiceLogin(codice: string): void {
  processoAttivo?.stdin.write(`${codice.trim()}\n`);
}

export function annullaLogin(): void {
  processoAttivo?.kill();
  processoAttivo = null;
}

// Disconnetti (spec §12, pulsante unico stile T3 Code): revoca la sessione
// dell'account ufficiale, se presente. Va sempre a buon fine dal punto di
// vista di JarAI anche se il comando fallisce (es. nessun account collegato,
// solo la chiave dello studio) — chi chiama rimuove comunque la chiave e lo
// stato salvato subito dopo.
export async function disconnetti(): Promise<void> {
  const path = await pathCompletoWindows();
  const eseguibile = percorsoClaudeIntegrato();
  return new Promise((resolve) => {
    const child = spawn(eseguibile ?? 'claude', ['auth', 'logout'], {
      env: { ...ambienteConPath(path), CLAUDE_CONFIG_DIR: cartellaConfigurazioneClaude() },
      shell: !eseguibile && process.platform === 'win32',
    });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}
