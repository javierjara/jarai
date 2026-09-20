import { spawn } from 'node:child_process';

// Su Windows un'app lanciata facendo doppio clic (come l'exe portable di
// JarAI) eredita il PATH del processo che l'ha avviata (Explorer), che può
// essere più corto o più vecchio di quello che l'avvocato vede aprendo
// PowerShell a mano — specialmente se Claude Code o Python sono stati
// installati dopo l'ultimo accesso, o se Explorer non ha ancora "visto" la
// modifica. `process.env.PATH` dentro JarAI può quindi non contenere la
// cartella giusta anche quando il comando funziona perfettamente in un
// terminale vero.
//
// Questa funzione chiede a Windows stesso, tramite PowerShell, il PATH
// "vero" e permanente (Utente + Macchina, letto dal registro) — lo stesso
// che un nuovo terminale costruirebbe da zero — invece di fidarsi di quello
// (potenzialmente incompleto) ereditato dal processo di JarAI.
let cache: Promise<string> | null = null;

// Su Windows le variabili d'ambiente non distinguono maiuscole/minuscole
// (di solito è "Path", non "PATH"), ma un oggetto JS sì: aggiungere una
// chiave "PATH" a fianco di una "Path" già esistente in process.env lascia
// due chiavi diverse nello stesso oggetto, con un risultato imprevedibile
// una volta passato a spawn(). Questa funzione toglie prima ogni variante
// di maiuscole/minuscole già presente, così ne resta sempre una sola.
export function ambienteConPath(path: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const chiave of Object.keys(env)) {
    if (chiave.toUpperCase() === 'PATH') delete env[chiave];
  }
  env.PATH = path;
  return env;
}

export function pathCompletoWindows(): Promise<string> {
  if (process.platform !== 'win32') return Promise.resolve(process.env.PATH ?? '');
  if (!cache) {
    cache = new Promise((resolve) => {
      const comando = "[Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')";
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', comando]);
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.on('close', () => resolve(out.trim() || process.env.PATH || ''));
      child.on('error', () => resolve(process.env.PATH || ''));
    });
  }
  return cache;
}
