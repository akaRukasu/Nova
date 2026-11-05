// Bibliothèque : historique, likes, playlists, réglages. Gardée sur le disque (écriture regroupée)
// et synchronisée avec le compte YouTube (likes, playlists) quand on est connecté.
import type {
  Collection, LibraryState, Settings, SmartPlaylist, SmartRule, Track, UserPlaylist,
} from '../../shared/types';
import { defaultSettings } from '../../shared/types';
import { api } from './api';
import { Store } from './store';

export const library = new Store<LibraryState>({
  recents: [], liked: [], playlists: [], smartPlaylists: [], saved: [], searches: [], stats: {}, settings: defaultSettings,
});
export const account = new Store<{ signedIn: boolean; name?: string; photo?: string; playlists: Collection[] }>({
  signedIn: false, playlists: [],
});
export const toast = new Store<string | null>(null);

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void api.saveLibrary(library.get()), 1500);
}

function update(change: (state: LibraryState) => LibraryState) {
  library.set(change);
  persist();
}

export function notify(message: string) {
  toast.set(message);
  setTimeout(() => { if (toast.get() === message) toast.set(null); }, 3000);
}

export async function loadLibrary() {
  library.set(await api.loadLibrary());
  applyTheme(library.get().settings.theme);
  await refreshAccount();
}

export async function refreshAccount() {
  const info = await api.account().catch(() => ({ signedIn: false }));
  account.set({ ...info, playlists: account.get().playlists });
  if (!info.signedIn) return;
  // Likes du compte (les mêmes que sur l'iPhone) fusionnés avec ceux de Nova.
  const [liked, playlists] = await Promise.all([
    api.accountLiked().catch(() => [] as Track[]),
    api.accountPlaylists().catch(() => [] as Collection[]),
  ]);
  account.set((current) => ({ ...current, playlists }));
  if (liked.length) {
    update((state) => {
      const known = new Set(liked.map((t) => t.id));
      return { ...state, liked: [...liked, ...state.liked.filter((t) => !known.has(t.id))] };
    });
  }
}

export function applyTheme(theme: Settings['theme']) {
  document.documentElement.dataset.theme = theme;
}

export function updateSettings(change: Partial<Settings>) {
  update((state) => ({ ...state, settings: { ...state.settings, ...change } }));
  const settings = library.get().settings;
  applyTheme(settings.theme);
  void api.applySettings(settings);
}

// MARK: Écoutes

export function recordPlay(track: Track) {
  update((state) => {
    const stats = { ...state.stats, [track.id]: { playCount: (state.stats[track.id]?.playCount ?? 0) + 1, lastPlayed: Date.now() } };
    if (!state.settings.recordHistory) return { ...state, stats };
    const recents = [track, ...state.recents.filter((t) => t.id !== track.id)].slice(0, 1000);
    return { ...state, stats, recents };
  });
}

export function removeRecent(id: string) {
  update((state) => ({ ...state, recents: state.recents.filter((t) => t.id !== id) }));
}

export function clearRecents() {
  update((state) => ({ ...state, recents: [] }));
}

export function addSearch(query: string) {
  const text = query.trim();
  if (!text) return;
  update((state) => ({
    ...state,
    searches: [text, ...state.searches.filter((s) => s.toLowerCase() !== text.toLowerCase())].slice(0, 30),
  }));
}

export function clearSearches() {
  update((state) => ({ ...state, searches: [] }));
}

/** Pochette carrée retrouvée : appliquée partout dans la bibliothèque. */
export function updateArtwork(id: string, artwork: string) {
  const patch = (tracks: Track[]) => tracks.map((t) => (t.id === id ? { ...t, artwork, square: true } : t));
  update((state) => ({
    ...state,
    recents: patch(state.recents),
    liked: patch(state.liked),
    playlists: state.playlists.map((p) => (p.tracks.some((t) => t.id === id) ? { ...p, tracks: patch(p.tracks) } : p)),
  }));
}

// MARK: Likes

export const isLiked = (id: string) => library.get().liked.some((t) => t.id === id);

