import type { Collection, Track } from '../shared/types.js';
import { isOctaveId } from '../shared/octave.js';
import { matchRecording, recordingSearchQueries } from './matcher.js';
import * as youtube from './yt.js';

const matches = new Map<string, Track>();

export async function saveYouTubeAlbum(album: Collection, tracks: Track[]) {
  let target: Collection | undefined = album.id.startsWith('MPREb') ? album : undefined;
  for (const track of tracks.slice(0, 3)) {
    if (target) break;
    const found = await findYouTubeRecording({ ...track, youtubeId: undefined });
    if (found?.albumId?.startsWith('MPREb') && found.album
      && found.album.trim().toLocaleLowerCase('fr') === album.title.trim().toLocaleLowerCase('fr')) {
      target = { ...album, id: found.albumId };
    }
  }
  if (!target) throw new Error('L’album « ' + album.title + ' » doit être identifié dans YouTube Music.');
  await youtube.saveAlbum(target);
}

export async function findYouTubeRecording(track: Track): Promise<Track | undefined> {
  if (track.id.startsWith('local:')) return undefined;
  if (!isOctaveId(track.id)) return track;
  if (track.youtubeId && /^[\w-]{11}$/.test(track.youtubeId)) return { ...track, id: track.youtubeId };
  const cached = matches.get(track.id);
  if (cached) return cached;
  for (const query of recordingSearchQueries(track)) {
    const shelves = await youtube.search(query, 'song');
    const candidates = shelves.flatMap((shelf) => shelf.items).flatMap((item) => item.type === 'track' ? [item.track] : []);
    const found = matchRecording(track, candidates);
    if (!found) continue;
    if (matches.size >= 500) matches.delete(matches.keys().next().value!);
    matches.set(track.id, found);
    return found;
  }
}

export async function syncOctaveListen(track: Track, authorized: () => Promise<boolean>): Promise<void> {
  if (!await authorized()) return;
  const found = await findYouTubeRecording(track);
  if (found && await authorized()) await youtube.addHistory(found.id);
}
