import type { LibraryState, Track } from './types.js';

export interface HistoryChanges {
  clearedAt?: number;
  removed?: Record<string, number>;
}

export interface HistorySnapshot extends HistoryChanges {
  version: 1;
  entries: { track: Track; playedAt: number }[];
}

export function listeningHistory(state: LibraryState): HistorySnapshot {
  return {
    version: 1,
    ...state.historyChanges,
    entries: state.recents.map(track => ({ track, playedAt: state.stats[track.id]?.lastPlayed ?? 0 })),
  };
}

function timestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function mergeListeningHistory(state: LibraryState, incoming: HistorySnapshot): LibraryState {
  if (incoming?.version !== 1 || !Array.isArray(incoming.entries)) return state;
  const local = listeningHistory(state);
  const clearedAt = Math.max(timestamp(local.clearedAt), timestamp(incoming.clearedAt));
  const removed = new Map<string, number>();
  for (const source of [local.removed, incoming.removed]) {
    for (const [id, value] of Object.entries(source ?? {})) {
      const date = timestamp(value);
      if (date > clearedAt) removed.set(id, Math.max(date, removed.get(id) ?? 0));
    }
  }
  const entries = new Map<string, HistorySnapshot['entries'][number]>();
  for (const entry of [...local.entries, ...incoming.entries]) {
    const track = entry?.track;
    if (!track || typeof track.id !== 'string' || !track.id || typeof track.title !== 'string'
      || typeof track.artist !== 'string') continue;
    const date = timestamp(entry.playedAt);
    if ((clearedAt && date <= clearedAt) || (removed.has(track.id) && date <= removed.get(track.id)!)) continue;
    const previous = entries.get(track.id);
    if (!previous || previous.playedAt < date) entries.set(track.id, { track, playedAt: date });
  }
  const sorted = [...entries.values()].sort((a, b) => b.playedAt - a.playedAt
    || (a.track.id < b.track.id ? -1 : a.track.id > b.track.id ? 1 : 0)).slice(0, 1000);
  const stats = { ...state.stats };
  for (const { track, playedAt } of sorted) {
    const current = stats[track.id];
    if (!current || playedAt > (current.lastPlayed ?? 0)) {
      stats[track.id] = { playCount: current?.playCount ?? 1, lastPlayed: playedAt || undefined };
    }
  }
  return { ...state, recents: sorted.map(entry => entry.track), stats, historyChanges: {
    clearedAt: clearedAt || undefined,
    removed: Object.fromEntries(removed),
  } };
}
