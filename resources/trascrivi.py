#!/usr/bin/env python3
"""Trascrive un file audio in italiano con faster-whisper (spec §6.2, Fase 3).

Processo esterno spawnato da src/main/trascrizione.ts, sullo stesso schema
del CLI "claude" già usato per il login (src/main/claudeLogin.ts): niente
libreria Python impacchettata dentro JarAI, va installata a parte sul
computer dello studio ("pip install faster-whisper").

Contratto con il chiamante Node: un solo argomento (il percorso del file
audio), un solo oggetto JSON su stdout in caso di successo, niente altro —
messaggi di log, warning e barre di avanzamento di faster-whisper vanno già
su stderr per conto loro. In caso di errore: uscita diversa da zero, con un
messaggio comprensibile su stderr.

L'avanzamento va su stderr come righe "@@JARAI {json}" (fase, durata,
progresso 0..1): il chiamante le riconosce dal prefisso e ignora il resto.
"""

import json
import sys


def avanzamento(**dati) -> None:
    print("@@JARAI " + json.dumps(dati), file=sys.stderr, flush=True)

# Modello 'medium': buon compromesso qualità/velocità su CPU per l'italiano
# (confrontato con 'small' e 'large-v3' su audio reale di prova). 'large-v3'
# è leggermente più preciso ma quasi il doppio più lento — da valutare come
# opzione se la velocità non è un problema per lo studio.
MODELLO = "medium"


def main() -> int:
    if len(sys.argv) != 2:
        print("Uso: trascrivi.py <percorso-audio>", file=sys.stderr)
        return 2

    percorso_audio = sys.argv[1]

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster_whisper non installato", file=sys.stderr)
        return 3

    try:
        # Al primo uso WhisperModel scarica il modello (~1,5 GB): è la fase
        # più lunga in assoluto, va segnalata a parte dalla trascrizione.
        avanzamento(fase="modello")
        model = WhisperModel(MODELLO, device="cpu", compute_type="int8")
        segments, info = model.transcribe(percorso_audio, language="it", beam_size=5)
        durata = info.duration or 0
        avanzamento(fase="trascrizione", durata=durata)
        # `segments` è un generatore: la trascrizione vera avviene qui,
        # segmento per segmento — da qui il progresso reale.
        parti = []
        for s in segments:
            parti.append(s.text.strip())
            if durata > 0:
                avanzamento(progresso=min(s.end / durata, 1.0))
        testo = " ".join(parti)
    except Exception as err:  # noqa: BLE001 — qualsiasi errore diventa un messaggio leggibile
        print(f"errore trascrizione: {err}", file=sys.stderr)
        return 1

    print(json.dumps({"text": testo}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
