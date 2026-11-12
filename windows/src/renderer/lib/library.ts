// Bibliothèque : historique, likes, playlists, réglages. Gardée sur le disque (écriture regroupée)
// et synchronisée avec le compte YouTube (likes, playlists) quand on est connecté.
import type {
  Collection, LibraryState, Settings, SharedPlaylist, SmartPlaylist, SmartRule, Track, UserPlaylist,
} from '../../shared/types';
import { defaultSettings } from '../../shared/types';
import { isOctaveId, octaveAudioDefaults, type PlaybackSource } from '../../shared/octave';
import { api, on } from './api';
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
  library.set(sanitize(await api.loadLibrary()));
  applyTheme(library.get().settings.theme);
  // Le compte YouTube (likes, playlists) arrive après coup : l'interface s'affiche sans l'attendre,
  // même si YouTube est lent ou ne répond pas.
  void refreshAccount();
}

/** Bibliothèque relue au démarrage : un élément abîmé (synchronisation interrompue…) est écarté au lieu de tout bloquer. */
function sanitize(state: LibraryState): LibraryState {
  const isTrack = (t: any): t is Track => !!t && typeof t.id === 'string' && typeof t.title === 'string';
  const tracks = (list: unknown): Track[] => (Array.isArray(list) ? list.filter(isTrack) : [])
    .map((t) => ({ ...t, artist: typeof t.artist === 'string' ? t.artist : '' }));
  const list = <T,>(value: unknown, keep: (item: any) => boolean): T[] => (Array.isArray(value) ? value.filter(keep) : []);
  return {
    ...state,
    recents: tracks(state.recents),
    liked: tracks(state.liked),
    added: tracks(state.added),
    playlists: list<any>(state.playlists, (p) => p && typeof p.id === 'string')
      .map((p) => ({ ...p, name: typeof p.name === 'string' ? p.name : 'Playlist', tracks: tracks(p.tracks) })),
    smartPlaylists: list(state.smartPlaylists, (p) => p && typeof p.id === 'string' && Array.isArray(p.rules)),
    shared: list(state.shared, (s) => s && typeof s.id === 'string' && typeof s.title === 'string'),
    saved: list(state.saved, (c) => c && typeof c.id === 'string' && typeof c.title === 'string'),
    searches: list(state.searches, (s) => typeof s === 'string'),
    stats: state.stats && typeof state.stats === 'object' ? state.stats : {},
  };
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
  if (change.engine && change.engine !== 'auto') {
    void import('./player').then(({ player }) => player.setMode(change.engine as 'direct' | 'web'));
  }
}

export function playbackOptions(settings: Settings, source?: PlaybackSource) {
  const octave = { ...octaveAudioDefaults, ...settings.octaveAudio };
  return source === 'octave'
    ? { autoplay: octave.autoplay, automix: octave.transition === 'automix' }
    : { autoplay: settings.autoplayRadio, automix: settings.transition === 'automix' };
}

export function togglePlaybackOption(option: 'autoplay' | 'automix', source?: PlaybackSource) {
  const settings = library.get().settings;
  const enabled = !playbackOptions(settings, source)[option];
  if (source === 'octave') {
    const octaveAudio = { ...octaveAudioDefaults, ...settings.octaveAudio };
    if (option === 'autoplay') octaveAudio.autoplay = enabled;
    else octaveAudio.transition = enabled ? 'automix' : 'off';
    updateSettings({ octaveAudio });
  } else {
    updateSettings(option === 'autoplay' ? { autoplayRadio: enabled } : { transition: enabled ? 'automix' : 'off' });
  }
}

// MARK: Écoutes

export function recordPlay(track: Track, playedAt = Date.now()) {
  update((state) => {
    const stats = { ...state.stats, [track.id]: { playCount: (state.stats[track.id]?.playCount ?? 0) + 1, lastPlayed: playedAt } };
    if (!state.settings.recordHistory) return { ...state, stats };
    const recents = [track, ...state.recents.filter((t) => t.id !== track.id)].slice(0, 1000);
    const year = String(new Date(playedAt).getFullYear());
    const recorded = state.listeningYears?.[year];
    const entry = { track, plays: (recorded?.[track.id]?.plays ?? 0) + 1 };
    const listeningYears = { ...state.listeningYears, [year]: { ...recorded, [track.id]: entry } };
    return { ...state, stats, recents, listeningYears };
  });
}

