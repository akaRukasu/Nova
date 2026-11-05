// Barre latérale, comme Apple Music pour Windows : recherche, rubriques, bibliothèque, playlists.
import { useState } from 'react';
import { account, createPlaylist, createShared, joinShared, library, notify, removeShared, sharedURL } from '../lib/library';
import { api, isAndroid } from '../lib/api';
import { currentRoute, open, root, router, type Route } from '../lib/router';
import { useStore } from '../lib/store';
import { Icon } from './icons';
import { ask, showMenu } from './menus';
import { deletePlaylist, renamePlaylist, saveSmartPlaylist } from '../lib/library';
import { newSmartPlaylist } from '../pages/Library';

function Entry({ route, icon, label, active }: { route: Route; icon: string; label: string; active: boolean }) {
  return (
    <button className={`side-entry ${active ? 'active' : ''}`} onClick={() => root(route)}>
      <Icon name={icon} size={18} /><span>{label}</span>
    </button>
  );
}

export function Sidebar() {
  useStore(router);
  const state = useStore(library);
  const user = useStore(account);
  const route = currentRoute();
  const [query, setQuery] = useState('');
  const is = (name: Route['name'], id?: string) => route.name === name && (!id || ('id' in route && route.id === id));

  return (
    <aside className="sidebar">
      <div className="brand"><span className="logo">♪</span> Nova</div>
      <form className="side-search" onSubmit={(e) => { e.preventDefault(); if (query.trim()) open({ name: 'search', query: query.trim() }); }}>
        <Icon name="search" size={16} />
        <input placeholder="Rechercher" value={query} onChange={(e) => setQuery(e.target.value)}
          onFocus={() => route.name !== 'search' && open({ name: 'search' })} />
      </form>
      <nav>
        <Entry route={{ name: 'home' }} icon="home" label="Accueil" active={is('home')} />
        <Entry route={{ name: 'explore' }} icon="grid" label="Nouveautés" active={is('explore')} />
        <Entry route={{ name: 'mix', kind: 'discovery' }} icon="sparkles" label="Mes mix" active={is('mix')} />
        <Entry route={{ name: 'concerts' }} icon="ticket" label="Concerts" active={is('concerts')} />
        {!isAndroid && <Entry route={{ name: 'jam' }} icon="jam" label="Jam" active={is('jam')} />}
      </nav>
      <div className="side-title">Bibliothèque</div>
      <nav>
        <Entry route={{ name: 'recent' }} icon="clock" label="Ajouts récents" active={is('recent')} />
        <Entry route={{ name: 'songs' }} icon="music" label="Morceaux" active={is('songs')} />
        <Entry route={{ name: 'liked' }} icon="heart" label="Titres likés" active={is('liked')} />
        <Entry route={{ name: 'albums' }} icon="album" label="Albums et artistes" active={is('albums')} />
        <Entry route={{ name: 'history' }} icon="clock" label="Historique" active={is('history')} />
        {user.signedIn && <Entry route={{ name: 'youtubePlaylists' }} icon="radio" label="Playlists YouTube" active={is('youtubePlaylists')} />}
      </nav>
      <div className="side-title">
        Playlists
        <button className="icon-button" aria-label="Nouvelle playlist" onClick={(e) => showMenu(e, [
          { label: 'Nouvelle playlist…', icon: 'list', action: async () => {
            const name = await ask('Nouvelle playlist', '', 'Créer');
            if (name) { const created = createPlaylist(name); open({ name: 'playlist', id: created.id }); }
          } },
          { label: 'Nouvelle playlist intelligente', icon: 'smart', action: () => {
            const created = newSmartPlaylist();
            saveSmartPlaylist(created);
            open({ name: 'smart', id: created.id });
          } },
        ])}><Icon name="plus" size={16} /></button>
      </div>
      <div className="side-title">
        Playlists partagées
        <button className="icon-button" aria-label="Playlist partagée" onClick={(e) => showMenu(e, user.signedIn ? [
          { label: 'Nouvelle playlist partagée…', icon: 'jam', action: async () => {
            const name = await ask('Nouvelle playlist partagée', '', 'Créer');
            if (!name) return;
            const entry = await createShared(name).catch(() => undefined);
            if (!entry) return notify('Création impossible : vérifie ta connexion au compte YouTube.');
            open({ name: 'collection', collection: { id: `VL${entry.id}`, kind: 'playlist', title: entry.title } });
            notify('Créée sur ton compte YouTube : active « Collaborer » dans YouTube Music pour inviter tes amis');
          } },
          { label: 'Rejoindre avec un lien d’invitation…', icon: 'share', action: async () => {
            const link = await ask('Colle le lien d’invitation reçu', '', 'Rejoindre');
            if (!link) return;
            const entry = await joinShared(link);
            if (!entry) return notify('Ce lien ne contient pas de playlist YouTube.');
            notify('Accepte l’invitation dans la fenêtre YouTube Music : la playlist est dans tes playlists partagées');
          } },
        ] : [{ label: 'Connecte ton compte YouTube dans Réglages', icon: 'settings', action: () => root({ name: 'settings' }) }])}>
          <Icon name="plus" size={16} />
        </button>
      </div>
      <nav>
        {(state.shared ?? []).map((s) => (
          <div key={s.id} onContextMenu={(e) => showMenu(e, [
            { label: 'Ouvrir dans YouTube Music', icon: 'share', action: () => void api.openYouTube(sharedURL(s.id)) },
            { label: 'Retirer de Nova', icon: 'trash', danger: true, action: () => removeShared(s.id) },
          ])}>
            <Entry route={{ name: 'collection', collection: { id: `VL${s.id}`, kind: 'playlist', title: s.title, artwork: s.artwork } }}
              icon="jam" label={s.title} active={route.name === 'collection' && route.collection.id === `VL${s.id}`} />
          </div>
        ))}
      </nav>
      <nav className="side-playlists">
        {(state.smartPlaylists ?? []).map((p) => (
          <Entry key={p.id} route={{ name: 'smart', id: p.id }} icon="smart" label={p.name} active={is('smart', p.id)} />
        ))}
        {state.playlists.map((p) => (
          <div key={p.id} onContextMenu={(e) => showMenu(e, [
            { label: 'Renommer…', action: async () => { const name = await ask('Renommer la playlist', p.name, 'Renommer'); if (name) renamePlaylist(p.id, name); } },
            { label: 'Supprimer', icon: 'trash', danger: true, action: () => { deletePlaylist(p.id); notify(`« ${p.name} » supprimée`); } },
          ])}>
            <Entry route={{ name: 'playlist', id: p.id }} icon="list" label={p.name} active={is('playlist', p.id)} />
          </div>
        ))}
      </nav>
      <div className="side-footer">
        <button className="side-entry" onClick={() => root({ name: 'import' })}><Icon name="import" size={18} /><span>Importer</span></button>
        <button className="side-entry" onClick={() => root({ name: 'settings' })}>
          {user.photo ? <img className="avatar" src={user.photo} alt="" /> : <Icon name="settings" size={18} />}
          <span>{user.signedIn ? user.name || 'Compte YouTube' : 'Réglages'}</span>
        </button>
      </div>
    </aside>
  );
}
