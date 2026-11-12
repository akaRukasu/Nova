// Ambiance : l'interface prend les couleurs de la pochette du titre en cours (fond lumineux, capsule de lecture,
// accents), et un halo bat au tempo du titre quand il est connu (analyse AutoMix).
import { savedAnalysis } from './analysis';
import { api } from './api';
import { currentTrack, playerState, timeState } from './player';

const root = document.documentElement;
let shownFor = '';

function setColor(name: string, [r, g, b]: [number, number, number]) {
  root.style.setProperty(`--${name}-r`, String(r));
  root.style.setProperty(`--${name}-g`, String(g));
  root.style.setProperty(`--${name}-b`, String(b));
}

async function refresh() {
  const track = currentTrack();
  const { playing } = playerState.get();
  // Halo au tempo, calé sur la grille des temps du titre.
  const analysis = track ? savedAnalysis(track.id) : undefined;
  if (playing && analysis?.bpm) {
    const period = 60 / analysis.bpm;
    const offset = ((timeState.get().time - analysis.beatNearStart) % period + period) % period;
    root.style.setProperty('--beat', `${period.toFixed(3)}s`);
    root.style.setProperty('--beat-delay', `${(-offset).toFixed(3)}s`);
    root.classList.add('beating');
  } else {
    root.classList.remove('beating');
  }
  const art = track?.artwork;
  if (!art || art === shownFor) return;
  shownFor = art;
  const colors = await api.palette(art).catch(() => null);
  if (!colors || shownFor !== art) return;
  // Fond assombri (lisible en clair comme en sombre), accent vif.
  setColor('amb', colors.background);
  setColor('tint', colors.vivid);
  root.classList.add('ambient');
}

playerState.subscribe(() => void refresh());
// Le halo se recale de temps en temps (avance rapide, changement de position).
setInterval(() => void refresh(), 8000);
