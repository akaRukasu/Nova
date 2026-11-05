// Paroles : synchronisées depuis LRCLIB (base libre de paroles horodatées), sinon texte de YouTube Music.
import type { Lyrics, LyricLine, Track } from '../shared/types.js';
import { mainArtist, normalize, stripExtras } from './matcher.js';
import { plainLyrics } from './yt.js';

interface Entry {
  trackName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string;
  syncedLyrics?: string;
}

async function lrclib<T>(endpoint: string, query: Record<string, string>): Promise<T | undefined> {
  const url = new URL(`https://lrclib.net/api/${endpoint}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  try {
    const response = await fetch(url, { headers: { 'user-agent': 'Nova (https://github.com/akaRukasu/Nova)' } });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

export function parseLRC(raw: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const row of raw.split(/\r?\n/)) {
    const stamps = [...row.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = row.slice((stamps.at(-1)!.index ?? 0) + stamps.at(-1)![0].length).trim();
    for (const stamp of stamps) {
      lines.push({ time: Number(stamp[1]) * 60 + Number(stamp[2].replace(':', '.')), text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

function fromEntry(entry: Entry): Lyrics | undefined {
  const lines = entry.syncedLyrics ? parseLRC(entry.syncedLyrics) : [];
  const text = entry.plainLyrics ?? lines.map((l) => l.text).join('\n');
  if (!text && !lines.length) return undefined;
  return { text, source: 'Paroles : LRCLIB', lines: lines.length ? lines : undefined };
}

async function synced(track: Track, duration?: number): Promise<Lyrics | undefined> {
  const title = stripExtras(track.title);
  const artist = mainArtist(track.artist);
  if (!title) return undefined;
  const exact: Record<string, string> = { track_name: title, artist_name: artist };
  if (track.album) exact.album_name = track.album;
  if (duration) exact.duration = String(Math.round(duration));
  const found = await lrclib<Entry>('get', exact);
  if (found?.syncedLyrics) return fromEntry(found);

  const results = (await lrclib<Entry[]>('search', { track_name: title, artist_name: artist })) ?? [];
  const wanted = normalize(title);
  const candidates = results.filter((entry) => {
    if (entry.instrumental) return false;
    const name = normalize(stripExtras(entry.trackName ?? ''));
    return name === wanted || name.includes(wanted) || wanted.includes(name);
  });
  const gap = (entry: Entry) => (duration && entry.duration ? Math.abs(entry.duration - duration) : 5);
  const best = candidates.filter((e) => e.syncedLyrics && gap(e) < 8).sort((a, b) => gap(a) - gap(b))[0];
  if (best) return fromEntry(best);
  const plain = candidates.find((e) => e.plainLyrics);
  return plain ? fromEntry(plain) : undefined;
}

export async function lyrics(track: Track, duration?: number): Promise<Lyrics | undefined> {
  const [fromLRCLIB, fromYouTube] = await Promise.all([
    synced(track, duration),
    plainLyrics(track.id).catch(() => undefined),
  ]);
  if (fromLRCLIB?.lines?.length) return fromLRCLIB;
  return fromYouTube ?? fromLRCLIB;
}
