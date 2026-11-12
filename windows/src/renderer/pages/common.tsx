// Éléments communs aux pages : chargement avec cache, titres, boutons Lecture / Aléatoire, listes de titres.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Track } from '../../shared/types';
import { Icon } from '../components/icons';
import { TrackRow, formatTime } from '../components/TrackRow';
import { showMenu, type MenuItem } from '../components/menus';
import { player } from '../lib/player';

const pageCache = new Map<string, { value: unknown; at: number }>();

/** Affiche tout de suite la version déjà vue, puis la rafraîchit si elle a plus de `freshFor` ms. */
export function useCached<T>(key: string, load: () => Promise<T>, freshFor = 5 * 60_000) {
  const cached = pageCache.get(key) as { value: T; at: number } | undefined;
  const [data, setData] = useState<T | undefined>(cached?.value);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(!cached);

  const reload = useCallback(async (force = false) => {
    const hit = pageCache.get(key) as { value: T; at: number } | undefined;
    if (hit) setData(hit.value);
    if (hit && !force && Date.now() - hit.at < freshFor) { setLoading(false); return; }
    setLoading(!hit);
    try {
      const value = await load();
      pageCache.set(key, { value, at: Date.now() });
      setData(value);
      setError(undefined);
    } catch (e) {
      if (!hit) setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    } finally {
      setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    setData(pageCache.get(key)?.value as T | undefined);
    setError(undefined);
    void reload();
  }, [key]);
  return { data, error, loading, reload, setData };
}

export function Loading() {
  return <div className="center-state"><span className="spinner large" /></div>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  const offline = /fetch failed|ENOTFOUND|ECONNRE|ETIMEDOUT|network/i.test(message);
  message = offline ? 'Connexion à YouTube Music impossible. Vérifie ta connexion internet.' : message;
  return (
    <div className="center-state">
      <Icon name="radio" size={40} />
      <h3>Chargement impossible</h3>
      <p className="muted">{message}</p>
      {retry && <button className="button" onClick={retry}>Réessayer</button>}
    </div>
  );
}

export function Empty({ icon, title, text, children }: { icon: string; title: string; text?: string; children?: ReactNode }) {
  return (
    <div className="center-state">
      <Icon name={icon} size={44} />
      <h3>{title}</h3>
      {text && <p className="muted">{text}</p>}
      {children}
    </div>
  );
}

export function PageTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return <div className="page-title"><h1>{children}</h1>{actions && <div className="page-actions">{actions}</div>}</div>;
}

export function PlayShuffle({ tracks, playlist = false }: { tracks: Track[]; playlist?: boolean }) {
  const play = (shuffle: boolean) => {
    if (playlist) player.playPlaylist(tracks, 0, shuffle);
    else player.play(tracks, 0, shuffle);
  };
  return (
    <div className="play-shuffle">
      <button className="button" disabled={!tracks.length} onClick={() => play(false)}><Icon name="play" size={16} /> Lecture</button>
      <button className="button secondary" disabled={!tracks.length} onClick={() => play(true)}><Icon name="shuffle" size={16} /> Aléatoire</button>
    </div>
  );
}

export function TrackList({ tracks, numbered, showArtwork = true, menuFor, limit, playlist = false }: {
  tracks: Track[]; numbered?: boolean; showArtwork?: boolean; menuFor?: (track: Track, index: number) => MenuItem[]; limit?: number; playlist?: boolean;
}) {
  const [shown, setShown] = useState(limit ?? 300);
  const visible = tracks.slice(0, shown);
  const total = tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  return (
    <div className="track-list">
      {visible.map((track, i) => (
        <TrackRow key={`${track.id}-${i}`} track={track} index={i} showArtwork={showArtwork && !numbered}
          onPlay={() => playlist ? player.playPlaylist(tracks, i) : player.play(tracks, i)} extraMenu={menuFor?.(track, i)} />
      ))}
      {tracks.length > shown && <button className="button secondary more-button" onClick={() => setShown(shown + 300)}>Afficher plus ({tracks.length - shown})</button>}
      <p className="muted list-footer">{tracks.length} titre{tracks.length > 1 ? 's' : ''}{total ? ` · ${formatTime(total)}` : ''}</p>
    </div>
  );
}

