import type { Page, Shelf, Track } from '../shared/types.js';
import { matchRecording } from './matcher.js';
import * as octave from './octave.js';
import * as youtube from './yt.js';

const limit = 60;
let youtubeCache: { tracks: Track[]; expires: number } | undefined;
let loadingYouTube: Promise<Track[]> | undefined;

function youtubePopular(): Promise<Track[]> {
  if (youtubeCache && youtubeCache.expires > Date.now()) return Promise.resolve(youtubeCache.tracks);
  if (loadingYouTube) return loadingYouTube;
  loadingYouTube = (async () => {
    const page = await youtube.browse({ browseId: 'FEmusic_charts' }).catch(() => undefined);
    const lists = page?.shelves.flatMap(shelf => shelf.items.flatMap(item =>
      item.type === 'collection' && item.collection.kind === 'playlist' ? [item.collection] : [])) ?? [];
    const chart = lists.find(list => /\b100\b/.test(list.title)) ?? lists[0];
    let tracks = chart ? (await youtube.collection(chart, limit).catch(() => undefined))?.tracks ?? [] : [];
    if (!tracks.length) {
      const explore = await youtube.explore();
      tracks = explore.shelves.find(shelf => shelf.layout === 'grid' && shelf.items.some(item => item.type === 'track'))
        ?.items.flatMap(item => item.type === 'track' ? [item.track] : []) ?? [];
    }
    if (tracks.length) youtubeCache = { tracks: tracks.slice(0, limit), expires: Date.now() + 15 * 60_000 };
    return tracks.slice(0, limit);
  })().finally(() => { loadingYouTube = undefined; });
  return loadingYouTube;
}

export function mergePopularTracks(octaveTracks: Track[], youtubeTracks: Track[]): Track[] {
  const octaveEntries = octaveTracks.slice(0, limit).map(track => ({ ...track }));
  const youtubeEntries: Track[] = [];
  for (const track of youtubeTracks.slice(0, limit)) {
    const duplicate = matchRecording(track, octaveEntries);
    if (duplicate) {
      if (!duplicate.youtubeId) duplicate.youtubeId = track.id;
    } else if (!youtubeEntries.some(item => item.id === track.id) && !matchRecording(track, youtubeEntries)) youtubeEntries.push(track);
  }
  const merged: Track[] = [];
  const seen = new Set<string>();
  for (let rank = 0; rank < Math.max(octaveEntries.length, youtubeEntries.length) && merged.length < limit; rank++) {
    for (const track of [octaveEntries[rank], youtubeEntries[rank]]) {
      if (track && !seen.has(track.id) && merged.length < limit) { seen.add(track.id); merged.push(track); }
    }
  }
  return merged;
}

export async function popularPage(): Promise<Page> {
  const [page, other] = await Promise.all([
    octave.charts().catch(() => undefined), youtubePopular().catch(() => []),
  ]);
  const charts = page?.shelves.find(shelf => shelf.id === 'octave-charts');
  const native = charts?.items.flatMap(item => item.type === 'track' ? [item.track] : []) ?? [];
  const tracks = mergePopularTracks(native, other);
  const popular: Shelf = { id: 'popular-tracks', title: 'Titres populaires', layout: 'grid', items: tracks.map(track => ({type: 'track', track})) };
  if (!tracks.length) throw new Error('Les classements sont momentanément indisponibles.');
  return { shelves: [popular, ...(page?.shelves.filter(shelf => shelf !== charts) ?? [])] };
}
