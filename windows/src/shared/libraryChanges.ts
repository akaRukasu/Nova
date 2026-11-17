import type { LibraryState, Track } from './types.js';

const ids = (track: Track) => [track.id, track.youtubeId].filter((id): id is string => !!id);

export function restoreLibraryTracks(state: LibraryState, tracks: Track[], now = Date.now()): LibraryState {
  const restored = { ...state.libraryChanges?.restored };
  for (const track of tracks) for (const id of ids(track)) restored[id] = now;
  return { ...state, libraryChanges: { ...state.libraryChanges, restored } };
}

export function applyLibraryRemovals(state: LibraryState): LibraryState {
  if (!state.libraryChanges?.removed || !Object.keys(state.libraryChanges.removed).length) return state;
  const keep = (track: Track) => {
    const removed = Math.max(0, ...ids(track).map(id => state.libraryChanges?.removed?.[id] ?? 0));
    const restored = Math.max(0, ...ids(track).map(id => state.libraryChanges?.restored?.[id] ?? 0));
    return !removed || restored > removed;
  };
  return { ...state, added: (state.added ?? []).filter(keep), liked: state.liked.filter(keep),
    playlists: state.playlists.map(playlist => ({ ...playlist, tracks: playlist.tracks.filter(keep) })) };
}

export function mergeLibraryChanges(previous: LibraryState['libraryChanges'], removed: Record<string, number> = {}, restored: Record<string, number> = {}): LibraryState['libraryChanges'] {
  const merge = (a: Record<string, number> = {}, b: Record<string, number>) => {
    const result = { ...a };
    for (const [id, date] of Object.entries(b)) if (Number.isFinite(date)) result[id] = Math.max(result[id] ?? 0, date);
    return result;
  };
  return { removed: merge(previous?.removed, removed), restored: merge(previous?.restored, restored) };
}