// MARK: Tri des listes (playlists, titres likés, playlists et albums YouTube)

export type TrackSortKey = 'manual' | 'title' | 'artist' | 'album' | 'duration' | 'mostPlayed' | 'recentlyPlayed';
const sortLabels: Record<Exclude<TrackSortKey, 'manual'>, string> = {
  title: 'Titre', artist: 'Artiste', album: 'Album', duration: 'Durée', mostPlayed: 'Les plus écoutés', recentlyPlayed: 'Écoutés récemment',
};

/** Tri mémorisé pour une liste. */
export function useTrackSort(key: string) {
  const storageKey = `sort.${key}`;
  const read = () => {
    const [sort, reversed] = (localStorage.getItem(storageKey) ?? 'manual').split('|');
    return { sort: (sort || 'manual') as TrackSortKey, reversed: reversed === 'rev' };
  };
  const [state, setState] = useState(read);
  useEffect(() => setState(read()), [storageKey]);
  const change = (sort: TrackSortKey, reversed: boolean) => {
    localStorage.setItem(storageKey, sort + (reversed ? '|rev' : ''));
    setState({ sort, reversed });
  };
  return { ...state, manual: state.sort === 'manual' && !state.reversed, change };
}

/** Positions des titres dans l'ordre choisi (à égalité, l'ordre de la liste est gardé). */
export function sortOrder(tracks: Track[], sort: TrackSortKey, reversed: boolean, stats: Record<string, { playCount: number; lastPlayed?: number }>) {
  const positions = tracks.map((_, i) => i);
  const text = (a: string | undefined, b: string | undefined) => {
    if (a && b) return a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true });
    return a ? -1 : b ? 1 : 0;
  };
  const compare: Record<TrackSortKey, (a: Track, b: Track) => number> = {
    manual: () => 0,
    title: (a, b) => text(a.title, b.title),
    artist: (a, b) => text(a.artist, b.artist) || text(a.album, b.album),
    album: (a, b) => text(a.album, b.album),
    duration: (a, b) => (a.duration ?? Infinity) - (b.duration ?? Infinity),
    mostPlayed: (a, b) => (stats[b.id]?.playCount ?? 0) - (stats[a.id]?.playCount ?? 0),
    recentlyPlayed: (a, b) => (stats[b.id]?.lastPlayed ?? 0) - (stats[a.id]?.lastPlayed ?? 0),
  };
  positions.sort((i, j) => compare[sort](tracks[i], tracks[j]) || i - j);
  return reversed ? positions.reverse() : positions;
}

/** Bouton « Trier ». */
export function SortButton({ state, manualLabel = 'Ordre de la playlist' }: { state: ReturnType<typeof useTrackSort>; manualLabel?: string }) {
  const option = (sort: TrackSortKey, label: string): MenuItem => ({
    label, icon: state.sort === sort ? 'check' : undefined, action: () => state.change(sort, state.reversed),
  });
  return (
    <button className={`button secondary ${state.manual ? '' : 'accent-text'}`} onClick={(e) => showMenu(e, [
      option('manual', manualLabel),
      ...(Object.entries(sortLabels) as [TrackSortKey, string][]).map(([sort, label]) => option(sort, label)),
      { label: '', separator: true },
      { label: 'Ordre inversé', icon: state.reversed ? 'check' : undefined, action: () => state.change(state.sort, !state.reversed) },
    ])}>
      <Icon name="sort" size={16} /> {state.sort === 'manual' ? 'Trier' : sortLabels[state.sort]}{state.reversed ? ' ↓' : ''}
    </button>
  );
}
