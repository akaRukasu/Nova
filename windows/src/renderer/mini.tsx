// Mini lecteur (PC) : petite fenêtre toujours au premier plan. Elle affiche l'état de la lecture et envoie
// les commandes à la fenêtre principale, cachée, où la musique continue.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Icon } from './components/icons';

interface MiniState {
  track?: { id: string; title: string; artist: string; artworkURL?: string } | null;
  playing?: boolean;
  time?: number;
  duration?: number;
}

const send = (action: string, value?: number) => void window.nova.invoke('mini:command', { action, value });

function MiniPlayer() {
  const [state, setState] = useState<MiniState>({});
  const [now, setNow] = useState(() => Date.now());
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
    const onKey = (e: KeyboardEvent) => { if (e.code === 'Space') { e.preventDefault(); send('toggle'); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const track = state.track;
  const duration = state.duration ?? 0;
  const time = Math.min(duration || Infinity, (state.time ?? 0) + (state.playing ? (now - receivedAt.current) / 1000 : 0));
  const artwork = track?.artworkURL?.replace(/=w\d+-h\d+/, '=w160-h160');
  return (
    <div className="mini">
      {artwork ? <img className="mini-art" src={artwork} alt="" /> : <div className="mini-art placeholder"><Icon name="music" size={24} /></div>}
      <div className="mini-text">
        <div className="mini-title">{track?.title ?? 'Nova'}</div>
        <div className="mini-artist">{track?.artist ?? 'Aucun titre en cours'}</div>
      </div>
      <div className="mini-controls">
        <button onClick={() => send('previous')} aria-label="Précédent"><Icon name="previous" size={16} /></button>
        <button className="mini-play" onClick={() => send(state.playing ? 'pause' : 'play')} aria-label={state.playing ? 'Pause' : 'Lecture'}>
          <Icon name={state.playing ? 'pause' : 'play'} size={20} />
        </button>
        <button onClick={() => send('next')} aria-label="Suivant"><Icon name="next" size={16} /></button>
        <button className="mini-expand" onClick={() => void window.nova.invoke('mini:close')} aria-label="Revenir au grand lecteur" title="Revenir au grand lecteur">
          <Icon name="expand" size={15} />
        </button>
      </div>
      <div className="mini-progress" onClick={(e) => {
        if (!duration) return;
        const box = e.currentTarget.getBoundingClientRect();
        send('seek', ((e.clientX - box.left) / box.width) * duration);
      }}>
        <div style={{ width: `${duration ? Math.min(100, (time / duration) * 100) : 0}%` }} />
      </div>
    </div>
  );
}

export function renderMini(container: HTMLElement) {
  document.documentElement.classList.add('mini-window');
  // Thème choisi dans Nova (clair, sombre ou comme Windows).
  window.nova.on('mini:theme', (theme: string) => { document.documentElement.dataset.theme = theme; });
  createRoot(container).render(<MiniPlayer />);
}
