import type { Collection, LibraryState, Track } from '../../shared/types';
import { songs } from './library';

export type LibraryGroupKind = 'album' | 'artist';
export interface LibraryGroup {
  id: string;
  title: string;
  subtitle: string;
  tracks: Track[];
  addedAt: number;
  artworkTrack: Track;
}

function key(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr').trim();
}

export function libraryGroups(state: LibraryState, kind: LibraryGroupKind, singles = false): LibraryGroup[] {
  const groups = new Map<string, LibraryGroup>();
  const byCatalogID = new Map<string, string>();
  const importedAt = new Map<string, number>();
  for (const playlist of state.playlists) {
    for (const track of playlist.tracks) importedAt.set(track.id, Math.min(playlist.created, importedAt.get(track.id) ?? Infinity));
  }
  for (const track of songs(state)) {
    const title = kind === 'artist' ? track.artist.trim() : track.album?.trim() || (singles ? track.title : '');
    if (!title) continue;
    const catalogID = kind === 'artist' ? track.artistId : track.albumId;
    const identity = kind === 'artist' ? key(title) : [key(title), key(track.artist)].join('|');
    const id = catalogID && byCatalogID.get(catalogID) || identity;
    if (catalogID) byCatalogID.set(catalogID, id);
    const addedAt = state.stats[track.id]?.addedAt ?? importedAt.get(track.id) ?? 0;
    const existing = groups.get(id);
    if (existing) {
      existing.tracks.push(track);
      existing.addedAt = Math.max(existing.addedAt, addedAt);
      if (!existing.artworkTrack.artwork && track.artwork) existing.artworkTrack = track;
    } else {
      groups.set(id, { id, title, subtitle: kind === 'artist' ? '' : track.artist, tracks: [track], addedAt, artworkTrack: track });
    }
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }));
}

export function recentLibraryEntries(state: LibraryState) {
  const groups = libraryGroups(state, 'album', true);
  const byId = new Map(groups.flatMap(group => group.tracks.flatMap(track => track.albumId ? [[track.albumId, group] as const] : [])));
  const saved: Collection[] = [];
  for (const album of state.saved) {
    if (album.kind !== 'album') continue;
    const existing = byId.get(album.id) ?? groups.find(group => group.id === [key(album.title), key(album.subtitle ?? '')].join('|'));
    if (existing) existing.addedAt = Math.max(existing.addedAt, album.addedAt ?? 0);
    else saved.push(album);
  }
  return [
    ...groups.map(group => ({ kind: 'group' as const, addedAt: group.addedAt, title: group.title, group })),
    ...saved.map(album => ({ kind: 'album' as const, addedAt: album.addedAt ?? 0, title: album.title, album })),
  ].sort((a, b) => b.addedAt - a.addedAt || a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }));
}

export function releaseType(group: LibraryGroup) {
  if (!group.tracks.some(track => track.album)) return 'Morceau';
  if (/(?:\s|[-–])EP$/i.test(group.title)) return 'EP';
  if (/(?:\s|[-–])Single$/i.test(group.title) || (group.tracks.length === 1 && key(group.title) === key(group.tracks[0].title))) return 'Single';
  return 'Album';
}
