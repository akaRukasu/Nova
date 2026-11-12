// Palette de commandes (Ctrl+K) : aller partout, lancer une playlist ou un titre, piloter la lecture, au clavier.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Track } from '../../shared/types';
import { isAndroid } from '../lib/api';
import { library, songs } from '../lib/library';
import { player, playerState } from '../lib/player';
import { open, root, type Route } from '../lib/router';
import { Store, useStore } from '../lib/store';
import { Artwork } from './Artwork';
import { Icon } from './icons';
import { nowPlayingOpen } from './Player';

export const commandPalette = new Store(false);

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon?: string;
  track?: Track;
  run: () => void;
}

const normalize = (text: string) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

const pages: [string, string, Route][] = [
  ['Accueil', 'home', { name: 'home' }],
  ['Nouveautés', 'grid', { name: 'explore' }],
  ['Mes mix', 'sparkles', { name: 'mix', kind: 'discovery' }],
  ['Concerts', 'ticket', { name: 'concerts' }],
  ['Jam', 'jam', { name: 'jam' }],
  ['Ajouts récents', 'clock', { name: 'recent' }],
  ['Morceaux', 'music', { name: 'songs' }],
  ['Titres likés', 'heart', { name: 'liked' }],
  ['Albums et artistes', 'album', { name: 'albums' }],
  ['Historique', 'clock', { name: 'history' }],
  ['Importer', 'import', { name: 'import' }],
  ['Réglages', 'settings', { name: 'settings' }],
];

function commands(query: string): Command[] {
  const close = () => commandPalette.set(false);
  const q = normalize(query.trim());
  const matches = (text: string) => !q || normalize(text).includes(q);
  const state = playerState.get();
  const actions: Command[] = [
    { id: 'toggle', label: state.playing ? 'Pause' : 'Lecture', icon: state.playing ? 'pause' : 'play', hint: 'Espace', run: () => player.toggle() },
    { id: 'next', label: 'Titre suivant', icon: 'next', hint: 'Ctrl+→', run: () => player.next() },
    { id: 'previous', label: 'Titre précédent', icon: 'previous', hint: 'Ctrl+←', run: () => player.previous() },
    { id: 'shuffle', label: state.shuffled ? 'Désactiver l’aléatoire' : 'Lecture aléatoire', icon: 'shuffle', run: () => player.toggleShuffle() },
    { id: 'lyrics', label: 'Paroles', icon: 'lyrics', hint: 'Ctrl+L', run: () => nowPlayingOpen.set('lyrics') },
    { id: 'queue', label: 'File d’attente', icon: 'list', run: () => nowPlayingOpen.set('queue') },
    ...(isAndroid ? [] : [
      { id: 'mini', label: 'Mini lecteur', icon: 'mini', run: () => void window.nova.invoke('mini:open') },
      { id: 'sidebar', label: 'Afficher / masquer la barre latérale', icon: 'sidebar', hint: 'Ctrl+B', run: () => window.dispatchEvent(new Event('nova:toggle-sidebar')) },
    ]),
  ].map((action) => ({ ...action, hint: action.hint ?? 'Action' }));
  const navigation: Command[] = pages.map(([label, icon, route]) => ({ id: `page-${label}`, label, icon, hint: 'Aller à', run: () => root(route) }));
  const lib = library.get();
  const playlists: Command[] = [
    ...lib.playlists.map((p) => ({ id: `pl-${p.id}`, label: p.name, icon: 'list', hint: `Playlist · ${p.tracks.length} titres`, run: () => open({ name: 'playlist', id: p.id }) })),
    ...(lib.shared ?? []).map((s) => ({ id: `sh-${s.id}`, label: s.title, icon: 'jam', hint: 'Playlist partagée',
      run: () => open({ name: 'collection', collection: { id: `VL${s.id}`, kind: 'playlist', title: s.title, artwork: s.artwork } }) })),
  ];
  const tracks: Command[] = q.length >= 2
    ? songs(lib).filter((t) => matches(`${t.title} ${t.artist} ${t.album ?? ''}`)).slice(0, 6)
      .map((track) => ({ id: `t-${track.id}`, label: track.title, hint: track.artist, track, run: () => player.play([track]) }))
    : [];
  const all = [...actions, ...navigation, ...playlists].filter((c) => matches(c.label));
  // Les commandes dont le nom commence par la recherche d'abord.
  all.sort((a, b) => Number(!normalize(a.label).startsWith(q)) - Number(!normalize(b.label).startsWith(q)));
  const result = [...all.slice(0, 8), ...tracks];
  if (q) result.push({ id: 'search', label: `Rechercher « ${query.trim()} »`, icon: 'search', hint: 'YouTube Music', run: () => open({ name: 'search', query: query.trim() }) });
  return result.map((c) => ({ ...c, run: () => { close(); c.run(); } }));
}

export function CommandPalette() {
  const visible = useStore(commandPalette);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => (visible ? commands(query) : []), [visible, query]);

  useEffect(() => {
    if (!visible) return;
    setQuery('');
    setSelected(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [visible]);
  useEffect(() => setSelected(0), [query]);

  if (!visible) return null;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') commandPalette.set(false);
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((i) => Math.min(list.length - 1, i + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((i) => Math.max(0, i - 1)); }
    if (e.key === 'Enter') list[selected]?.run();
  };
  return (
    <div className="palette-backdrop" onMouseDown={() => commandPalette.set(false)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Aller à, lancer, chercher…" />
          <kbd>Échap</kbd>
        </div>
        <div className="palette-list">
          {list.map((command, i) => (
            <button key={command.id} className={`palette-item ${i === selected ? 'selected' : ''}`} onMouseEnter={() => setSelected(i)} onClick={command.run}>
              {command.track ? <Artwork track={command.track} size={28} radius={5} /> : <span className="palette-icon"><Icon name={command.icon ?? 'music'} size={16} /></span>}
              <span className="palette-label">{command.label}</span>
              {command.hint && <span className="palette-hint">{command.hint}</span>}
            </button>
          ))}
          {!list.length && <p className="muted palette-empty">Aucun résultat</p>}
        </div>
      </div>
    </div>
  );
}
