import type { Collection, OctaveAudioSettings, Track } from './types.js';

export const octaveOrigin = 'https://music.octavestreaming.com';
const prefix = 'octave:';

export const octaveAudioDefaults: OctaveAudioSettings = {
  automixStyle: 'apple',
  quality: 'lossless', transition: 'automix', autoplay: true, gapless: true, soundCheck: true, smartShuffle: true,
};

export type PlaybackSource = 'octave' | 'youtube';
export type OctaveStart = 'playing' | 'sign-in' | 'interaction' | 'not-found' | 'unavailable' | 'cancelled';
export type OctaveCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'next' }
  | { type: 'seek' | 'volume'; value: number };
export interface OctavePlayback {
  request: number;
  time: number;
  duration: number;
  playing: boolean;
  ended?: boolean;
  signIn?: boolean;
  track?: Track;
  upcoming?: Track[];
  mixing?: boolean;
}

export const isOctaveId = (id: string) => id.startsWith(prefix);

export function octaveQueueQueries(track: Track): string[] {
  return [...new Set([`${track.title} ${track.artist}`, `"${track.title}" ${track.artist}`, `${track.artist} ${track.title}`])];
}

export function octaveId(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const id = String(value);
  return /^\d{1,20}$/.test(id) ? `${prefix}${id}` : undefined;
}

export function octaveCatalogId(id: string): string | undefined {
  return isOctaveId(id) && octaveId(id.slice(prefix.length)) === id ? id.slice(prefix.length) : undefined;
}

export function octaveCollectionUrl(collection: Pick<Collection, 'id' | 'kind'>): string | undefined {
  const id = octaveCatalogId(collection.id);
  return id ? `${octaveOrigin}/${collection.kind}/${id}` : undefined;
}

export function octaveTrackUrl(track: Track): string {
  const id = octaveCatalogId(track.id);
  const album = track.albumId && octaveCatalogId(track.albumId);
  if (id && album) return `${octaveOrigin}/album/${album}?t=${id}`;
  return `${octaveOrigin}/search?q=${encodeURIComponent(`${track.title} ${track.artist}`.trim())}`;
}
