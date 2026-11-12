import { isAndroid } from './api';
import { library, mergeHistory } from './library';
import { listeningHistory, type HistorySnapshot } from '../../shared/historySync';
import { Store } from './store';

type Pairing = { host: string; port: number; token: string; name: string };
function savedPairing(): Pairing | undefined {
  try { return JSON.parse(localStorage.getItem('nova-pc-history') ?? 'null') ?? undefined; } catch { return undefined; }
}
let paired = savedPairing();
let working = false;
let started = false;
let changed: ReturnType<typeof setTimeout> | undefined;
export const pcHistory = new Store<{ name?: string; syncing: boolean; lastSync?: number; error?: string }>({
  name: paired?.name, syncing: false,
});

export async function syncPCHistory() {
  if (!isAndroid || !paired || working) return;
  const target = paired;
  working = true;
  pcHistory.set(state => ({ ...state, syncing: true, error: undefined }));
  try {
    const outgoing = listeningHistory(library.get());
    const remote = await window.nova.invoke<HistorySnapshot>('phone:exchange-history',
      target.host, target.port, target.token, JSON.stringify(outgoing));
    if (paired !== target) return;
    if (remote?.version !== 1 || !Array.isArray(remote.entries)) throw new Error('Mets Nova à jour sur le PC pour synchroniser l’historique.');
    mergeHistory(remote);
    pcHistory.set({ name: target.name, syncing: false, lastSync: Date.now() });
  } catch (error) {
    if (paired === target) pcHistory.set(state => ({ ...state, syncing: false,
      error: error instanceof Error ? error.message : 'Synchronisation indisponible.' }));
  } finally { working = false; }
}

export async function pairPCHistory(link: string) {
  let uri: URL, endpoint: URL;
  try {
    uri = new URL(link.trim());
    endpoint = new URL(uri.searchParams.get('u') ?? '');
  } catch { throw new Error('Colle le lien d’association copié dans Nova sur ton PC.'); }
  const token = uri.searchParams.get('t') ?? '';
  if (uri.protocol !== 'nova:' || uri.hostname !== 'sync' || endpoint.protocol !== 'http:'
    || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(endpoint.hostname) || endpoint.pathname !== '/sync'
    || endpoint.username || endpoint.password || !/^[a-f0-9]{32}$/.test(token)) {
    throw new Error('Ce lien d’association Nova est invalide.');
  }
  paired = { host: endpoint.hostname, port: Number(endpoint.port || 80), token, name: uri.searchParams.get('n') || 'PC' };
  localStorage.setItem('nova-pc-history', JSON.stringify(paired));
  pcHistory.set({ name: paired.name, syncing: false });
  await syncPCHistory();
}

export function unpairPCHistory() {
  paired = undefined;
  localStorage.removeItem('nova-pc-history');
  pcHistory.set({ syncing: false });
}

export function startPCHistory() {
  if (started || !isAndroid) return;
  started = true;
  let last = JSON.stringify(listeningHistory(library.get()));
  library.subscribe(() => {
    const next = JSON.stringify(listeningHistory(library.get()));
    if (next === last) return;
    last = next;
    clearTimeout(changed);
    changed = setTimeout(() => void syncPCHistory(), 5000);
  });
  setInterval(() => { if (!document.hidden) void syncPCHistory(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncPCHistory(); });
  void syncPCHistory();
}
