// afterPack di electron-builder: blocca la build se nell'app impacchettata
// manca un binario nativo indispensabile, invece di scoprirlo sul PC dello
// studio ("Serve un componente aggiuntivo" in Impostazioni).
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const OBBLIGATORI = {
  win32: [
    ['@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'],
    ['@napi-rs', 'canvas-win32-x64-msvc', 'skia.win32-x64-msvc.node'],
  ],
  darwin: [['@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude']],
};

exports.default = async function verificaPacchetto(context) {
  const piattaforma = context.electronPlatformName;
  const risorse =
    piattaforma === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources');
  const base = join(risorse, 'app.asar.unpacked', 'node_modules');
  const mancanti = (OBBLIGATORI[piattaforma] ?? []).map((p) => join(base, ...p)).filter((f) => !existsSync(f));
  if (mancanti.length > 0) {
    throw new Error(`Binari nativi mancanti nell'app impacchettata:\n${mancanti.join('\n')}\nPer Windows: npm run prepara:win`);
  }
};
