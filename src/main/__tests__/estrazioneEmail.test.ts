import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const cartella = mkdtempSync(join(tmpdir(), 'jarai-eml-'));

vi.mock('electron', () => ({ app: { getPath: () => cartella } }));
const ocr = vi.fn(async () => ({ data: { text: 'TARGA AB123CD' } }));
vi.mock('tesseract.js', () => ({ default: { recognize: ocr } }));

const { estraiTesto, immaginiDelDocumento } = await import('../estrazioneTesto');

function b64(buf: Buffer): string {
  return buf.toString('base64').replace(/.{76}/g, '$&\r\n');
}

async function leggi(nome: string, contenuto: string): Promise<string> {
  const percorso = join(cartella, nome);
  writeFileSync(percorso, contenuto.replace(/\r?\n/g, '\r\n'));
  return estraiTesto({ nome, percorso, cartella: 'Cartella principale', tipo: 'eml' }, () => {}, () => {});
}

// Finta foto: abbastanza grande da non essere scambiata per un logo.
const foto = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60_000, 7)]);

describe('lettura dei file .eml', () => {
  it('estrae intestazioni, corpo, foto allegate (OCR) ed email inoltrate, senza base64', async () => {
    ocr.mockClear();
    const testo = await leggi(
      'Fwd_ Ruggiero.eml',
      `From: Rachele Natale <rachele@example.com>
To: Avv. Molfino <molfino@example.com>
Date: Thu, 05 Nov 2026 10:30:00 +0100
Subject: =?UTF-8?Q?Fwd:_Ruggiero_Marco_=E2=80=93_maneggio?=
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="ESTERNO"

--ESTERNO
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: quoted-printable

Buongiorno Avvocato, le inoltro le foto della caduta al maneggio.=0AGrazie

--ESTERNO
Content-Type: image/jpeg; name="IMG_5615.JPG"
Content-Disposition: attachment; filename="IMG_5615.JPG"
Content-Transfer-Encoding: base64

${b64(foto)}
--ESTERNO
Content-Type: message/rfc822; name="Originale.eml"
Content-Disposition: attachment; filename="Originale.eml"

From: Marco Ruggiero <marco@example.com>
To: Rachele Natale <rachele@example.com>
Subject: Diffida
Content-Type: text/plain; charset=UTF-8

Vi diffido dal pretendere ulteriori somme.

--ESTERNO
Content-Type: application/pkcs7-signature; name="smime.p7s"
Content-Disposition: attachment; filename="smime.p7s"
Content-Transfer-Encoding: base64

AAAA
--ESTERNO--
`,
    );
    expect(testo).toContain('Da: Rachele Natale <rachele@example.com>');
    expect(testo).toContain('A: Avv. Molfino <molfino@example.com>');
    expect(testo).toContain('Data: 05/11/26, 10:30');
    expect(testo).toContain('Oggetto: Fwd: Ruggiero Marco – maneggio');
    expect(testo).toContain('le inoltro le foto della caduta al maneggio.\nGrazie');
    expect(testo).toContain('[Allegato 1 di 2: IMG_5615.JPG — immagine, qui solo il testo da OCR]\nTARGA AB123CD');
    expect(testo).toContain('[Allegato 2 di 2: Originale.eml — email allegata]');
    expect(testo).toContain('Da: Marco Ruggiero <marco@example.com>');
    expect(testo).toContain('Vi diffido dal pretendere ulteriori somme.');
    expect(testo).not.toContain('smime.p7s');
    expect(testo.length).toBeLessThan(2_000);
    expect(ocr).toHaveBeenCalledTimes(1);
  });

  it('legge la postacert.eml di una PEC con i suoi allegati', async () => {
    const atto = Buffer.from('ATTO DI CITAZIONE\nIl sig. Ruggiero conviene in giudizio il maneggio.');
    const testo = await leggi(
      'PEC controparte.eml',
      `From: "Per conto di: avv.rossi@pec.it" <posta-certificata@pec.aruba.it>
To: studio@pec.it
Subject: POSTA CERTIFICATA: Notifica atto
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="PEC"

--PEC
Content-Type: text/plain; charset=UTF-8

Messaggio di posta certificata. Il giorno 14/07/2026 alle ore 10:00 il messaggio è stato inviato.

--PEC
Content-Type: application/xml; name="daticert.xml"
Content-Disposition: attachment; filename="daticert.xml"

<postacert/>
--PEC
Content-Type: message/rfc822
Content-Disposition: inline; filename="postacert.eml"

From: avv.rossi@pec.it
To: studio@pec.it
Subject: Notifica atto
Content-Type: multipart/mixed; boundary="INTERNO"

--INTERNO
Content-Type: text/plain; charset=UTF-8

Si notifica l'atto allegato.

--INTERNO
Content-Type: text/plain; name="Atto.txt"
Content-Disposition: attachment; filename="Atto.txt"
Content-Transfer-Encoding: base64

${b64(atto)}
--INTERNO--

--PEC--
`,
    );
    expect(testo).toContain('Il giorno 14/07/2026');
    expect(testo).toContain('[Allegato 1 di 2: daticert.xml]\n(formato non leggibile automaticamente)');
    expect(testo).toContain('[Allegato 2 di 2: postacert.eml — email allegata]');
    expect(testo).toContain("Si notifica l'atto allegato.");
    expect(testo).toContain('[Allegato 1 di 1: Atto.txt]\nATTO DI CITAZIONE');
  });

  it('converte il corpo solo HTML e salta i loghi incorporati', async () => {
    ocr.mockClear();
    const testo = await leggi(
      'Solo html.eml',
      `From: a@example.com
Subject: Prova
MIME-Version: 1.0
Content-Type: multipart/related; boundary="REL"

--REL
Content-Type: text/html; charset=UTF-8

<html><head><style>p{color:red}</style></head><body><p>Primo &amp; secondo</p><p>Terzo<br>quarto</p><img src="cid:logo"></body></html>
--REL
Content-Type: image/png
Content-ID: <logo>
Content-Disposition: inline
Content-Transfer-Encoding: base64

iVBORw0KGgo=
--REL--
`,
    );
    expect(testo).toContain('Primo & secondo\nTerzo\nquarto');
    expect(testo).not.toContain('color:red');
    expect(testo).toContain('immagini incorporate piccole');
    expect(ocr).not.toHaveBeenCalled();
  });
});

