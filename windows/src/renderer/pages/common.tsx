// Éléments communs aux pages : chargement avec cache, titres, boutons Lecture / Aléatoire, listes de titres.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Track } from '../../shared/types';
import { Icon } from '../components/icons';
import { TrackRow, formatTime } from '../components/TrackRow';
import type { MenuItem } from '../components/menus';
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

export function PlayShuffle({ tracks }: { tracks: Track[] }) {
  return (
    <div className="play-shuffle">
      <button className="button" disabled={!tracks.length} onClick={() => player.play(tracks)}><Icon name="play" size={16} /> Lecture</button>
      <button className="button secondary" disabled={!tracks.length} onClick={() => player.play(tracks, 0, true)}><Icon name="shuffle" size={16} /> Aléatoire</button>
    </div>
  );
}

export function TrackList({ tracks, numbered, showArtwork = true, menuFor, limit }: {
  tracks: Track[]; numbered?: boolean; showArtwork?: boolean; menuFor?: (track: Track, index: number) => MenuItem[]; limit?: number;
}) {
  const [shown, setShown] = useState(limit ?? 300);
  const visible = tracks.slice(0, shown);
  const total = tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  return (
    <div className="track-list">
      {visible.map((track, i) => (
        <TrackRow key={`${track.id}-${i}`} track={track} index={i} showArtwork={showArtwork && !numbered}
          onPlay={() => player.play(tracks, i)} extraMenu={menuFor?.(track, i)} />
      ))}
      {tracks.length > shown && <button className="button secondary more-button" onClick={() => setShown(shown + 300)}>Afficher plus ({tracks.length - shown})</button>}
      <p className="muted list-footer">{tracks.length} titre{tracks.length > 1 ? 's' : ''}{total ? ` · ${formatTime(total)}` : ''}</p>
    </div>
  );
}