export function removeRecent(id: string) {
  update((state) => ({ ...state, recents: state.recents.filter((t) => t.id !== id) }));
}

export function clearRecents() {
  update((state) => ({ ...state, recents: [], listeningYears: {} }));
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
  if (!isOctaveId(track.id) && account.get().signedIn) void api.setLike(track.id, liked).catch(() => notify('Le like n’a pas pu être envoyé à YouTube.'));
  return liked;
}

// MARK: Playlists

export function createPlaylist(name: string, tracks: Track[] = []): UserPlaylist {
  const playlist: UserPlaylist = { id: crypto.randomUUID(), name: name.trim() || 'Nouvelle playlist', tracks: dedupe(tracks), created: Date.now() };
  update((state) => ({ ...state, playlists: [playlist, ...state.playlists] }));
  // Compte connecté : la playlist existe aussi sur YouTube (et donc sur l'iPhone).
  if (account.get().signedIn && !playlist.tracks.some((track) => isOctaveId(track.id))) {
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

/** Import : la playlist du même nom reçoit les titres qui lui manquent, sans doublon et sans rien retirer
 * (un titre introuvable cette fois-ci n'efface pas l'ancien). Bilan : ajoutés, déjà présents, doublons d'origine. */
export function importIntoPlaylist(name: string, tracks: Track[], youtubeId?: string) {
  const incoming = dedupe(tracks);
  const existing = library.get().playlists.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
  const outcome = { added: incoming.length, alreadyPresent: 0, duplicates: tracks.length - incoming.length };
  if (!existing) {
    upsertPlaylist(name, incoming, youtubeId);
    return outcome;
  }
  const ids = new Set(existing.tracks.map((t) => t.id)), keys = new Set(existing.tracks.map(dedupeKey));
  const fresh = incoming.filter((t) => !ids.has(t.id) && !keys.has(dedupeKey(t)));
  outcome.added = fresh.length;
  outcome.alreadyPresent = incoming.length - fresh.length;
  // Ordre de la playlist d'origine, puis les titres qui n'étaient que dans Nova.
  const incomingIds = new Set(incoming.map((t) => t.id)), incomingKeys = new Set(incoming.map(dedupeKey));
  const ordered = incoming.map((t) => existing.tracks.find((e) => e.id === t.id || dedupeKey(e) === dedupeKey(t)) ?? t);
  const kept = existing.tracks.filter((t) => !incomingIds.has(t.id) && !incomingKeys.has(dedupeKey(t)));
  upsertPlaylist(name, [...ordered, ...kept], youtubeId ?? existing.youtubeId);
  return outcome;
}

export function addToPlaylist(id: string, tracks: Track[]) {
  const playlist = library.get().playlists.find((p) => p.id === id);
  if (!playlist) return;
  // Sans doublon : ni le même titre, ni une autre version du même morceau.
  const known = new Set(playlist.tracks.map((t) => t.id)), keys = new Set(playlist.tracks.map(dedupeKey));
  const fresh = tracks.filter((t) => !known.has(t.id) && !keys.has(dedupeKey(t)) && !!known.add(t.id) && !!keys.add(dedupeKey(t)));
  update((state) => ({ ...state, playlists: state.playlists.map((p) => (p.id === id ? { ...p, tracks: [...p.tracks, ...fresh] } : p)) }));
  const youtubeTracks = fresh.filter((track) => !isOctaveId(track.id));
  if (playlist.youtubeId && youtubeTracks.length && account.get().signedIn) {
    void api.addToAccountPlaylist(playlist.youtubeId, youtubeTracks.map((t) => t.id)).catch(() => undefined);
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

// MARK: Playlists partagées (collaboratives, via YouTube Music)

export const sharedURL = (id: string) => `https://music.youtube.com/playlist?list=${id}`;

export function sharedPlaylistID(text: string): string | undefined {
  try {
    return new URL(text.trim().slice(text.trim().indexOf('http'))).searchParams.get('list') ?? undefined;
  } catch {
    return undefined;
  }
}

/** Crée la playlist sur le compte YouTube (non répertoriée : le lien d'invitation fonctionne). */
export async function createShared(title: string, tracks: Track[] = []): Promise<SharedPlaylist | undefined> {
  const id = await api.createAccountPlaylist(title, tracks.map((t) => t.id), 'UNLISTED');
  if (!id) return undefined;
  const entry: SharedPlaylist = { id, title, artwork: tracks[0]?.artwork, isOwner: true };
  update((state) => ({ ...state, shared: [entry, ...(state.shared ?? [])] }));
  return entry;
}

/** Rejoindre : l'invitation s'accepte dans YouTube Music (fenêtre avec le compte), puis la playlist apparaît ici. */
export async function joinShared(link: string): Promise<SharedPlaylist | undefined> {
  const id = sharedPlaylistID(link);
  if (!id) return undefined;
  void api.openYouTube(link.trim().slice(link.trim().indexOf('http')));
  if (library.get().shared?.some((s) => s.id === id)) return library.get().shared!.find((s) => s.id === id);
  const page = await api.collection({ id: `VL${id}`, kind: 'playlist', title: '' }).catch(() => undefined);
  const entry: SharedPlaylist = { id, title: page?.header.title || 'Playlist partagée', artwork: page?.header.artwork ?? page?.tracks[0]?.artwork, isOwner: false };
  update((state) => ({ ...state, shared: [entry, ...(state.shared ?? [])] }));
  return entry;
}

export function removeShared(id: string) {
  update((state) => ({ ...state, shared: (state.shared ?? []).filter((s) => s.id !== id) }));
}

export async function addToShared(entry: SharedPlaylist, tracks: Track[]) {
  const ids = tracks.filter((track) => !isOctaveId(track.id)).map((track) => track.id);
  if (!ids.length) return;
  try {
    await api.addToAccountPlaylist(entry.id, ids);
    notify(`Ajouté à « ${entry.title} » (visible chez tous les participants)`);
  } catch {
    notify('Ajout impossible : la collaboration est-elle activée sur cette playlist ?');
  }
}

export const isShared = (collectionId: string) => (library.get().shared ?? []).some((s) => `VL${s.id}` === collectionId || s.id === collectionId);

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

// MARK: Bibliothèque de l'iPhone

/** Dates de l'iPhone : millisecondes depuis 1970 (export), ou secondes depuis 2001 (ancien format). */
function phoneDate(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  return value > 1e11 ? value : value * 1000 + 978_307_200_000;
}

function phoneTrack(raw: any): Track | undefined {
  if (!raw?.id || !raw.title) return undefined;
  const artwork: string | undefined = raw.artworkURL ?? raw.artwork ?? undefined;
  return {
    id: raw.id, title: raw.title, artist: raw.artist ?? '', album: raw.album ?? undefined, duration: raw.duration ?? undefined,
    artwork, artistId: raw.artistID ?? raw.artistId ?? undefined, albumId: raw.albumID ?? raw.albumId ?? undefined,
    square: /googleusercontent|ggpht/.test(artwork ?? ''),
  };
}

const phoneTracks = (list: unknown) => (Array.isArray(list) ? list.map(phoneTrack).filter((t): t is Track => !!t) : []);

/** Fusionne la bibliothèque reçue de l'iPhone : rien n'est perdu, rien n'est doublé (réimport possible). */
export function mergeFromPhone(raw: any): { playlists: number; tracks: number } {
  const phonePlaylists: UserPlaylist[] = (raw?.playlists ?? []).map((p: any) => ({
    id: crypto.randomUUID(), name: String(p.name ?? 'Playlist'), tracks: dedupe(phoneTracks(p.tracks)),
    created: phoneDate(p.createdAt) ?? Date.now(),
  })).filter((p: UserPlaylist) => p.tracks.length);
  const liked = phoneTracks(raw?.liked);
  const recents = phoneTracks(raw?.recents);
  const added = phoneTracks(raw?.addedTracks);
  const saved: Collection[] = (raw?.saved ?? []).filter((c: any) => c?.id && c.title).map((c: any) => ({
    id: c.id, kind: c.kind ?? 'playlist', title: c.title, subtitle: c.subtitle || undefined, artwork: c.artworkURL ?? c.artwork ?? undefined,
  }));
  update((state) => {
    const stats = { ...state.stats };
    for (const [id, value] of Object.entries<any>(raw?.stats ?? {})) {
      const current = stats[id];
      stats[id] = {
        playCount: Math.max(current?.playCount ?? 0, value?.playCount ?? 0),
        lastPlayed: Math.max(current?.lastPlayed ?? 0, phoneDate(value?.lastPlayed) ?? 0) || undefined,
      };
    }
    // Playlists du même nom remplacées par celles de l'iPhone (le lien avec YouTube est gardé).
    const byName = new Map(state.playlists.map((p) => [p.name.toLowerCase(), p]));
    const merged = phonePlaylists.map((p) => {
      const existing = byName.get(p.name.toLowerCase());
      return existing ? { ...p, id: existing.id, youtubeId: existing.youtubeId } : p;
    });
    const replaced = new Set(merged.map((p) => p.id));
    const lastPlayed = (t: Track) => stats[t.id]?.lastPlayed ?? 0;
    const history = [...recents, ...state.recents].filter((t, i, all) => all.findIndex((o) => o.id === t.id) === i)
      .sort((a, b) => lastPlayed(b) - lastPlayed(a)).slice(0, 1000);
    const known = new Set(state.saved.map((c) => c.id));
    return {
      ...state,
      stats,
      liked: [...liked, ...state.liked].filter((t, i, all) => all.findIndex((o) => o.id === t.id) === i),
      playlists: [...merged, ...state.playlists.filter((p) => !replaced.has(p.id))],
      recents: history,
      added: dedupe([...added, ...(state.added ?? [])]),
      saved: [...state.saved, ...saved.filter((c) => !known.has(c.id))],
      searches: [...state.searches, ...((raw?.searches ?? []) as string[]).filter((s) => !state.searches.includes(s))].slice(0, 30),
      shared: [...(state.shared ?? []), ...((raw?.shared ?? []) as any[])
        .filter((s) => s?.id && !(state.shared ?? []).some((known) => known.id === s.id))
        .map((s) => ({ id: s.id, title: s.title ?? 'Playlist partagée', artwork: s.artworkURL ?? undefined, isOwner: !!s.isOwner }))],
    };
  });
  return { playlists: phonePlaylists.length, tracks: songs().length };
}

export const phoneSync = new Store<{ lastSync?: number; phoneName?: string; newTracks?: number }>({});

// Envois automatiques de l'iPhone : fusion silencieuse, avec un mot quand il y a du nouveau.
on('phone:library', (raw: unknown, phone?: string) => {
  const before = new Set(songs().map((t) => t.id));
  const playlistsBefore = library.get().playlists.length;
  mergeFromPhone(raw);
  const fresh = songs().filter((t) => !before.has(t.id)).length;
  const newPlaylists = library.get().playlists.length - playlistsBefore;
  phoneSync.set({ lastSync: Date.now(), phoneName: phone, newTracks: fresh });
  if (fresh || newPlaylists) {
    notify([fresh && `${fresh} nouveau${fresh > 1 ? 'x' : ''} titre${fresh > 1 ? 's' : ''}`, newPlaylists > 0 && `${newPlaylists} playlist${newPlaylists > 1 ? 's' : ''}`]
      .filter(Boolean).join(' et ') + ` reçu${fresh + newPlaylists > 1 ? 's' : ''} de ${phone || 'l’iPhone'}`);
  }
});

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

let songsCache: { source: unknown; liked: unknown; added: unknown; songs: Track[] } | null = null;
/** Tous les morceaux (likés et playlists), sans doublons, triés par titre. Recalculé seulement si besoin. */
export function songs(state = library.get()): Track[] {
  if (songsCache && songsCache.source === state.playlists && songsCache.liked === state.liked && songsCache.added === state.added) return songsCache.songs;
  const result = dedupe([...(state.added ?? []), ...state.liked, ...state.playlists.flatMap((p) => p.tracks)])
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'));
  songsCache = { source: state.playlists, liked: state.liked, added: state.added, songs: result };
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
