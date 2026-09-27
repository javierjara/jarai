# Ricerca giuridica in JarAI — fonti di sentenze e integrazione

_Nota di ricerca, 27 settembre 2026._

Sì, si possono aggiungere le sentenze a JarAI, e ci sono diverse banche dati. Però solo alcune si possono scaricare liberamente e in blocco: è questo che decide cosa è fattibile subito.

## Fonti pubbliche gratuite

| Fonte | Cosa contiene | Si può scaricare tutto? |
|---|---|---|
| **[Corte costituzionale – Open Data](https://dati.cortecostituzionale.it/)** | Circa 20.000 pronunce dal 1956 a oggi | **Sì**: XML, JSON e CSV con licenza CC BY-SA 3.0. È la fonte più facile. |
| **[SentenzeWeb – Cassazione](https://www.italgiure.giustizia.it/sncass/)** | Sentenze civili e penali dell'anno in corso e dei 5 anni precedenti, testo integrale, senza registrazione | **Non ufficialmente**: c'è solo la ricerca web, non un'API né uno scarico in blocco. Prima di raccoglierle in automatico bisogna verificare le condizioni d'uso. |
| **[Banca Dati di Merito Pubblica](https://pst.giustizia.it/PST/page/it/operativa_la_banca_dati_pubblica__la_giurisprudenza_di_merito_al_servizio_del_cittadino?contentId=NWS3007)** (Ministero della Giustizia) | Sentenze civili di Tribunali e Corti d'Appello dal 2016, con i dati personali oscurati, esclusi famiglia e minori | **Solo con accordo**: l'accesso è con SPID/CIE, e lo scarico in blocco il Ministero l'ha concesso agli editori con una [convenzione con l'AIE](https://www.giustizia.it/giustizia/page/it/convenzione_accordo_protocollo_selezionato?contentId=SCA1441419) (gennaio 2025). |
| **Giustizia amministrativa** (TAR e Consiglio di Stato) e **Corte dei conti** | Pronunce consultabili sui loro siti | Da verificare fonte per fonte |
| **Corti europee**: EUR-Lex/CURIA (Corte di giustizia UE) e HUDOC (CEDU) | Giurisprudenza europea | Sì, hanno accesso programmatico |

C'è anche un dataset non ufficiale, [giurisprudenza-db](https://github.com/Synthos-Logic/giurisprudenza-db), con licenza CC BY 4.0: Consulta, massime della Cassazione e alcune sentenze di merito. Utile per fare prototipi, ma per un prodotto meglio usare le fonti ufficiali.

## Banche dati commerciali

Le grandi sono **DeJure** (Giuffrè), **OneLegale / Leggi d'Italia** (Wolters Kluwer), **Pluris** e **Foro Italiano**. Hanno le massime redazionali, le note e il merito completo, ma per usarle serve un accordo di licenza. Le massime scritte dagli editori sono protette dal diritto d'autore, e le raccolte sono protette come banche dati, quindi non si possono copiare. Alcuni editori hanno anche un loro assistente IA, quindi potrebbero essere sia possibili partner sia concorrenti.

## Come inserirlo in JarAI

1. **Un indice di ricerca sul proxy JarAI, non sul PC dell'avvocato.** I dati sono pubblici, quindi non tocca la promessa che i fascicoli restano nello studio. Bisogna però dire chiaramente che le domande di ricerca passano dal proxy.
2. **Uno strumento di ricerca per il modello**, chiamato per esempio `cerca_giurisprudenza`. Restituisce estremi, estratto e link alla fonte ufficiale, e il modello può citare **solo** ciò che lo strumento ha trovato, mai sentenze "a memoria". È la funzione più preziosa per un avvocato: nel 2025 il Tribunale di Firenze si è già occupato di un atto con citazioni inventate da un'IA. Le citazioni verificabili sarebbero un ottimo argomento di vendita.
3. **In quest'ordine:**
   - Corte costituzionale e Corti europee, perché sono aperte e scaricabili subito.
   - Poi la Cassazione, dopo aver verificato le condizioni di SentenzeWeb o chiesto al CED della Cassazione.
   - Poi il merito tramite un accordo con il Ministero, o una partnership con un editore.
4. **Le sentenze dello studio.** JarAI legge già i PDF nelle pratiche. Le sentenze che l'avvocato ha salvato nelle sue cartelle funzionano già così.

## Da far verificare a un legale

- Le condizioni di riuso di ogni fonte (D.lgs. 36/2006 sul riuso dei dati pubblici).
- L'oscuramento dei dati personali (art. 52 del Codice privacy) se si indicizzano fonti non già oscurate.
- Il "share-alike" della licenza della Consulta (CC BY-SA 3.0) se si ridistribuiscono i dati.

## Prossimo passo proposto

Prototipo con gli open data della Corte costituzionale: scarico, indice di ricerca nel proxy e strumento di citazione in JarAI.

## Fonti

- [Corte costituzionale – Open Data](https://dati.cortecostituzionale.it/)
- [Corte costituzionale – pagina Open Data](https://www.cortecostituzionale.it/contenuti/rapporti-cittadini/open-data)
- [SentenzeWeb – Italgiure](https://www.italgiure.giustizia.it/sncass/)
- [Italia ius – Cassazione, ultimi cinque anni online](https://italiaius.it/novita-normative/corte-di-cassazione-sentenze-civili-degli-ultimi-cinque-anni-on-line-e-liberamente-consultabili-per-tutti)
- [PST Giustizia – Banca dati pubblica di merito](https://pst.giustizia.it/PST/page/it/operativa_la_banca_dati_pubblica__la_giurisprudenza_di_merito_al_servizio_del_cittadino?contentId=NWS3007)
- [Agenda Digitale – Banca dati di merito pubblica](https://www.agendadigitale.eu/documenti/giustizia-digitale/banca-dati-di-merito-pubblica-che-cose-e-come-funziona/)
- [Ministero della Giustizia – Convenzione con AIE](https://www.giustizia.it/giustizia/page/it/convenzione_accordo_protocollo_selezionato?contentId=SCA1441419)
- [Studio Agostini Kasapoglu – Ecosistema dei dati giuridici italiani e IA](https://www.studioagostinikasapoglu.com/it/insights/italian-legal-data-ecosystem-artificial-intelligence/)
- [GitHub – giurisprudenza-db](https://github.com/Synthos-Logic/giurisprudenza-db)
