import { describe, expect, it } from 'vitest';
import { cifra, decifra, derivaChiavi, esportaPrivata, generaCoppia, importaPrivata, pubblicaDaPrivata } from '../cifratura';

describe('cifratura end-to-end', () => {
  it('desktop e telefono ricavano le stesse chiavi e si leggono a vicenda', async () => {
    const desktop = await generaCoppia();
    const telefono = await generaCoppia();
    const sale = 'host-1:telefono-1';
    const latoDesktop = await derivaChiavi(desktop.privata, telefono.pubblica, sale);
    const latoTelefono = await derivaChiavi(telefono.privata, desktop.pubblica, sale);

    const dalTelefono = await cifra(latoTelefono.versoDesktop, '{"tipo":"comando"}');
    expect(await decifra(latoDesktop.versoDesktop, dalTelefono)).toBe('{"tipo":"comando"}');
    const dalDesktop = await cifra(latoDesktop.versoTelefono, 'risposta àèì €');
    expect(await decifra(latoTelefono.versoTelefono, dalDesktop)).toBe('risposta àèì €');
  });

  it('le due direzioni hanno chiavi diverse (un messaggio non si può rimandare indietro)', async () => {
    const a = await generaCoppia();
    const b = await generaCoppia();
    const k = await derivaChiavi(a.privata, b.pubblica, 's');
    await expect(decifra(k.versoTelefono, await cifra(k.versoDesktop, 'x'))).rejects.toThrow();
  });

  it('un altro telefono, o lo stesso con un altro sale, non legge', async () => {
    const desktop = await generaCoppia();
    const telefono = await generaCoppia();
    const intruso = await generaCoppia();
    const giusto = await derivaChiavi(telefono.privata, desktop.pubblica, 'h:t');
    const messaggio = await cifra(giusto.versoDesktop, 'segreto');
    await expect(decifra((await derivaChiavi(desktop.privata, intruso.pubblica, 'h:t')).versoDesktop, messaggio)).rejects.toThrow();
    await expect(decifra((await derivaChiavi(desktop.privata, telefono.pubblica, 'h:altro')).versoDesktop, messaggio)).rejects.toThrow();
  });

  it('un messaggio alterato dal relay viene rifiutato', async () => {
    const a = await generaCoppia();
    const b = await generaCoppia();
    const k = await derivaChiavi(a.privata, b.pubblica, 's');
    const m = await cifra(k.versoDesktop, 'approva bozza');
    const alterato = m.slice(0, 20) + (m[20] === 'A' ? 'B' : 'A') + m.slice(21);
    await expect(decifra(k.versoDesktop, alterato)).rejects.toThrow();
  });

  it('la chiave privata si conserva e si ritrova, con la sua pubblica', async () => {
    const c = await generaCoppia();
    const jwk = await esportaPrivata(c.privata);
    expect(await pubblicaDaPrivata(jwk)).toBe(c.pubblica);
    const altro = await generaCoppia();
    const prima = await derivaChiavi(c.privata, altro.pubblica, 's');
    const dopo = await derivaChiavi(await importaPrivata(jwk), altro.pubblica, 's');
    expect(await decifra(dopo.versoDesktop, await cifra(prima.versoDesktop, 'ok'))).toBe('ok');
  });
});
