// Import de playlists venues d'ailleurs (PC et Android) : chaque titre est retrouvé sur YouTube Music,
// puis les introuvables sont recherchés une seconde fois, plus lentement (le réseau ou YouTube ont pu échouer).
import type { ImportedPlaylist, ImportProgress, Track } from '../shared/types.js';
import { match, savedMatches } from './matcher.js';
import * as yt from './yt.js';

export interface ImportResult { name: string; tracks: Track[]; youtubeId?: string; missing: number }

export async function runImport(
  playlists: ImportedPlaylist[],
  toAccount: boolean,
  options: { emit: (progress: ImportProgress) => void; cancelled: () => boolean; saveMatches: (entries: Record<string, Track>) => Promise<void>; width: number },
): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  for (const playlist of playlists) {
    const progress: ImportProgress = { name: playlist.name, total: playlist.tracks.length, processed: 0, matched: 0, missing: [], done: false };
    const found: (Track | undefined)[] = new Array(playlist.tracks.length);
    const searchAll = async (positions: number[], width: number, verifying: boolean) => {
      let next = 0;
      const worker = async () => {
        while (!options.cancelled() && next < positions.length) {
          const position = positions[next++];
          const wanted = playlist.tracks[position];
          const track = wanted.youtubeId
            ? { id: wanted.youtubeId, title: wanted.title, artist: wanted.artist, album: wanted.album, duration: wanted.duration }
            : await match(wanted).catch(() => undefined);
          found[position] = track;
          if (!verifying) progress.processed++;
          if (track) progress.matched++;
          else progress.missing.push(wanted);
          if (verifying || progress.processed % 5 === 0 || progress.processed === progress.total) options.emit({ ...progress });
        }
      };
      await Promise.all(Array.from({ length: width }, worker));
    };
    await searchAll(playlist.tracks.map((_, i) => i), options.width, false);
    // Vérification : seconde recherche, deux à la fois, des titres pas encore trouvés.
    const missing = found.map((track, i) => (track ? -1 : i)).filter((i) => i >= 0);
    if (missing.length && !options.cancelled()) {
      progress.missing = [];
      progress.verifying = true;
      options.emit({ ...progress });
      await searchAll(missing, 2, true);
      progress.verifying = false;
    }
    const seen = new Set<string>();
    const tracks = found.filter((t): t is Track => !!t && !seen.has(t.id) && !!seen.add(t.id));
    let youtubeId: string | undefined;
    // Compte YouTube connecté : la playlist est aussi créée sur le compte (visible sur l'iPhone).
    if (toAccount && tracks.length && !options.cancelled()) {
      youtubeId = await yt.createAccountPlaylist(playlist.name, tracks.map((t) => t.id)).catch(() => undefined);
    }
    results.push({ name: playlist.name, tracks, youtubeId, missing: progress.missing.length });
    options.emit({ ...progress, done: true, playlistId: youtubeId });
    await options.saveMatches(savedMatches()).catch(() => undefined);
    if (options.cancelled()) break;
  }
  return results;
}
