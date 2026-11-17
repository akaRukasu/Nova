import type { Track } from './types.js';

const key = (text: string) => text.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function recordingKey(track: Track) {
  const artist = key(track.artist);
  if (!artist || artist === 'artisteinconnu' || artist === 'unknownartist') return;
  const prefixed = track.title.match(/^(.+?)\s*[-–—:]\s+(.+)$/);
  const title = key(prefixed && key(prefixed[1]) === artist ? prefixed[2] : track.title);
  if (title) return artist + '|' + title;
}

/** A local master can be shorter than its video. Keep edition markers such as live or remix. */
export function localPlaybackSelector(tracks: Track[], available: ReadonlySet<string>) {
  const byRecording = new Map<string, Track[]>();
  for (const track of tracks) {
    if (!track.id.startsWith('local:') || !available.has(track.id)) continue;
    const identity = recordingKey(track);
    if (!identity) continue;
    const candidates = byRecording.get(identity) ?? [];
    candidates.push(track);
    byRecording.set(identity, candidates);
  }
  return (track: Track): Track => {
    if (track.id.startsWith('local:')) return track;
    const identity = recordingKey(track);
    if (!identity) return track;
    const candidates = (byRecording.get(identity) ?? []).flatMap(local => {
      if (track.album && local.album && key(track.album) !== key(local.album)) return [];
      const distance = track.duration && local.duration ? Math.abs(track.duration - local.duration) : undefined;
      return distance === undefined || distance <= Math.min(20, (track.duration ?? 0) * 0.12) ? [{ local, distance }] : [];
    }).sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    const best = candidates[0], next = candidates[1];
    if (!best || (next && (best.distance === undefined || best.distance > 3
      || next.distance === undefined || next.distance - best.distance < 2))) return track;
    return best.local;
  };
}