describe('foto da guardare', () => {
  it('raccoglie le foto allegate, anche dentro le email inoltrate, senza i loghi', async () => {
    const nome = 'Con foto.eml';
    const percorso = join(cartella, nome);
    writeFileSync(
      percorso,
      `From: a@example.com
Subject: Foto
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="A"

--A
Content-Type: text/plain

Ecco le foto.
--A
Content-Type: image/jpeg; name="IMG_5657.JPG"
Content-Disposition: attachment; filename="IMG_5657.JPG"
Content-Transfer-Encoding: base64

${b64(foto)}
--A
Content-Type: image/png
Content-ID: <logo>
Content-Disposition: inline
Content-Transfer-Encoding: base64

iVBORw0KGgo=
--A
Content-Type: message/rfc822
Content-Disposition: attachment; filename="Inoltro.eml"

From: b@example.com
Subject: Originale
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="B"

--B
Content-Type: text/plain

Foto della caduta.
--B
Content-Type: image/jpeg; name="IMG_5658.JPG"
Content-Disposition: attachment; filename="IMG_5658.JPG"
Content-Transfer-Encoding: base64

${b64(foto)}
--B--
--A--
`.replace(/\r?\n/g, '\r\n'),
    );
    const immagini = await immaginiDelDocumento({ nome, percorso, cartella: 'Cartella principale', tipo: 'eml' });
    expect(immagini.map((i) => i.nome)).toEqual(['IMG_5657.JPG', 'Inoltro.eml › IMG_5658.JPG']);
    expect(immagini[1].contenuto.equals(foto)).toBe(true);
  });

  it('per un file immagine restituisce il file stesso, per un PDF nessuna foto', async () => {
    const percorso = join(cartella, 'IMG_1.jpg');
    writeFileSync(percorso, foto);
    expect(await immaginiDelDocumento({ nome: 'IMG_1.jpg', percorso, cartella: 'x', tipo: 'jpg' })).toHaveLength(1);
    expect(await immaginiDelDocumento({ nome: 'Atto.pdf', percorso, cartella: 'x', tipo: 'pdf' })).toEqual([]);
  });
});
