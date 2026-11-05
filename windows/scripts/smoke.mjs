// Test de démarrage : lance Nova (Electron) et vérifie que l'interface s'affiche, avec ou sans bibliothèque.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electronPath from 'electron';

// NOVA_EXE : l'application empaquetée (Nova.exe) ; sinon Electron avec le dossier courant.
const packaged = process.env.NOVA_EXE;
const exe = packaged ?? (typeof electronPath === 'string' ? electronPath : electronPath.default);
let failures = 0;

async function run(title, library) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'nova-smoke-'));
  if (library) {
    await fs.mkdir(path.join(profile, 'Nova'), { recursive: true });
    await fs.writeFile(path.join(profile, 'Nova', 'library.json'), JSON.stringify(library));
  }
  const app = await electron.launch({ executablePath: exe, args: [...(packaged ? [] : ['.']), `--user-data-dir=${path.join(profile, 'Nova')}`], env: { ...process.env, APPDATA: profile } });
  const logs = [];
  app.process().stderr?.on('data', (d) => logs.push(String(d).trim()));
  const window = await app.firstWindow();
  window.on('console', (m) => m.type() === 'error' && logs.push(`console: ${m.text()}`));
  window.on('pageerror', (e) => logs.push(`pageerror: ${e.stack ?? e.message}`));
  let shown = false;
  for (let i = 0; i < 40 && !shown; i++) {
    shown = await window.evaluate(() => !!document.querySelector('.sidebar, .crash')).catch(() => false);
    if (!shown) await new Promise((r) => setTimeout(r, 500));
  }
  const crash = await window.evaluate(() => document.querySelector('.crash')?.textContent ?? '').catch(() => '');
  await window.screenshot({ path: `smoke-${packaged ? 'exe-' : ''}${title}.png` }).catch(() => undefined);
  console.log(`\n=== ${title} : ${shown && !crash ? 'interface affichée' : 'ÉCHEC'}`);
  if (crash) console.log(crash);
  console.log(logs.filter((l) => !/fetch failed|ENOTFOUND|dbus/i.test(l)).slice(0, 30).join('\n'));
  if (!shown || crash) failures++;
  await app.close().catch(() => undefined);
}

const track = (id, title) => ({ id, title, artist: 'Artiste', album: 'Album', duration: 200, artwork: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` });
await run('vide');
await run('bibliotheque', {
  recents: [track('a1', 'Un'), track('a2', 'Deux')], liked: [track('a3', 'Trois')], added: [track('a4', 'Quatre')],
  playlists: [{ id: 'p1', name: 'Rap FR', tracks: [track('a1', 'Un')], created: Date.now() }],
  shared: [{ id: 'PL1', title: 'Soirée', isOwner: true }], saved: [{ id: 'UC1', kind: 'artist', title: 'Artiste' }],
  searches: ['daft punk'], stats: { a1: { playCount: 3, lastPlayed: Date.now() } },
  settings: { theme: 'dark' },
});
process.exit(failures ? 1 : 0);
