// Import PC et Android, recherche Octave prioritaire puis vérification et journal des correspondances.
import type { ImportedPlaylist, ImportProgress, ImportJournalEntry, Track } from '../shared/types.js';
import { match, savedMatches } from './matcher.js';
import { findRecording } from './octave.js';
import { findYouTubeRecording } from './octaveHistory.js';
import { isOctaveId } from '../shared/octave.js';
import * as yt from './yt.js';

export interface ImportResult { name: string; tracks: Track[]; youtubeId?: string; missing: number }

export async function runImport(
  playlists: ImportedPlaylist[],
  toAccount: boolean,
  options: { emit: (progress: ImportProgress) => void; cancelled: () => boolean; saveMatches: (entries: Record<string, Track>) => Promise<void>; saveJournal: (entries: ImportJournalEntry[]) => Promise<void>; width: number },
): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  for (const playlist of playlists) {
    const progress: ImportProgress = { name: playlist.name, total: playlist.tracks.length, processed: 0, matched: 0, missing: [], done: false };
    const found: (Track | undefined)[] = new Array(playlist.tracks.length);
    const journal = new Map<number, ImportJournalEntry>();
    const searchAll = async (positions: number[], width: number, verifying: boolean) => {
      let next = 0;
      const worker = async () => {
        while (!options.cancelled() && next < positions.length) {
          const position = positions[next++];
          const wanted = playlist.tracks[position];
          const original = { id: wanted.youtubeId ?? 'import:' + [wanted.title, wanted.artist, wanted.album, wanted.duration].join('|'),
            title: wanted.title, artist: wanted.artist, album: wanted.album, duration: wanted.duration,
            square: wanted.youtubeId && !wanted.album ? false : undefined };
          let reason = 'Aucune correspondance Octave confirmée après vérification du titre, des artistes et de la durée.';
          const octave = await findRecording(original).catch(error => {
            reason = error instanceof Error ? error.message : String(error);
            return undefined;
          });
          const previous = found[position];
          const track = octave ? { ...octave, youtubeId: wanted.youtubeId ?? (previous && !isOctaveId(previous.id) ? previous.id : undefined) }
            : previous ?? (wanted.youtubeId ? original : await match(wanted).catch(error => {
              reason += ' ' + (error instanceof Error ? error.message : String(error));
              return undefined;
            }));
          const now = Date.now();
          const earlier = journal.get(position);
          journal.set(position, {
            id: JSON.stringify([playlist.name, playlist.source, wanted.title, wanted.artist, wanted.album, wanted.duration]),
            playlist: playlist.name, source: playlist.source,
            track: { ...wanted, youtubeId: wanted.youtubeId ?? (track && !isOctaveId(track.id) ? track.id : undefined) },
            firstAttempt: earlier?.firstAttempt ?? now, lastAttempt: now, attempts: (earlier?.attempts ?? 0) + 1,
            status: octave ? 'resolved' : track ? 'youtube' : 'unresolved', reason: octave ? 'Correspondance Octave confirmée.' : reason,
            recording: track,
          });
          found[position] = track;
          if (!verifying) progress.processed++;
          if (track && !previous) progress.matched++;
          progress.missing = found.flatMap((track, index) => !track && journal.has(index) ? [playlist.tracks[index]] : []);
          if (verifying || progress.processed % 5 === 0 || progress.processed === progress.total) options.emit({ ...progress });
        }
      };
      await Promise.all(Array.from({ length: width }, worker));
    };
    await searchAll(playlist.tracks.map((_, i) => i), options.width, false);
    // Vérification : seconde recherche, deux à la fois, des titres pas encore trouvés.
    const missing = found.flatMap((track, i) => track && isOctaveId(track.id) ? [] : journal.has(i) ? [i] : []);
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
      youtubeId = playlist.existingYoutubeId;
      if (!youtubeId) {
        const ids = new Set<string>();
        for (const track of tracks) {
          if (options.cancelled()) break;
          const id = track.youtubeId ?? (isOctaveId(track.id) ? (await findYouTubeRecording(track).catch(() => undefined))?.id : track.id);
          if (id) ids.add(id);
        }
        if (ids.size && !options.cancelled()) youtubeId = await yt.createAccountPlaylist(playlist.name, [...ids]).catch(() => undefined);
      }
    }
    try {
      await options.saveJournal([...journal.values()]);
    } catch (error) {
      progress.journalError = 'Journal non enregistré. ' + (error instanceof Error ? error.message : String(error));
    }
    results.push({ name: playlist.name, tracks, youtubeId, missing: progress.missing.length });
    options.emit({ ...progress, done: true, playlistId: youtubeId });
    await options.saveMatches(savedMatches()).catch(() => undefined);
    if (options.cancelled()) break;
  }
  return results;
}