export function toggleLike(track: Track) {
  const liked = !isLiked(track.id);
  update((state) => ({
    ...state,
    liked: liked ? [track, ...state.liked] : state.liked.filter((t) => t.id !== track.id),
  }));
  if (account.get().signedIn) void api.setLike(track.id, liked).catch(() => notify('Le like n’a pas pu être envoyé à YouTube.'));
  return liked;
}

// MARK: Playlists

export function createPlaylist(name: string, tracks: Track[] = []): UserPlaylist {
  const playlist: UserPlaylist = { id: crypto.randomUUID(), name: name.trim() || 'Nouvelle playlist', tracks: dedupe(tracks), created: Date.now() };
  update((state) => ({ ...state, playlists: [playlist, ...state.playlists] }));
  // Compte connecté : la playlist existe aussi sur YouTube (et donc sur l'iPhone).
  if (account.get().signedIn) {
    void api.createAccountPlaylist(playlist.name, playlist.tracks.map((t) => t.id)).then((youtubeId) => {
      if (youtubeId) update((state) => ({ ...state, playlists: state.playlists.map((p) => (p.id === playlist.id ? { ...p, youtubeId } : p)) }));
    }).catch(() => undefined);
  }
  return playlist;
}

/** Même nom qu'une playlist existante : elle est remplacée (réimport sans doublon). */
export function upsertPlaylist(name: string, tracks: Track[], youtubeId?: string): UserPlaylist {
  const existing = library.get().playlists.find((p) => p.name.toLowerCase() === name.toLowerCase());
  const playlist: UserPlaylist = { id: existing?.id ?? crypto.randomUUID(), name, tracks: dedupe(tracks), created: Date.now(),
    youtubeId: youtubeId ?? existing?.youtubeId };
  update((state) => ({ ...state, playlists: [playlist, ...state.playlists.filter((p) => p.id !== playlist.id)] }));
  return playlist;
}

export function addToPlaylist(id: string, tracks: Track[]) {
  const playlist = library.get().playlists.find((p) => p.id === id);
  if (!playlist) return;
  const known = new Set(playlist.tracks.map((t) => t.id));
  const fresh = tracks.filter((t) => !known.has(t.id));
  update((state) => ({ ...state, playlists: state.playlists.map((p) => (p.id === id ? { ...p, tracks: [...p.tracks, ...fresh] } : p)) }));
  if (playlist.youtubeId && fresh.length && account.get().signedIn) {
    void api.addToAccountPlaylist(playlist.youtubeId, fresh.map((t) => t.id)).catch(() => undefined);
  }
  notify(fresh.length ? `Ajouté à « ${playlist.name} »` : 'Déjà dans la playlist');
}

export function removeFromPlaylist(id: string, trackId: string) {
  update((state) => ({ ...state, playlists: state.playlists.map((p) => (p.id === id ? { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) } : p)) }));
}

export function renamePlaylist(id: string, name: string) {
  update((state) => ({ ...state, playlists: state.playlists.map((p) => (p.id === id ? { ...p, name } : p)) }));
}

export function deletePlaylist(id: string) {
  update((state) => ({ ...state, playlists: state.playlists.filter((p) => p.id !== id) }));
}

export function moveInPlaylist(id: string, from: number, to: number) {
  update((state) => ({
    ...state,
    playlists: state.playlists.map((p) => {
      if (p.id !== id) return p;
      const tracks = [...p.tracks];
      const [moved] = tracks.splice(from, 1);
      tracks.splice(to, 0, moved);
      return { ...p, tracks };
    }),
  }));
}

// MARK: Albums, playlists et artistes enregistrés

export const isSaved = (id: string) => library.get().saved.some((c) => c.id === id);

export function toggleSaved(collection: Collection) {
  const saved = !isSaved(collection.id);
  update((state) => ({ ...state, saved: saved ? [collection, ...state.saved] : state.saved.filter((c) => c.id !== collection.id) }));
  notify(saved ? `« ${collection.title} » ajouté à la bibliothèque` : `« ${collection.title} » retiré de la bibliothèque`);
}

