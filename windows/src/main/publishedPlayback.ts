export interface PublishedPlayback {
  track: { id: string; title: string; artist: string; album: string; artwork?: string } | null;
  playing: boolean;
  loading?: boolean;
  position: number;
  duration: number;
}

export const idlePlayback: PublishedPlayback = { track: null, playing: false, position: 0, duration: 0 };

const string = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 512) : '';
const seconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

/** Ne jamais publier la file, les coordonnées du PC ou les chemins de fichiers audio. */
export function publishedPlayback(value: unknown): PublishedPlayback {
  if (!value || typeof value !== 'object') return idlePlayback;
  const state = value as { track?: Record<string, unknown>; playing?: boolean; loading?: boolean; time?: number; duration?: number; ad?: boolean };
  if (!state.track || !string(state.track.title) || state.ad) return idlePlayback;
  const artwork = string(state.track.artworkURL);
  const duration = seconds(state.duration) || seconds(state.track.duration);
  return {
    track: {
      id: string(state.track.id), title: string(state.track.title), artist: string(state.track.artist),
      album: string(state.track.album), artwork: artwork || undefined,
    },
    playing: state.playing === true && state.loading !== true,
    loading: state.loading === true,
    position: duration ? Math.min(duration, seconds(state.time)) : seconds(state.time),
    duration,
  };
}

export function publicArtwork(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    const domains = ['mzstatic.com', 'ytimg.com', 'ggpht.com', 'googleusercontent.com', 'tidal.com', 'dzcdn.net', 'qobuz.com', 'octavestreaming.com'];
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port
      && domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) return url.href;
  } catch { /* une ancienne pochette peut avoir une URL invalide */ }
}
