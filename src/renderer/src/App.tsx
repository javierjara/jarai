import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import ConversazioneView from './components/ConversazioneView';
import StoricoView from './components/StoricoView';
import PraticheView from './components/PraticheView';
import Settings from './components/Settings';
import StudioDigitaleView from './components/StudioDigitaleView';
import { PREFERENZE_SITO_DEFAULT, useStudioDigitale } from './components/studio/useStudioDigitale';
import { AVVOCATO_NOME, DOCUMENTI, PRATICHE, STUDIO_NOME } from './data/datiIniziali';
import { caricaEntita, comando, useElenco } from './host';
import { differenze, type StatoEntita } from './sincronizza';
import { AMBITI, PROCEDURE } from './types';
import type { RiepilogoConversazione } from '../../shared/reducer';
import type { Conversazione, ConversazioneSito, Documento, FileImportato, Idea, MainView, Pratica, PreferenzeSito, StatoPersistito, Studio } from './types';

export default function App() {
  const [pratiche, setPratiche] = useState<Pratica[]>(PRATICHE);
  // Le conversazioni delle pratiche le possiede l'host (jarai.db): qui solo
  // l'elenco, aggiornato dagli eventi.
  const elenco = useElenco();
  const conversazioni = useMemo(
    () =>
      Object.values(elenco.conversazioni)
        .filter((r) => r.modalita === 'pratica')
        .map(daRiepilogo)
        .sort((a, b) => b.aggiornataIl.localeCompare(a.aggiornataIl)),
    [elenco],
  );
  const [documenti, setDocumenti] = useState<Record<string, Documento[]>>(DOCUMENTI);
  const [studio, setStudio] = useState<Studio>({ nome: STUDIO_NOME, avvocato: AVVOCATO_NOME });
  const [currentView, setCurrentView] = useState<MainView>('home');
  const [activeConversazioneId, setActiveConversazioneId] = useState<string | null>(null);
  const [pendingPraticaId, setPendingPraticaId] = useState<string | null>(null);
  const [selectedPraticaId, setSelectedPraticaId] = useState<string | null>(null);
  const [homeKey, setHomeKey] = useState(0);
  const [pronto, setPronto] = useState(false);
  const [aggiornamentoDisponibile, setAggiornamentoDisponibile] = useState(false);
  const [studioDigitale, setStudioDigitale] = useState<ConversazioneSito[]>([]);
  // Funzioni aggiuntive attivate dal CRM sulla licenza (es. Studio digitale).
  const [funzioni, setFunzioni] = useState<string[]>([]);
  const conStudioDigitale = funzioni.includes('studio_digitale');
  const [ideeSito, setIdeeSito] = useState<Idea[]>([]);
  const [preferenzeSito, setPreferenzeSito] = useState<PreferenzeSito>(PREFERENZE_SITO_DEFAULT);
  // Risposte dell'assistente, idee e pubblicazioni programmate:
  // gestite qui per non perderle fuori dalla sezione Studio digitale.
  const studioDigitaleApi = useStudioDigitale({
    attivo: pronto && conStudioDigitale,
    setConversazioni: setStudioDigitale,
    setIdee: setIdeeSito,
    setPreferenze: setPreferenzeSito,
  });

  // All'avvio, e ogni volta che si esce dalle Impostazioni: lì si può aver
  // appena attivato o cambiato la licenza.
  useEffect(() => {
    if (currentView === 'impostazioni') return;
    void window.jarai.funzioni.attive(true).then(setFunzioni);
  }, [currentView]);

  // Avviso aggiornamento (spec §12): un solo controllo silenzioso, con un
  // piccolo ritardo per non competere con l'avvio dell'app — chiedere "c'è
  // una versione più recente?" non tocca nulla sul PC dello studio, a
  // differenza di scaricarla o installarla, che restano sempre un gesto
  // esplicito dell'avvocato in Impostazioni (mai un controllo ripetuto da
  // solo). Il pallino sparisce da sé al riavvio su una versione aggiornata:
  // lo stato è solo in memoria, non c'è nulla da "pulire" esplicitamente.
  useEffect(() => {
    const timer = setTimeout(() => void window.jarai.aggiornamenti.controlla(), 4000);
    const rimuoviListener = window.jarai.aggiornamenti.onEvento((evento) => {
      if (evento.tipo === 'disponibile' || evento.tipo === 'scaricato') {
        setAggiornamentoDisponibile(true);
      } else if (evento.tipo === 'non-disponibile' || evento.tipo === 'errore') {
        setAggiornamentoDisponibile(false);
      }
    });
    return () => {
      clearTimeout(timer);
      rimuoviListener();
    };
  }, []);

  // Dati dello studio (passo 5): all'avvio arrivano dall'host (jarai.db).
  // Se la migrazione dal vecchio JSON non è riuscita, l'host risponde null e
  // si resta sul JSON come prima: l'app non si apre mai vuota per questo.
  const conJsonRef = useRef(false);
  // Ultimo stato che l'host conosce: il salvataggio manda solo le differenze.
  const salvatoRef = useRef<StatoEntita | null>(null);
  useEffect(() => {
    void (async () => {
      const entita = await caricaEntita();
      conJsonRef.current = entita === null;
      const salvato = (entita ?? (await window.jarai.dati.carica())) as StatoPersistito | null;
      if (salvato) {
        const iniziale: StatoEntita = {
          // cartellaTrovata non si salva più: si ricalcola qui sotto.
          pratiche: salvato.pratiche.map((p) => ({ ...p, cartellaTrovata: p.cartellaTrovata ?? true })),
          documenti: salvato.documenti,
          studio: salvato.studio ?? { nome: STUDIO_NOME, avvocato: AVVOCATO_NOME },
          studioDigitale: salvato.studioDigitale ?? [],
          ideeSito: salvato.ideeSito ?? [],
          preferenzeSito: salvato.preferenzeSito ?? PREFERENZE_SITO_DEFAULT,
        };
        setPratiche(iniziale.pratiche);
        setDocumenti(iniziale.documenti);
        setStudio(iniziale.studio);
        setStudioDigitale(iniziale.studioDigitale);
        setIdeeSito(iniziale.ideeSito);
        setPreferenzeSito(iniziale.preferenzeSito);
        salvatoRef.current = iniziale;
        // "Cartella non trovata" (spec §5.3): controllo leggero all'avvio per
        // ogni pratica legata a una cartella — rinominata o spostata dopo
        // l'ultima apertura di JarAI, per esempio.
        const percorsi = iniziale.pratiche.map((p) => p.cartellaPercorso).filter((p): p is string => !!p);
        if (percorsi.length > 0) {
          window.jarai.verificaCartelle(percorsi).then((trovate) => {
            setPratiche((prev) => prev.map((p) => (p.cartellaPercorso ? { ...p, cartellaTrovata: trovate[p.cartellaPercorso] ?? false } : p)));
          });
        }
      }
      setPronto(true);
    })();
  }, []);

  // Salvataggio a ogni cambiamento, con un piccolo debounce per non scrivere
  // a ogni tasto premuto (es. mentre si scrivono le note di una pratica).
  // Le conversazioni non passano di qui: stanno nell'host.
  const salvaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const daSalvare: StatoEntita = { pratiche, documenti, studio, studioDigitale, ideeSito, preferenzeSito };
  const daSalvareRef = useRef(daSalvare);
  daSalvareRef.current = daSalvare;
  // Un salvataggio alla volta, in ordine: i comandi di uno non si mescolano
  // con quelli del successivo.
  const codaSalvataggi = useRef<Promise<void>>(Promise.resolve());
  const salva = useCallback((): Promise<void> => {
    codaSalvataggi.current = codaSalvataggi.current.then(async () => {
      const dopo = daSalvareRef.current;
      if (conJsonRef.current) {
        await window.jarai.dati.salva(dopo);
        return;
      }
      const prima = salvatoRef.current;
      if (!prima) return;
      salvatoRef.current = dopo;
      for (const c of differenze(prima, dopo)) {
        const esito = await comando(c);
        if (!esito.ok) {
          // Al prossimo salvataggio si riprova tutto da dove si era.
          salvatoRef.current = prima;
          console.error('[salvataggio]', c.tipo, esito.errore);
          return;
        }
      }
    });
    return codaSalvataggi.current;
  }, []);

  useEffect(() => {
    if (!pronto) return;
    if (salvaTimer.current) clearTimeout(salvaTimer.current);
    salvaTimer.current = setTimeout(() => void salva(), 500);
    return () => {
      if (salvaTimer.current) clearTimeout(salvaTimer.current);
    };
  }, [pronto, salva, pratiche, documenti, studio, studioDigitale, ideeSito, preferenzeSito]);

  // Prima di mandare una domanda: l'host deve già conoscere pratica e
  // documenti appena aggiunti.
  const salvaOra = useCallback(async () => {
    if (!pronto) return;
    if (salvaTimer.current) clearTimeout(salvaTimer.current);
    await salva();
  }, [pronto, salva]);

  const activeConversazione = conversazioni.find((c) => c.id === activeConversazioneId) ?? null;

  function navigate(view: MainView) {
    if (view === 'home') {
      setActiveConversazioneId(null);
      setPendingPraticaId(null);
      setHomeKey((k) => k + 1);
    }
    setCurrentView(view);
  }

  function apriConversazione(c: Conversazione) {
    setActiveConversazioneId(c.id);
    setCurrentView('home');
  }

  function nuovaConversazione(praticaId: string) {
    setActiveConversazioneId(null);
    setPendingPraticaId(praticaId);
    setHomeKey((k) => k + 1);
    setCurrentView('home');
  }

  function eliminaConversazione(id: string) {
    void comando({ tipo: 'conversazione.elimina', argomenti: { conversazioneId: id } });
    if (activeConversazioneId === id) {
      setActiveConversazioneId(null);
      setHomeKey((k) => k + 1);
    }
  }

  // Fase 3 (spec §5.3): la pratica nasce già legata 1:1 alla cartella scelta
  // dall'avvocato — non più un nome slegato da un'importazione successiva.
  // Tutti i file trovati sono per forza nuovi (pratica appena creata), niente
  // passaggio dal modale di conferma duplicati.
  function aggiungiPraticaDaCartella(cartellaPercorso: string, cartellaNome: string, file: FileImportato[]) {
    // Id generato con crypto.randomUUID(), mai da un contatore in memoria: un
    // contatore riparte da zero a ogni riavvio dell'app, mentre le pratiche
    // restano salvate — due pratiche create in sessioni diverse finivano con
    // lo stesso id (bug reale, corretto insieme a questa modifica).
    const id = crypto.randomUUID();
    const nuova: Pratica = {
      id,
      nome: cartellaNome,
      cliente: 'Da definire',
      ambito: AMBITI[Math.floor(Math.random() * AMBITI.length)],
      documenti: file.length,
      aggiornataIl: new Date().toISOString(),
      cartellaPercorso,
      cartellaTrovata: true,
    };
    const documentiIniziali: Documento[] = file.map((f) => ({
      id: crypto.randomUUID(),
      nome: f.nome,
      tipo: f.estensione,
      data: f.modificatoIl,
      cartella: f.cartella,
      dimensione: f.dimensione,
      percorso: f.percorso,
    }));
    setPratiche((prev) => [nuova, ...prev]);
    setDocumenti((prev) => ({ ...prev, [id]: documentiIniziali }));
    setSelectedPraticaId(id);
  }

  // Ricollega una pratica a una cartella ritrovata (spec §5.3, "Trova di
  // nuovo" dopo che l'originale è stata rinominata o spostata): aggiorna il
  // percorso e rilegge subito il contenuto, come un normale aggiornamento.
  function ricollegaCartella(praticaId: string, cartellaPercorso: string) {
    setPratiche((prev) => prev.map((p) => (p.id === praticaId ? { ...p, cartellaPercorso, cartellaTrovata: true } : p)));
  }

  function segnalaCartellaNonTrovata(praticaId: string) {
    setPratiche((prev) => prev.map((p) => (p.id === praticaId ? { ...p, cartellaTrovata: false } : p)));
  }

  function rinominaPratica(id: string, nome: string) {
    setPratiche((prev) => prev.map((p) => (p.id === id ? { ...p, nome } : p)));
  }

  function eliminaPratica(id: string) {
    void window.jarai.eliminaMemoria(id);
    setPratiche((prev) => prev.filter((p) => p.id !== id));
    for (const c of conversazioni) {
      if (c.praticaId === id) void comando({ tipo: 'conversazione.elimina', argomenti: { conversazioneId: c.id } });
    }
    setDocumenti((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSelectedPraticaId((prev) => (prev === id ? null : prev));
  }

  // Un file già presente (stesso nome) viene aggiornato sul posto — percorso,
  // cartella e dimensione possono essere cambiati da un "Aggiorna dalla
  // cartella" o da un "Trova di nuovo" dopo uno spostamento — mai duplicato
  // con un secondo id.
  function importaDocumenti(praticaId: string, nuovi: Documento[]) {
    if (nuovi.length === 0) return;
    let conteggioAggiornato = 0;
    setDocumenti((prev) => {
      const esistenti = prev[praticaId] ?? [];
      const risultato = [...esistenti];
      for (const doc of nuovi) {
        const idx = risultato.findIndex((d) => d.nome.toLowerCase() === doc.nome.toLowerCase());
        if (idx >= 0) {
          risultato[idx] = { ...risultato[idx], ...doc, id: risultato[idx].id };
        } else {
          risultato.unshift(doc);
        }
      }
      conteggioAggiornato = risultato.length;
      return { ...prev, [praticaId]: risultato };
    });
    setPratiche((prev) =>
      prev.map((p) => (p.id === praticaId ? { ...p, documenti: conteggioAggiornato, aggiornataIl: new Date().toISOString() } : p)),
    );
  }

  function eliminaDocumento(praticaId: string, docId: string) {
    setDocumenti((prev) => ({ ...prev, [praticaId]: (prev[praticaId] ?? []).filter((d) => d.id !== docId) }));
    setPratiche((prev) => prev.map((p) => (p.id === praticaId ? { ...p, documenti: Math.max(0, p.documenti - 1) } : p)));
  }

  function renderView() {
    switch (currentView) {
      case 'home':
        return (
          <ConversazioneView
            key={activeConversazione?.id ?? `nuova-${homeKey}`}
            pratiche={pratiche}
            praticaId={activeConversazione?.praticaId ?? pendingPraticaId}
            conversazioneId={activeConversazione?.id ?? null}
            documenti={documenti}
            onPrimaDiInviare={salvaOra}
          />
        );
      case 'storico':
        return (
          <StoricoView
            conversazioni={conversazioni}
            pratiche={pratiche}
            onOpen={apriConversazione}
            onDelete={eliminaConversazione}
          />
        );
      case 'pratiche':
        return (
          <PraticheView
            pratiche={pratiche}
            conversazioni={conversazioni}
            documenti={documenti}
            selectedId={selectedPraticaId}
            onSelect={setSelectedPraticaId}
            onChiedi={nuovaConversazione}
            onAddPraticaDaCartella={aggiungiPraticaDaCartella}
            onRicollegaCartella={ricollegaCartella}
            onCartellaNonTrovata={segnalaCartellaNonTrovata}
            onRenamePratica={rinominaPratica}
            onDeletePratica={eliminaPratica}
            onImportaDocumenti={importaDocumenti}
            onDeleteDocumento={eliminaDocumento}
          />
        );
      case 'studio-digitale':
        return conStudioDigitale ? (
          <StudioDigitaleView
            conversazioni={studioDigitale}
            setConversazioni={setStudioDigitale}
            idee={ideeSito}
            setIdee={setIdeeSito}
            preferenze={preferenzeSito}
            setPreferenze={setPreferenzeSito}
            api={studioDigitaleApi}
            nomeStudio={studio.nome}
            onVaiImpostazioni={() => navigate('impostazioni')}
          />
        ) : null;
      case 'impostazioni':
        return <Settings studio={studio} onSalvaStudio={setStudio} conStudioDigitale={conStudioDigitale} />;
    }
  }

  if (!pronto) return <div className="app-shell" style={{ background: 'var(--paper)' }} />;

  return (
    <div className="app-shell">
      <Sidebar
        currentView={currentView}
        onNavigate={navigate}
        studio={studio}
        pratiche={pratiche}
        conversazioni={conversazioni}
        onOpenConversazione={apriConversazione}
        onNuovaConversazione={nuovaConversazione}
        onDeleteConversazione={eliminaConversazione}
        aggiornamentoDisponibile={aggiornamentoDisponibile}
        conStudioDigitale={conStudioDigitale}
      />
      <main className="main-area">{renderView()}</main>
    </div>
  );
}

// Le viste (sidebar, storico, pratiche) usano ancora il tipo Conversazione:
// l'elenco ne dà solo i campi che servono, i messaggi restano nell'host.
function daRiepilogo(r: RiepilogoConversazione): Conversazione {
  return {
    id: r.id,
    praticaId: r.praticaId ?? 'senza-pratica',
    titolo: r.titolo || 'Nuova conversazione',
    procedura: r.procedura ?? PROCEDURE[0],
    stato: r.stato,
    aggiornataIl: r.aggiornataIl,
    dispositivoOrigine: r.creataDa && r.creataDa !== 'desktop' ? 'telefono' : 'desktop',
    ...(r.attivita ? { attivitaCorrente: r.attivita } : {}),
    messaggi: [],
  };
}
