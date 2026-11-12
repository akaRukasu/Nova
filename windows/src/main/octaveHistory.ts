import type { Track } from '../shared/types.js';
import { isOctaveId } from '../shared/octave.js';
import { matchRecording } from './matcher.js';
import * as youtube from './yt.js';

const matches = new Map<string, Track>();

export async function findYouTubeRecording(track: Track): Promise<Track | undefined> {
  if (!isOctaveId(track.id)) return track;
  const cached = matches.get(track.id);
  if (cached) return cached;
  const shelves = await youtube.search(`${track.title} ${track.artist}`, 'song');
  const candidates = shelves.flatMap((shelf) => shelf.items).flatMap((item) => item.type === 'track' ? [item.track] : []);
  const found = matchRecording(track, candidates);
  if (found) {
    if (matches.size >= 500) matches.delete(matches.keys().next().value!);
    matches.set(track.id, found);
  }
  return found;
}

export async function syncOctaveListen(track: Track, authorized: () => Promise<boolean>): Promise<void> {
  if (!await authorized()) return;
  const found = await findYouTubeRecording(track);
  if (found && await authorized()) await youtube.addHistory(found.id);
}
