import type { Track } from './types.js';

/** Prolonge un fichier lancé seul avec la bibliothèque, sans envoyer son identifiant local aux catalogues. */
export function localContinuation(seed: Track, library: Track[], queue: Track[], limit = 20): Track[] {
  const key = (value?: string) => (value ?? '').normalize('NFKC').toLocaleLowerCase('fr').trim();
  const known = new Set(queue.flatMap(track => [track.id, track.youtubeId].filter((id): id is string => !!id)));
  const artist = key(seed.artist), album = key(seed.album);
  const rank = (track: Track) => (artist && key(track.artist) === artist ? 4 + (album && key(track.album) === album ? 4 : 0) : 0)
    + (track.id.startsWith('local:') ? 1 : 0);
  return library.filter(track => {
    if (known.has(track.id) || (track.youtubeId && known.has(track.youtubeId))) return false;
    known.add(track.id);
    if (track.youtubeId) known.add(track.youtubeId);
    return true;
  }).sort((a, b) => rank(b) - rank(a)).slice(0, Math.max(0, limit));
}
