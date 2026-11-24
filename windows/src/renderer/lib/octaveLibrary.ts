import type { Collection, Track } from '../../shared/types';
import { octaveCatalogId } from '../../shared/octave';
import { api, on, supportsOctave } from './api';
import { Store } from './store';

type Addition = { key: string; track?: Track; album?: Collection; octaveDone?: boolean; youtubeDone?: boolean };
type Status = { connected: boolean; pending: boolean; tracks: number; albums: number; artists: number; updatedAt: number };
export const octaveLibrary = new Store<{ busy: boolean; pending: number; youtubePending: number; status?: Status; error?: string }>({ busy: false, pending: 0, youtubePending: 0 });
const storage = 'novaOctaveLibraryOutbox';
let outbox: Addition[] = [];
try { outbox = JSON.parse(localStorage.getItem(storage) ?? '[]').filter((item: Addition) => item?.key && (item.track || item.album)); } catch {}
let work: Promise<void> | undefined;
let youtubeWork: Promise<void> | undefined;
let started = false;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const call = <T,>(args: object) => window.nova.invoke<T>('octave:library', args);
const pendingCounts = () => ({ pending: outbox.filter(item => !item.octaveDone).length, youtubePending: outbox.filter(item => !item.youtubeDone).length });
const persist = () => {
  outbox = outbox.filter(item => !item.octaveDone || !item.youtubeDone);
  localStorage.setItem(storage, JSON.stringify(outbox));
  octaveLibrary.set(state => ({ ...state, ...pendingCounts() }));
};

export function syncYouTubeAdditions() {
  if (youtubeWork || !outbox.some(item => !item.youtubeDone)) return youtubeWork;
  youtubeWork = (async () => {
    const account = await api.account().catch(() => undefined);
    if (!account?.signedIn) return;
    for (const item of outbox.filter(value => !value.youtubeDone).slice(0, 20)) {
      try {
        if (item.track) {
          const track = await api.youtubeRecording(item.track);
          if (!track || !/^[\w-]{11}$/.test(track.id)) continue;
          if (!outbox.includes(item)) continue;
          await api.setLike(track.id, true);
        } else if (item.album) {
          const tracks = item.album.id.startsWith('MPREb') ? [] : (await api.collection(item.album)).tracks.slice(0, 3);
          if (!outbox.includes(item)) continue;
          await api.saveYouTubeAlbum(item.album, tracks);
        }
        item.youtubeDone = true;
        persist();
      } catch { /* L’ajout reste en attente pour ce compte. */ }
    }
  })().finally(() => { youtubeWork = undefined; });
  return youtubeWork;
}

async function run(operation: 'refresh' | 'add', args = {}): Promise<Status> {
  let start: { job?: number } | null = null;
  for (let attempt = 0; attempt < 30 && !start?.job; attempt++) {
    start = await call({ operation, ...args });
    if (!start?.job) await wait(300);
  }
  if (!start?.job) throw new Error('Ouvre Compte Octave pour connecter la bibliothèque.');
  for (let attempt = 0; attempt < 180; attempt++) {
    await wait(200);
    const result = await call<{ running?: boolean; value?: Status; error?: string }>({ operation: 'result', job: start.job });
    if (!result || result.running) continue;
    if (result.error || !result.value) throw new Error(result.error || 'Bibliothèque Octave indisponible.');
    return result.value;
  }
  throw new Error('Octave n’a pas encore confirmé la synchronisation. Les ajouts sont conservés.');
}

export function refreshOctaveLibrary(): Promise<void> {
  void syncYouTubeAdditions();
  if (work) return work;
  work = (async () => {
    octaveLibrary.set(state => ({ ...state, busy: true, error: undefined, ...pendingCounts() }));
    try {
      let status = await run('refresh');
      const tracks: Track[] = [];
      for (let offset = 0; offset < status.tracks; offset += 300) {
        const page = await call<{ tracks: Track[] }>({ operation: 'page', offset });
        if (page?.tracks) tracks.push(...page.tracks);
      }
      await window.nova.invoke('octave:library-index', status.connected ? tracks : []);
      for (const item of outbox.filter(value => !value.octaveDone).slice(0, 20)) {
        if (!status.connected || !outbox.includes(item)) break;
        if (item.track) {
          const recording = await api.octaveMatch(item.track);
          if (!recording) throw new Error('Ajout conservé : « ' + item.track.title + ' » doit encore être identifié dans Octave.');
          status = await run('add', { tracks: [recording] });
        } else if (item.album) {
          let id = octaveCatalogId(item.album.id) ? item.album.id : undefined;
          if (!id) {
            const page = await api.collection(item.album);
            const recording = page.tracks[0] && await api.octaveMatch(page.tracks[0]);
            const norm = (text: string) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
            if (recording?.albumId && norm(recording.album ?? '') === norm(item.album.title)) id = recording.albumId;
          }
          if (!id) throw new Error('Ajout conservé : cet album doit encore être identifié dans Octave.');
          status = await run('add', { albums: [id] });
        }
        if (status.pending) break; // Le SDK garde ses limites et ses conflits ; réessayer plus tard.
        item.octaveDone = true;
        persist();
      }
      octaveLibrary.set({ busy: false, ...pendingCounts(), status });
    } catch (error) {
      octaveLibrary.set(state => ({ ...state, busy: false, ...pendingCounts(), error: error instanceof Error ? error.message : String(error) }));
    }
  })().finally(() => { work = undefined; });
  return work;
}

export function queueOctaveAddition(track?: Track, album?: Collection) {
  if (!supportsOctave || track?.id.startsWith('local:') || (album && album.kind !== 'album')) return;
  const key = track ? 'track:' + track.id : 'album:' + album?.id;
  if (!outbox.some(item => item.key === key)) { outbox.push({ key, track, album }); persist(); }
  void refreshOctaveLibrary();
}

export function cancelLibraryAddition(track?: Track, album?: Collection) {
  const key = track ? 'track:' + track.id : 'album:' + album?.id;
  outbox = outbox.filter(item => item.key !== key);
  persist();
}

export function startOctaveLibrary() {
  if (started || !supportsOctave) return;
  started = true;
  void refreshOctaveLibrary();
  on('octave:connected', () => void refreshOctaveLibrary());
  setInterval(() => { if (outbox.length && !document.hidden) void refreshOctaveLibrary(); }, 30000);
}