// MARK: Playlists intelligentes

export function saveSmartPlaylist(playlist: SmartPlaylist) {
  update((state) => {
    const list = state.smartPlaylists ?? [];
    const exists = list.some((p) => p.id === playlist.id);
    return { ...state, smartPlaylists: exists ? list.map((p) => (p.id === playlist.id ? playlist : p)) : [playlist, ...list] };
  });
}

export function deleteSmartPlaylist(id: string) {
  update((state) => ({ ...state, smartPlaylists: (state.smartPlaylists ?? []).filter((p) => p.id !== id) }));
}

function ruleMatches(rule: SmartRule, track: Track, state: LibraryState): boolean {
  const stats = state.stats[track.id];
  const value = rule.value.trim().toLowerCase();
  const textOf = (field: string) => (field === 'title' ? track.title : field === 'artist' ? track.artist : track.album ?? '').toLowerCase();
  switch (rule.field) {
    case 'title': case 'artist': case 'album': {
      const text = textOf(rule.field);
      if (rule.operator === 'contains') return text.includes(value);
      if (rule.operator === 'is') return text === value;
      if (rule.operator === 'not') return !text.includes(value);
      return false;
    }
    case 'playCount': {
      const count = stats?.playCount ?? 0, target = Number(value) || 0;
      return rule.operator === 'greater' ? count > target : rule.operator === 'less' ? count < target : count === target;
    }
    case 'lastPlayed': {
      const days = (Date.now() - (stats?.lastPlayed ?? 0)) / 86_400_000, target = Number(value) || 0;
      return rule.operator === 'inLast' ? days <= target : days > target;
    }
    case 'liked': {
      const liked = state.liked.some((t) => t.id === track.id);
      return rule.operator === 'not' ? !liked : liked;
    }
  }
}

export function smartTracks(playlist: SmartPlaylist, state = library.get()): Track[] {
  const pool = dedupe([...state.liked, ...state.playlists.flatMap((p) => p.tracks), ...state.recents]);
  let result = pool.filter((track) => {
    const results = playlist.rules.map((rule) => ruleMatches(rule, track, state));
    return playlist.matchAll ? results.every(Boolean) : results.some(Boolean);
  });
  const stats = state.stats;
  if (playlist.sort === 'mostPlayed') result.sort((a, b) => (stats[b.id]?.playCount ?? 0) - (stats[a.id]?.playCount ?? 0));
  else if (playlist.sort === 'recent') result.sort((a, b) => (stats[b.id]?.lastPlayed ?? 0) - (stats[a.id]?.lastPlayed ?? 0));
  else if (playlist.sort === 'title') result.sort((a, b) => a.title.localeCompare(b.title, 'fr'));
  else result = shuffle(result);
  return playlist.limit ? result.slice(0, playlist.limit) : result;
}

// MARK: Morceaux (sans doublons)

export function dedupeKey(track: Track) {
  const clean = (v: string) => v.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  return `${clean(track.title)}|${clean(track.artist.split(/,|&| et /)[0] ?? '')}`;
}

export function dedupe(tracks: Track[]): Track[] {
  const ids = new Set<string>(), keys = new Set<string>();
  return tracks.filter((t) => {
    const key = dedupeKey(t);
    if (ids.has(t.id) || keys.has(key)) return false;
    ids.add(t.id);
    keys.add(key);
    return true;
  });
}

let songsCache: { source: unknown; liked: unknown; songs: Track[] } | null = null;
/** Tous les morceaux (likés et playlists), sans doublons, triés par titre. Recalculé seulement si besoin. */
export function songs(state = library.get()): Track[] {
  if (songsCache && songsCache.source === state.playlists && songsCache.liked === state.liked) return songsCache.songs;
  const result = dedupe([...state.liked, ...state.playlists.flatMap((p) => p.tracks)])
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'));
  songsCache = { source: state.playlists, liked: state.liked, songs: result };
  return result;
}

export function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
