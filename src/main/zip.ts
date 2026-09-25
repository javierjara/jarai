import { createWriteStream, promises as fs } from 'node:fs';
import { dirname, resolve as risolviPercorso, sep } from 'node:path';
import yauzl from 'yauzl';

// Estrae ogni voce dello zip dentro destDir, ricreando le sottocartelle —
// lo stesso risultato di un doppio clic sull'archivio in Finder/Esplora
// risorse. Ogni percorso viene ricondotto sotto destDir prima di scrivere
// (protezione da zip "zip-slip" con voci tipo "../../altrove"): una voce che
// uscirebbe dalla cartella di destinazione viene scartata invece di scritta
// altrove.
//
// Condivisa tra l'importazione delle pratiche (pratiche.ts, un fascicolo
// zippato dal tribunale o dalla controparte) e l'installazione del Python
// privato per la trascrizione audio (pythonRuntime.ts, il pacchetto
// "embeddable" di python.org) — stessa esigenza, stesso codice.
export function estraiZip(percorsoZip: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(percorsoZip, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error('Zip non leggibile.'));
        return;
      }
      zipfile.on('error', reject);
      const destDirResolved = risolviPercorso(destDir);
      zipfile.on('entry', (entry: yauzl.Entry) => {
        const destPath = risolviPercorso(destDir, entry.fileName);
        if (destPath !== destDirResolved && !destPath.startsWith(destDirResolved + sep)) {
          zipfile.readEntry();
          return;
        }
        if (/\/$/.test(entry.fileName)) {
          fs.mkdir(destPath, { recursive: true })
            .then(() => zipfile.readEntry())
            .catch(reject);
          return;
        }
        zipfile.openReadStream(entry, (err2, readStream) => {
          if (err2 || !readStream) {
            reject(err2 ?? new Error('Voce dello zip non leggibile.'));
            return;
          }
          fs.mkdir(dirname(destPath), { recursive: true })
            .then(() => {
              const writeStream = createWriteStream(destPath);
              readStream.pipe(writeStream);
              writeStream.on('finish', () => zipfile.readEntry());
              writeStream.on('error', reject);
            })
            .catch(reject);
        });
      });
      zipfile.on('end', () => resolve());
      zipfile.readEntry();
    });
  });
}
