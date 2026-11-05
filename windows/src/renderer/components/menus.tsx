// Menu contextuel (clic droit ou « … »), boîte de saisie et notifications.
import { useEffect, useRef, useState } from 'react';
import type { Collection, Track } from '../../shared/types';
import { addToJam, jam } from '../lib/jam';
import {
  addToPlaylist, createPlaylist, isLiked, isSaved, library, notify, toast, toggleLike, toggleSaved,
} from '../lib/library';
import { player } from '../lib/player';
import { open } from '../lib/router';
import { Store, useStore } from '../lib/store';
import { Icon } from './icons';

export interface MenuItem {
  label: string;
  icon?: string;
  action?: () => void;
  submenu?: MenuItem[];
  danger?: boolean;
  separator?: boolean;
}

const menu = new Store<{ x: number; y: number; items: MenuItem[] } | null>(null);
const prompt = new Store<{ title: string; value: string; confirm: string; resolve: (value: string | null) => void } | null>(null);

export function showMenu(event: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[]) {
  event.preventDefault?.();
  event.stopPropagation?.();
  menu.set({ x: event.clientX, y: event.clientY, items });
}

export function ask(title: string, value = '', confirm = 'OK'): Promise<string | null> {
  return new Promise((resolve) => prompt.set({ title, value, confirm, resolve }));
}

export function playlistSubmenu(tracks: Track[]): MenuItem[] {
  return [
    { label: 'Nouvelle playlist…', icon: 'plus', action: async () => {
      const name = await ask('Nouvelle playlist', '', 'Créer');
      if (name) { createPlaylist(name, tracks); notify(`Playlist « ${name} » créée`); }
    } },
    ...library.get().playlists.slice(0, 30).map((p) => ({ label: p.name, action: () => addToPlaylist(p.id, tracks) })),
  ];
}

export function trackMenu(track: Track, extra: MenuItem[] = []): MenuItem[] {
  const liked = isLiked(track.id);
  const items: MenuItem[] = [];
  if (jam.get().role !== 'none') {
    items.push({ label: 'Ajouter au Jam', icon: 'jam', action: () => addToJam(track) },
      { label: 'Au Jam, juste après', icon: 'jam', action: () => addToJam(track, true) }, { label: '', separator: true });
  }
  items.push(
    { label: 'Lire ensuite', icon: 'list', action: () => { player.playNext(track); notify('Lu juste après'); } },
    { label: 'Ajouter à la file', icon: 'list', action: () => { player.enqueue([track]); notify('Ajouté à la file'); } },
    { label: 'Lancer la radio', icon: 'radio', action: () => player.startRadio(track) },
    { label: '', separator: true },
    { label: liked ? 'Je n’aime plus' : 'J’aime', icon: 'heart', action: () => toggleLike(track) },
    { label: 'Ajouter à une playlist', icon: 'plus', submenu: playlistSubmenu([track]) },
  );
  if (track.artistId || track.albumId) items.push({ label: '', separator: true });
  if (track.artistId) items.push({ label: 'Voir l’artiste', icon: 'mic', action: () => open({ name: 'artist', id: track.artistId!, title: track.artist }) });
  if (track.albumId) items.push({ label: 'Voir l’album', icon: 'album', action: () => open({ name: 'collection', collection: { id: track.albumId!, kind: 'album', title: track.album ?? '' } }) });
  items.push({ label: 'Copier le lien', icon: 'share', action: () => { void navigator.clipboard.writeText(`https://music.youtube.com/watch?v=${track.id}`); notify('Lien copié'); } });
  return [...items, ...extra];
}

export function collectionMenu(collection: Collection): MenuItem[] {
  return [
    { label: isSaved(collection.id) ? 'Retirer de la bibliothèque' : 'Ajouter à la bibliothèque', icon: isSaved(collection.id) ? 'check' : 'plus',
      action: () => toggleSaved(collection) },
    { label: 'Copier le lien', icon: 'share', action: () => {
      const id = collection.id;
      const url = collection.kind === 'artist' ? `https://music.youtube.com/channel/${id}`
        : collection.kind === 'album' ? `https://music.youtube.com/browse/${id}` : `https://music.youtube.com/playlist?list=${id.replace(/^VL/, '')}`;
      void navigator.clipboard.writeText(url);
      notify('Lien copié');
    } },
  ];
}

function MenuList({ items, close }: { items: MenuItem[]; close: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  return (
    <div className="menu-list" role="menu">
      {items.map((item, i) => item.separator ? <div key={i} className="menu-separator" /> : (
        <div key={i} className={`menu-item ${item.danger ? 'danger' : ''}`} role="menuitem"
          onMouseEnter={() => setOpenSub(item.submenu ? i : null)}
          onClick={() => { if (item.action) { item.action(); close(); } }}>
          {item.icon && <Icon name={item.icon} size={16} />}
          <span>{item.label}</span>
          {item.submenu && <Icon name="forward" size={14} className="menu-arrow" />}
          {item.submenu && openSub === i && <div className="submenu"><MenuList items={item.submenu} close={close} /></div>}
        </div>
      ))}
    </div>
  );
}

export function Overlays() {
  const current = useStore(menu);
  const question = useStore(prompt);
  const message = useStore(toast);
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!current) return;
    const close = () => menu.set(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', close);
    };
  }, [current]);

  useEffect(() => { if (question) setValue(question.value); }, [question]);

  const finish = (result: string | null) => {
    question?.resolve(result);
    prompt.set(null);
  };

  const left = current ? Math.min(current.x, window.innerWidth - 260) : 0;
  const top = current ? Math.min(current.y, window.innerHeight - 40 - current.items.length * 34) : 0;
  return (
    <>
      {current && (
        <div ref={ref} className="context-menu" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
          <MenuList items={current.items} close={() => menu.set(null)} />
        </div>
      )}
      {question && (
        <div className="modal-backdrop" onMouseDown={() => finish(null)}>
          <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); finish(value.trim() || null); }}>
            <h3>{question.title}</h3>
            <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
            <div className="modal-buttons">
              <button type="button" className="button secondary" onClick={() => finish(null)}>Annuler</button>
              <button type="submit" className="button">{question.confirm}</button>
            </div>
          </form>
        </div>
      )}
      {message && <div className="toast">{message}</div>}
    </>
  );
}
