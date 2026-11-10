// Fenêtre de Nova : barre latérale, page en cours, barre de lecture, lecteur plein écran.
import { useEffect, useState } from 'react';
import { Icon } from './components/icons';
import { dismissOverlay, Overlays } from './components/menus';
import { NowPlaying, PlayerBar, nowPlayingOpen } from './components/Player';
import { Sidebar } from './components/Sidebar';
import { isAndroid } from './lib/api';
import { player } from './lib/player';
import { back, currentRoute, forward, router, type Route } from './lib/router';
import { useStore } from './lib/store';
import { ArtistPage, CollectionPage } from './pages/Content';
import { BrowsePage, ExplorePage, HomePage, SearchPage } from './pages/Discover';
import {
  AlbumsPage, HistoryPage, LikedPage, RecentPage, SmartPlaylistPage, SongsPage, UserPlaylistPage, YouTubePlaylistsPage,
} from './pages/Library';
import { MixPage } from './pages/Mixes';
import { ConcertsPage, ImportPage, JamPage, SettingsPage } from './pages/Tools';

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'home': return <HomePage />;
    case 'explore': return <ExplorePage />;
    case 'search': return <SearchPage query={route.query} />;
    case 'browse': return <BrowsePage title={route.title} link={route.link} />;
    case 'artist': return <ArtistPage id={route.id} title={route.title} />;
    case 'collection': return <CollectionPage collection={route.collection} />;
    case 'playlist': return <UserPlaylistPage id={route.id} />;
    case 'smart': return <SmartPlaylistPage id={route.id} />;
    case 'songs': return <SongsPage />;
    case 'liked': return <LikedPage />;
    case 'history': return <HistoryPage />;
    case 'albums': return <AlbumsPage />;
    case 'recent': return <RecentPage />;
    case 'youtubePlaylists': return <YouTubePlaylistsPage />;
    case 'mix': return <MixPage kindId={route.kind} />;
    case 'import': return <ImportPage />;
    case 'concerts': return <ConcertsPage artist={route.artist} />;
    case 'jam': return <JamPage />;
    case 'settings': return <SettingsPage />;
  }
}

export function App() {
  const nav = useStore(router);
  const route = currentRoute();
  const [drawer, setDrawer] = useState(false);
  // Barre latérale masquée (bouton en haut à gauche, Ctrl+B) : choix mémorisé.
  const [sidebarHidden, setSidebarHidden] = useState(() => localStorage.getItem('sidebarHidden') === '1');
  const toggleSidebar = () => setSidebarHidden((hidden) => {
    localStorage.setItem('sidebarHidden', hidden ? '0' : '1');
    return !hidden;
  });
  useEffect(() => setDrawer(false), [nav.position]);

  // Android : bouton Retour (lecteur plein écran, menu, page précédente) et touches multimédia de la télécommande.
  useEffect(() => {
    if (!isAndroid) return;
    (window as any).__novaBack = () => {
      if (dismissOverlay()) return true;
      if (nowPlayingOpen.get()) { nowPlayingOpen.set(false); return true; }
      if (document.querySelector('.app.drawer-open')) { setDrawer(false); return true; }
      if (router.get().position > 0) { back(); return true; }
      return false;
    };
    const onMedia = (e: KeyboardEvent) => {
      if (e.key === 'MediaPlayPause' || e.key === 'MediaPlay' || e.key === 'MediaPause') { e.preventDefault(); player.toggle(); }
      if (e.key === 'MediaTrackNext' || e.key === 'MediaFastForward') { e.preventDefault(); player.next(); }
      if (e.key === 'MediaTrackPrevious' || e.key === 'MediaRewind') { e.preventDefault(); player.previous(); }
    };
    window.addEventListener('keydown', onMedia);
    return () => window.removeEventListener('keydown', onMedia);
  }, []);

  // Raccourcis : espace (lecture/pause), Alt+← / Alt+→ (navigation), Ctrl+→ / Ctrl+← (titre suivant/précédent).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (e.code === 'Space' && !typing) { e.preventDefault(); player.toggle(); }
      if (e.altKey && e.key === 'ArrowLeft') back();
      if (e.altKey && e.key === 'ArrowRight') forward();
      if (e.ctrlKey && e.key === 'ArrowRight') player.next();
      if (e.ctrlKey && e.key === 'ArrowLeft') player.previous();
      if (e.ctrlKey && e.key.toLowerCase() === 'l') nowPlayingOpen.set(nowPlayingOpen.get() === 'lyrics' ? false : 'lyrics');
      if (e.ctrlKey && e.key.toLowerCase() === 'b' && !typing) { e.preventDefault(); toggleSidebar(); }
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) back();
      if (e.button === 4) forward();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
    };
  }, []);

  return (
    <div className={`app ${drawer ? 'drawer-open' : ''} ${sidebarHidden ? 'sidebar-hidden' : ''}`}>
      <div className="titlebar">
        <button className="icon-button menu-button" onClick={() => setDrawer(!drawer)} aria-label="Menu"><Icon name="list" size={20} /></button>
        <button className="icon-button sidebar-toggle" onClick={toggleSidebar} aria-label={sidebarHidden ? 'Afficher la barre latérale' : 'Masquer la barre latérale'}
          title={`${sidebarHidden ? 'Afficher' : 'Masquer'} la barre latérale (Ctrl+B)`}><Icon name="sidebar" size={18} /></button>
        <button className="icon-button" disabled={nav.position === 0} onClick={back} aria-label="Retour"><Icon name="back" size={18} /></button>
        <button className="icon-button" disabled={nav.position >= nav.stack.length - 1} onClick={forward} aria-label="Avancer"><Icon name="forward" size={18} /></button>
      </div>
      <Sidebar />
      <div className="drawer-scrim" onClick={() => setDrawer(false)} />
      <main key={nav.position}><Page route={route} /></main>
      <PlayerBar />
      <NowPlaying />
      <Overlays />
    </div>
  );
}
