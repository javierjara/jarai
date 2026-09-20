import { useEffect, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import ConversazioneView from './components/ConversazioneView';
import StoricoView from './components/StoricoView';
import PraticheView from './components/PraticheView';
import Settings from './components/Settings';
import { AVVOCATO_NOME, CONVERSAZIONI, DOCUMENTI, PRATICHE, STUDIO_NOME } from './data/datiIniziali';
import { AMBITI } from './types';
import type { Conversazione, Documento, FileImportato, MainView, Pratica, StatoPersistito, Studio } from './types';

export default function App() {
  const [pratiche, setPratiche] = useState<Pratica[]>(PRATICHE);
  const [conversazioni, setConversazioni] = useState<Conversazione[]>(CONVERSAZIONI);
  const [documenti, setDocumenti] = useState<Record<string, Documento[]>>(DOCUMENTI);
  const [studio, setStudio] = useState<Studio>({ nome: STUDIO_NOME, avvocato: AVVOCATO_NOME });
  const [currentView, setCurrentView] = useState<MainView>('home');
  const [activeConversazioneId, setActiveConversazioneId] = useState<string | null>(null);
  const [pendingPraticaId, setPendingPraticaId] = useState<string | null>(null);
  const [selectedPraticaId, setSelectedPraticaId] = useState<string | null>(null);
  const [homeKey, setHomeKey] = useState(0);
  const [pronto, setPronto] = useState(false);

  // Persistenza locale (spec §8, in attesa di SQLite — Fase 5): al primo
  // avvio carica quanto salvato in precedenza; se non c'è nulla (primo
  // avvio in assoluto) restano i dati d'esempio già nello stato iniziale.
  useEffect(() => {
    window.jarai.dati.carica().then((salvato) => {
      const stato = salvato as StatoPersistito | null;
      if (stato) {
        setPratiche(stato.pratiche);
        setConversazioni(stato.conversazioni);
        setDocumenti(stato.documenti);
        if (stato.studio) setStudio(stato.studio);
        // "Cartella non trovata" (spec §5.3): controllo leggero all'avvio per
        // ogni pratica legata a una cartella — rinominata o spostata dopo
        // l'ultima apertura di JarAI, per esempio.
        const percorsi = stato.pratiche.map((p) => p.cartellaPercorso).filter((p): p is string => !!p);
        if (percorsi.length > 0) {
          window.jarai.verificaCartelle(percorsi).then((trovate) => {
            setPratiche((prev) => prev.map((p) => (p.cartellaPercorso ? { ...p, cartellaTrovata: trovate[p.cartellaPercorso] ?? false } : p)));
          });
        }
      }
      setPronto(true);
    });
  }, []);

  // Salva su disco a ogni cambiamento, con un piccolo debounce per non
  // scrivere il file a ogni singolo tasto premuto (es. mentre si scrivono le
  // istruzioni di una pratica).
  const salvaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!pronto) return;
    if (salvaTimer.current) clearTimeout(salvaTimer.current);
    salvaTimer.current = setTimeout(() => {
      void window.jarai.dati.salva({ pratiche, documenti, conversazioni, studio });
    }, 500);
    return () => {
      if (salvaTimer.current) clearTimeout(salvaTimer.current);
    };
  }, [pronto, pratiche, documenti, conversazioni, studio]);

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
    setConversazioni((prev) => prev.filter((c) => c.id !== id));
    if (activeConversazioneId === id) {
      setActiveConversazioneId(null);
      setHomeKey((k) => k + 1);
    }
  }

  function salvaConversazione(c: Conversazione) {
    setConversazioni((prev) => {
      const idx = prev.findIndex((x) => x.id === c.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = c;
        return next;
      }
      return [c, ...prev];
    });
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
    setPratiche((prev) => prev.filter((p) => p.id !== id));
    setConversazioni((prev) => prev.filter((c) => c.praticaId !== id));
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
            conversazione={activeConversazione}
            documenti={documenti}
            onSalva={salvaConversazione}
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
      case 'impostazioni':
        return <Settings studio={studio} onSalvaStudio={setStudio} />;
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
      />
      <main className="main-area">{renderView()}</main>
    </div>
  );
}
