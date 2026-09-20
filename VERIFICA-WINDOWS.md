# Verifica installer Windows di JarAI

## 1. Controlla il file che hai lanciato

Il file giusto (ultima build) si chiama **`jarai Setup 0.1.0.exe`** e pesa circa **270 MB**.

Se il file che hai sul PC Windows è più piccolo (~185 MB o meno), oppure ha un
altro nome (es. `jarai 0.1.0.exe` senza "Setup"), è una versione precedente:
va sostituito con l'ultima build, ancora da trasferire da questo Mac.

## 2. Controlla cosa è stato davvero installato

Apri PowerShell sul PC Windows e incolla:

```powershell
m
```

**Atteso se l'installazione è corretta** — deve comparire una cartella:
z
```
claude-agent-sdk-win32-x64
```

(dentro c'è un file `claude.exe` da circa 230 MB)

**Se il comando non restituisce nulla, dà errore, o mostra solo
`claude-agent-sdk-darwin-arm64`** — l'app installata è quella vecchia. In
quel caso:

1. Disinstalla JarAI da "App e funzionalità" di Windows
2. Cancella (se esiste ancora) la cartella:
   ```powershell
   Remove-Item "$env:LOCALAPPDATA\Programs\jarai." -Recurse -Force -ErrorAction SilentlyContinue
   ```
3. Chiedi il file `jarai Setup 0.1.0.exe` più recente e reinstalla da zero

## Nota

Se anche con il file giusto la cartella `claude-agent-sdk-win32-x64` non
compare, allora il problema è reale e va corretto lato build — non un file
vecchio. A quel punto serve lo screenshot dell'errore preciso mostrato da
JarAI per continuare a correggerlo.
