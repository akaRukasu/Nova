// Déchiffrement des liens audio (PC) : l'extrait du lecteur de YouTube tourne dans un bac à sable
// Node (sans accès aux fichiers ni au réseau), avec une limite de temps.
import vm from 'node:vm';
import { Platform } from 'youtubei.js';

Platform.shim.eval = (data, env) => {
  const args = [env.n, env.sp, env.sig].map((value) => JSON.stringify(value ?? ''));
  const code = `${data.output}\nprocess(${args.join(', ')});`;
  return vm.runInNewContext(code, { URL, URLSearchParams }, { timeout: 4000 }) as Record<string, unknown>;
};
