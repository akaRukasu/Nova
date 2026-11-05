// Fenêtre de Nova : barre latérale, page en cours, barre de lecture, lecteur plein écran.
import { useEffect } from 'react';
import { Icon } from './components/icons';
import { Overlays } from './components/menus';
import { NowPlaying, PlayerBar, nowPlayingOpen } from './components/Player';
import { Sidebar } from './components/Sidebar';
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
    <div className="app">
      <div className="titlebar">
        <button className="icon-button" disabled={nav.position === 0} onClick={back} aria-label="Retour"><Icon name="back" size={18} /></button>
        <button className="icon-button" disabled={nav.position >= nav.stack.length - 1} onClick={forward} aria-label="Avancer"><Icon name="forward" size={18} /></button>
      </div>
      <Sidebar />
      <main key={nav.position}><Page route={route} /></main>
      <PlayerBar />
      <NowPlaying />
      <Overlays />
    </div>
  );
}
