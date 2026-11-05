// Pochette : vraie pochette carrée en HD ; pour un clip sans pochette, Nova la cherche
// (version audio, album), sinon la grande miniature vidéo, recadrée au centre.
import { useEffect, useState } from 'react';
import type { Track } from '../../shared/types';
import { api } from '../lib/api';
import { Icon } from './icons';

const found = new Map<string, string | null>(JSON.parse(localStorage.getItem('artworks') ?? '[]'));
const waiting: (() => void)[] = [];
let running = 0;

function persist() {
  localStorage.setItem('artworks', JSON.stringify([...found].slice(-3000)));
}

/** Trois recherches à la fois au plus. */
async function resolve(id: string): Promise<string | null> {
  if (found.has(id)) return found.get(id)!;
  if (running >= 3) await new Promise<void>((resume) => waiting.push(resume));
  running++;
  try {
    const url = (await api.squareArtwork(id).catch(() => undefined)) ?? null;
    found.set(id, url);
    persist();
    return url;
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export function sized(url: string | undefined, pixels: number) {
  if (!url) return url;
  return /googleusercontent|ggpht/.test(url) ? url.replace(/=w\d+-h\d+/, `=w${pixels}-h${pixels}`).replace(/=s\d+/, `=s${pixels}`) : url;
}

export function trackArtwork(track: Track | undefined, pixels: number): string | undefined {
  if (!track) return undefined;
  if (track.square || /googleusercontent|ggpht/.test(track.artwork ?? '')) return sized(track.artwork, pixels);
  const resolved = found.get(track.id);
  if (resolved) return sized(resolved, pixels);
  return `https://i.ytimg.com/vi/${track.id}/${pixels > 300 ? 'hq720' : 'mqdefault'}.jpg`;
}

export function Artwork({ track, url, size, round, radius = 8, className }: {
  track?: Track; url?: string; size: number; round?: boolean; radius?: number; className?: string;
}) {
  const pixels = Math.min(1200, Math.round(size * (window.devicePixelRatio || 1)));
  const [src, setSrc] = useState(() => (track ? trackArtwork(track, pixels) : sized(url, pixels)));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    setSrc(track ? trackArtwork(track, pixels) : sized(url, pixels));
    if (track && !track.square && !/googleusercontent|ggpht/.test(track.artwork ?? '') && !found.has(track.id)) {
      let alive = true;
      void resolve(track.id).then((hd) => { if (alive && hd) setSrc(sized(hd, pixels)); });
      return () => { alive = false; };
    }
  }, [track?.id, track?.artwork, url, pixels]);

  const style = { width: size, height: size, borderRadius: round ? '50%' : radius };
  if (!src || failed) {
    return <div className={`artwork placeholder ${className ?? ''}`} style={style}><Icon name="music" size={Math.max(16, size / 4)} /></div>;
  }
  return (
    <img className={`artwork ${className ?? ''}`} style={style} src={src} alt="" loading="lazy" draggable={false}
      onError={() => {
        if (track && src.includes('hq720')) setSrc(`https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`);
        else setFailed(true);
      }} />
  );
}
