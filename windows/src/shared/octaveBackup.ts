import type { Collection, Track } from './types.js';
import { octaveId } from './octave.js';

type Metadata = {
  id?: unknown; title?: string; name?: string; duration?: number;
  cover_big?: string; cover_medium?: string; picture_big?: string; picture_medium?: string;
  artist?: Metadata; album?: Metadata;
};
type RawPlaylist = { id?: string; name?: string; system?: boolean; createdAt?: number; tracks?: Metadata[] };
type RawLibrary = { playlists?: RawPlaylist[]; savedAlbums?: Metadata[]; followedArtists?: Metadata[] };
export type OctaveLibraryImport = {
  liked: Track[];
  playlists: { name: string; created?: number; tracks: Track[] }[];
  saved: Collection[];
};

const image = (url?: string) => typeof url === 'string' && url.startsWith('https://') ? url : undefined;

export function octaveBackupLibrary(input: unknown): OctaveLibraryImport {
  const file = input as { app?: string; type?: string; data?: { 'octave:library'?: { state?: RawLibrary } } } | null;
  const state = file?.data?.['octave:library']?.state;
  if (!state || !Array.isArray(state.playlists)) throw new Error('Ce fichier ne contient pas de sauvegarde de bibliothèque Octave.');
  const toTrack = (raw: Metadata): Track | undefined => {
    const id = octaveId(raw?.id);
    if (!id || typeof raw.title !== 'string' || !raw.title.trim()) return;
    return { id, title: raw.title, artist: typeof raw.artist?.name === 'string' ? raw.artist.name : '',
      artistId: octaveId(raw.artist?.id), album: raw.album?.title, albumId: octaveId(raw.album?.id),
      duration: typeof raw.duration === 'number' && raw.duration > 0 ? raw.duration : undefined,
      artwork: image(raw.album?.cover_big ?? raw.album?.cover_medium), square: true };
  };
  const playlists = new Map<string, OctaveLibraryImport['playlists'][number]>();
  const seenByPlaylist = new Map<string, Set<string>>();
  const liked: Track[] = [];
  for (const list of state.playlists) {
    if (!list || !Array.isArray(list.tracks)) continue;
    if (list.id === 'liked') {
      liked.push(...list.tracks.flatMap(raw => toTrack(raw) ?? []));
      continue;
    }
    if (typeof list.name !== 'string' || !list.name.trim()) continue;
    const key = list.name.trim().normalize('NFC').toLocaleLowerCase('fr');
    const existing = playlists.get(key) ?? { name: list.name.trim(),
      created: Number.isFinite(list.createdAt) && list.createdAt! > 0 ? list.createdAt : undefined, tracks: [] };
    const seen = seenByPlaylist.get(key) ?? new Set();
    for (const raw of list.tracks) {
      const track = toTrack(raw);
      if (track && !seen.has(track.id)) { seen.add(track.id); existing.tracks.push(track); }
    }
    if (existing.created && list.createdAt && list.createdAt > 0) existing.created = Math.min(existing.created, list.createdAt);
    playlists.set(key, existing);
    seenByPlaylist.set(key, seen);
  }
  const saved = (['album', 'artist'] as const).flatMap(kind => {
    const entries = kind === 'album' ? state.savedAlbums : state.followedArtists;
    return (Array.isArray(entries) ? entries : []).flatMap((entry): Collection[] => {
      const id = octaveId(entry?.id), title = kind === 'album' ? entry?.title : entry?.name;
      return id && typeof title === 'string' && title.trim() ? [{ id, kind, title, subtitle: entry.artist?.name,
        artwork: image(entry.cover_big ?? entry.cover_medium ?? entry.picture_big ?? entry.picture_medium) }] : [];
    });
  });
  return { liked: [...new Map(liked.map(track => [track.id, track])).values()], playlists: [...playlists.values()], saved };
}
