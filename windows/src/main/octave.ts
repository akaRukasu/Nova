import type { Collection, CollectionKind, CollectionPage, Item, Page, PageHeader, Shelf, Track } from '../shared/types.js';
import { octaveCatalogId, octaveId } from '../shared/octave.js';
import { confirmClipRecording, mainArtist, matchRecording, normalize, recordingSearchQueries } from './matcher.js';
import { search as searchYouTube, type SearchScope } from './yt.js';

const base = 'https://api.octavestreaming.com/api';

interface OctaveEntry {
  id?: string | number;
  title?: string;
  name?: string;
  user?: string;
  artist?: OctaveEntry;
  album?: OctaveEntry;
  duration?: number;
  cover_big?: string;
  cover_medium?: string;
  picture_big?: string;
  picture_medium?: string;
  image?: string;
  tracks?: OctaveEntry[];
}

interface Catalog {
  tracks?: OctaveEntry[];
  albums?: OctaveEntry[];
  artists?: OctaveEntry[];
  playlists?: OctaveEntry[];
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(12_000) }).catch(() => {
    throw new Error('Impossible de joindre le catalogue Octave. Vérifie ta connexion Internet.');
  });
  if (!response.ok) throw new Error(`Le catalogue Octave est indisponible pour cette demande (${response.status}).`);
  return response.json() as Promise<T>;
}

function requiredId(id: string): string {
  const value = octaveCatalogId(id);
  if (!value) throw new Error('Identifiant Octave invalide.');
  return value;
}

function artwork(entry?: OctaveEntry) {
  const url = entry?.cover_big ?? entry?.cover_medium ?? entry?.picture_big ?? entry?.picture_medium ?? entry?.image;
  return typeof url === 'string' && url.startsWith('https://') ? url : undefined;
}

function toTrack(entry: OctaveEntry, album = entry.album): Track | undefined {
  const id = octaveId(entry.id);
  if (!id || !entry.title) return undefined;
  return {
    id, title: entry.title, artist: entry.artist?.name ?? album?.artist?.name ?? '',
    album: album?.title, albumId: octaveId(album?.id), artistId: octaveId(entry.artist?.id ?? album?.artist?.id),
    duration: typeof entry.duration === 'number' && entry.duration > 0 ? entry.duration : undefined,
    artwork: artwork(album), square: true,
  };
}

function tracks(entries: OctaveEntry[] = [], album?: OctaveEntry): Track[] {
  return entries.flatMap((entry) => toTrack(entry, album ?? entry.album) ?? []);
}

function toCollection(entry: OctaveEntry, kind: CollectionKind): Collection | undefined {
  const id = octaveId(entry.id);
  const title = kind === 'artist' ? entry.name : entry.title;
  if (!id || !title) return undefined;
  return { id, kind, title, subtitle: entry.artist?.name ?? entry.user, artwork: artwork(entry) };
}

function trackShelf(id: string, title: string, entries: Track[], layout: Shelf['layout'] = 'list'): Shelf {
  return { id, title, layout, items: entries.map((track) => ({ type: 'track', track })) };
}

function collectionShelf(kind: CollectionKind, title: string, entries: OctaveEntry[] = []): Shelf {
  const items = entries.flatMap((entry): Item[] => {
    const collection = toCollection(entry, kind);
    return collection ? [{ type: 'collection', collection }] : [];
  });
  return { id: kind, title, layout: 'cards', items };
}

export async function search(query: string, scope: SearchScope): Promise<Shelf[]> {
  if (!query.trim() || scope === 'video') return [];
  const params = new URLSearchParams({ query: query.trim(), limit: '30' });
  const data = await request<Catalog>(`/search/page?${params}`);
  const shelves = {
    song: trackShelf('tracks', 'Titres', tracks(data.tracks)),
    album: collectionShelf('album', 'Albums', data.albums),
    artist: collectionShelf('artist', 'Artistes', data.artists),
    playlist: collectionShelf('playlist', 'Playlists', data.playlists),
  };
  return (scope === 'all' ? Object.values(shelves) : [shelves[scope]]).filter((shelf) => shelf.items.length);
}

const recordings = new Map<string, Track>();

