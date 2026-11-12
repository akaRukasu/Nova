// Mini lecteur (PC) : petite fenêtre toujours au premier plan. Elle affiche l'état de la lecture et envoie
// les commandes à la fenêtre principale, cachée, où la musique continue.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { sizedArtwork } from '../shared/artwork';
import { Icon } from './components/icons';

interface MiniState {
  track?: { id: string; title: string; artist: string; artworkURL?: string } | null;
  playing?: boolean;
  loading?: boolean;
  time?: number;
  duration?: number;
  volume?: number;
  liked?: boolean;
  autoplay?: boolean;
  automix?: boolean;
}

const send = (action: string, value?: number) => void window.nova.invoke('mini:command', { action, value });

function MiniPlayer() {
  const [state, setState] = useState<MiniState>({});
  const [now, setNow] = useState(() => Date.now());
  const [dragging, setDragging] = useState<number | null>(null);
  const [brokenArtwork, setBrokenArtwork] = useState<string>();
  const receivedAt = useRef(Date.now());
  useEffect(() => window.nova.on('mini:state', (next: MiniState | null) => {
    if (!next) return;
    setState(next);
    receivedAt.current = Date.now();
  }), []);
  // Position prolongée entre deux mises à jour (une par seconde).
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLElement && e.target.closest('button, input'))) {
        e.preventDefault();
        send('toggle');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const track = state.track;
  const duration = state.duration ?? 0;
  const time = Math.min(duration, dragging ?? ((state.time ?? 0) + (state.playing ? Math.max(0, now - receivedAt.current) / 1000 : 0)));
  const resized = sizedArtwork(track?.artworkURL, Math.ceil(88 * window.devicePixelRatio));
  const artwork = resized === brokenArtwork ? track?.artworkURL : resized;
  const volume = state.volume ?? 0.8;
  const commitSeek = () => { if (dragging != null) send('seek', dragging); setDragging(null); };
  return (
    <div className="mini">
      {artwork && artwork !== brokenArtwork
        ? <img className="mini-art" src={artwork} alt="" onError={() => setBrokenArtwork(artwork)} />
        : <div className="mini-art placeholder"><Icon name="music" size={24} /></div>}
      <div className="mini-text">
        <div className="mini-title">{track?.title ?? 'Nova'}</div>
        <div className="mini-artist">{track?.artist ?? 'Aucun titre en cours'}</div>
      </div>
      <button className="mini-expand" onClick={() => void window.nova.invoke('mini:close')} aria-label="Revenir au grand lecteur" title="Revenir au grand lecteur">
        <Icon name="expand" size={18} />
      </button>
      <div className="mini-controls">
        <button disabled={!track} onClick={() => send('previous')} aria-label="Précédent" title="Précédent"><Icon name="previous" size={17} /></button>
        <button className="mini-play" disabled={!track} onClick={() => send('toggle')} aria-label={state.playing ? 'Pause' : 'Lecture'}>
          {state.loading ? <span className="spinner" /> : <Icon name={state.playing ? 'pause' : 'play'} size={21} />}
        </button>
        <button disabled={!track} onClick={() => send('next')} aria-label="Suivant" title="Suivant"><Icon name="next" size={17} /></button>
        <div className="mini-tools" role="group" aria-label="Options de lecture">
          <button disabled={!track} onClick={() => send('like')} aria-label="J’aime" title="J’aime" aria-pressed={!!state.liked}><Icon name="heart" size={18} solid={state.liked} /></button>
          <button disabled={!track} onClick={() => send('autoplay')} aria-label="AutoPlay" title="AutoPlay" aria-pressed={!!state.autoplay}><Icon name="infinity" size={19} /></button>
          <button disabled={!track} onClick={() => send('automix')} aria-label="AutoMix" title="AutoMix" aria-pressed={!!state.automix}><Icon name="mix" size={18} /></button>
          <button onClick={() => send('volume', volume > 0 ? 0 : 0.8)} aria-label={volume > 0 ? 'Couper le son' : 'Rétablir le son'}
            title={volume > 0 ? 'Couper le son' : 'Rétablir le son'}><Icon name={volume > 0 ? 'volume' : 'mute'} size={18} /></button>
        </div>
      </div>
      <input className="mini-progress" type="range" aria-label="Position dans le morceau" disabled={!duration}
        min={0} max={duration || 1} step={0.5} value={time}
        style={{ '--fill': `${duration ? time / duration * 100 : 0}%` } as React.CSSProperties}
        onChange={(event) => setDragging(Number(event.target.value))}
        onPointerUp={commitSeek} onPointerCancel={() => setDragging(null)} onKeyUp={commitSeek} />
    </div>
  );
}

export function renderMini(container: HTMLElement) {
  document.documentElement.classList.add('mini-window');
  // Thème choisi dans Nova (clair, sombre ou comme Windows).
  window.nova.on('mini:theme', (theme: string) => { document.documentElement.dataset.theme = theme; });
  createRoot(container).render(<MiniPlayer />);
}
