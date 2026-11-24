import type { Collection, LibraryState, Track } from '../../shared/types';
import { artistNameKey } from '../../shared/artistNames';
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
    const identity = kind === 'artist' ? artistNameKey(title) : [key(title), artistNameKey(track.artist)].join('|');
    const id = catalogID && byCatalogID.get(catalogID) || identity;
    if (catalogID) byCatalogID.set(catalogID, id);
    const addedAt = state.stats[track.id]?.addedAt ?? importedAt.get(track.id) ?? 0;
    const existing = groups.get(id);
    if (existing) {
      existing.tracks.push(track);
      existing.addedAt = Math.max(existing.addedAt, addedAt);
      if (kind === 'artist' && title.includes('&') && !existing.title.includes('&')) existing.title = title;
      if (!existing.artworkTrack.artwork && track.artwork) existing.artworkTrack = track;
    } else {
      groups.set(id, { id, title, subtitle: kind === 'artist' ? '' : track.artist, tracks: [track], addedAt, artworkTrack: track });
    }
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }));
}

export function libraryEntries(state: LibraryState, kind: LibraryGroupKind, singles = false) {
  const groups = libraryGroups(state, kind, singles);
  const byId = new Map<string, LibraryGroup>();
  const byIdentity = new Map(groups.map(group => [group.id, group]));
  for (const group of groups) for (const track of group.tracks) {
    const id = kind === 'artist' ? track.artistId : track.albumId;
    if (id) byId.set(id, group);
  }
  const saved: Collection[] = [];
  for (const collection of state.saved) {
    if (collection.kind !== kind) continue;
    const identity = kind === 'artist' ? artistNameKey(collection.title) : [key(collection.title), artistNameKey(collection.subtitle ?? '')].join('|');
    const existing = byId.get(collection.id) ?? byIdentity.get(identity);
    if (existing) {
      existing.addedAt = Math.max(existing.addedAt, collection.addedAt ?? 0);
      if (!existing.artworkTrack.artwork && collection.artwork) existing.artworkTrack = { ...existing.artworkTrack, artwork: collection.artwork };
    } else saved.push(collection);
  }
  return [
    ...groups.map(group => ({ kind: 'group' as const, addedAt: group.addedAt, title: group.title, subtitle: group.subtitle, group })),
    ...saved.map(collection => ({ kind: 'collection' as const, addedAt: collection.addedAt ?? 0,
      title: collection.title, subtitle: collection.subtitle ?? '', collection })),
  ];
}

export function recentLibraryEntries(state: LibraryState) {
  return libraryEntries(state, 'album', true)
    .sort((a, b) => b.addedAt - a.addedAt || a.title.localeCompare(b.title, 'fr', { sensitivity: 'base' }));
}

export function releaseType(group: LibraryGroup) {
  if (!group.tracks.some(track => track.album)) return 'Morceau';
  if (/(?:\s|[-–])EP$/i.test(group.title)) return 'EP';
  if (/(?:\s|[-–])Single$/i.test(group.title) || (group.tracks.length === 1 && key(group.title) === key(group.tracks[0].title))) return 'Single';
  return 'Album';
}