export async function findRecording(track: Track): Promise<Track | undefined> {
  if (octaveCatalogId(track.id) && track.albumId) return track;
  const cached = recordings.get(track.id);
  if (cached) return cached;
  const queries = recordingSearchQueries(track);
  const possibleAudio = new Map<string, Track>();
  for (const query of queries) {
    const items = (await search(query, 'all')).flatMap((shelf) => shelf.items);
    const candidates = items.flatMap((item) =>
      item.type === 'track' && item.track.albumId ? [item.track] : []);
    const exactId = candidates.find((candidate) => candidate.id === track.id);
    if (exactId) return rememberRecording(track.id, exactId);
    const found = matchRecording(track, candidates);
    const album = normalize(track.album ?? '');
    if (album && normalize(found?.album ?? '') !== album) {
      const release = items.flatMap(item => item.type === 'collection' ? [item.collection] : []).find(item =>
        item.kind === 'album' && normalize(item.title) === album && normalize(item.subtitle ?? '') === normalize(mainArtist(track.artist)));
      if (release) {
        const page = await collection(release).catch(() => undefined);
        const sameRelease = page && matchRecording(track, page.tracks);
        if (sameRelease) return rememberRecording(track.id, sameRelease);
      }
    }
    if (found) return rememberRecording(track.id, found);
    if (track.square === false) {
      for (const candidate of candidates) {
        if (candidate.square && normalize(candidate.title) === normalize(track.title)
          && normalize(candidate.artist) === normalize(track.artist)) possibleAudio.set(candidate.id, candidate);
      }
    }
  }
  if (!possibleAudio.size) return undefined;
  // Le clip peut inclure une scène ou un générique. Confirmer l'édition avec la piste audio YouTube Music.
  const shelves = await searchYouTube(`${track.title} ${track.artist}`, 'song').catch(() => []);
  const audio = shelves.flatMap((shelf) => shelf.items).flatMap((item) => item.type === 'track' ? [item.track] : []);
  const confirmed = confirmClipRecording(track, [...possibleAudio.values()], audio);
  return confirmed ? rememberRecording(track.id, confirmed) : undefined;
}

function rememberRecording(id: string, found: Track): Track {
  if (recordings.size >= 500) recordings.delete(recordings.keys().next().value!);
  recordings.set(id, found);
  return found;
}

export async function suggestions(query: string): Promise<string[]> {
  if (!query.trim()) return [];
  const { queries } = await request<{ queries?: string[] }>(`/suggest?${new URLSearchParams({ query: query.trim(), limit: '6' })}`);
  return [...new Set(queries)].slice(0, 6);
}

let chartsCache: { expires: number; data: Promise<Catalog> } | undefined;

export async function charts(home = false): Promise<Page> {
  if (!chartsCache || chartsCache.expires < Date.now()) {
    const data = request<Catalog>('/charts');
    chartsCache = { expires: Date.now() + 5 * 60_000, data };
    void data.catch(() => { if (chartsCache?.data === data) chartsCache = undefined; });
  }
  const data = await chartsCache.data;
  const shelves = [
    trackShelf('octave-charts', 'Titres populaires sur Octave', tracks(data.tracks).slice(0, home ? 18 : undefined), 'grid'),
    collectionShelf('album', 'Albums populaires', data.albums),
    collectionShelf('artist', 'Artistes populaires', data.artists?.slice(0, home ? 15 : undefined)),
    collectionShelf('playlist', 'Playlists populaires', data.playlists?.slice(0, home ? 15 : undefined)),
  ];
  return { shelves: shelves.filter((shelf) => shelf.items.length) };
}

export async function collection(target: Collection): Promise<CollectionPage> {
  const { kind } = target;
  if (kind !== 'album' && kind !== 'playlist') throw new Error('Type de collection Octave invalide.');
  const data = await request<{ album?: OctaveEntry; playlist?: OctaveEntry }>(`/${kind}/${requiredId(target.id)}`);
  const entry = data[kind];
  if (!entry) throw new Error('Cette collection est indisponible sur Octave.');
  return {
    header: { title: entry.title || target.title, subtitle: entry.artist?.name ?? entry.user ?? target.subtitle, artwork: artwork(entry) ?? target.artwork },
    tracks: tracks(entry.tracks, kind === 'album' ? entry : undefined), related: [],
  };
}

export async function artistSongs(id: string): Promise<Track[]> {
  const data = await request<Catalog>(`/artist/${requiredId(id)}/radio`);
  return tracks(data.tracks).filter((track) => track.artistId === id);
}

export async function artist(id: string): Promise<{ header: PageHeader; shelves: Shelf[]; tracks: Track[] }> {
  const data = await request<{ artist: OctaveEntry; top?: OctaveEntry[]; albums?: OctaveEntry[]; related?: OctaveEntry[]; bio?: string }>(`/artist/${requiredId(id)}`);
  const top = tracks(data.top);
  const songs = top.length ? top : await artistSongs(id).catch(() => []);
  const shelves = [
    trackShelf('top', 'Titres populaires', songs), collectionShelf('album', 'Albums', data.albums),
    collectionShelf('artist', 'Artistes similaires', data.related),
  ];
  return {
    header: { title: data.artist.name ?? '', artwork: artwork(data.artist), description: data.bio },
    shelves: shelves.filter((shelf) => shelf.items.length), tracks: songs,
  };
}

export async function radio(id: string): Promise<Track[]> {
  const data = await request<Catalog>(`/track/${requiredId(id)}/radio`);
  return tracks(data.tracks);
}

export async function related(id: string): Promise<Shelf[]> {
  const songs = (await radio(id)).filter((track) => track.id !== id);
  return songs.length ? [trackShelf('octave-related', 'Titres similaires sur Octave', songs.slice(0, 18), 'grid')] : [];
}
