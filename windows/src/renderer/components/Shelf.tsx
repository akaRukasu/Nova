// Étagères : carrousels de cartes, grilles de titres, listes, tuiles de catégories.
import { useRef } from 'react';
import type { Category, Collection, Item, Shelf, Track } from '../../shared/types';
import { api } from '../lib/api';
import { player } from '../lib/player';
import { open, routeForLink, type Route } from '../lib/router';
import { Artwork } from './Artwork';
import { Icon } from './icons';
import { collectionMenu, showMenu, trackMenu } from './menus';
import { TrackRow } from './TrackRow';

export function routeFor(collection: Collection): Route {
  if (collection.id.startsWith('local:')) return { name: 'playlist', id: collection.id.slice(6) };
  if (collection.kind === 'artist') return { name: 'artist', id: collection.id, title: collection.title };
  return { name: 'collection', collection };
}

async function playCollection(collection: Collection, shuffle = false) {
  if (collection.kind === 'artist') {
    const songs = await api.artistSongs(collection.id).catch(() => [] as Track[]);
    return player.play(songs.length ? songs : (await api.artist(collection.id)).tracks, 0, shuffle);
  }
  const page = await api.collection(collection);
  player.play(page.tracks, 0, shuffle);
}

export function Card({ item, width = 176, onPlay }: { item: Item; width?: number; onPlay?: (track: Track) => void }) {
  if (item.type === 'category') return <CategoryTile category={item.category} />;
  if (item.type === 'track') {
    const track = item.track;
    return (
      <div className="card" style={{ width }} onContextMenu={(e) => showMenu(e, trackMenu(track))}>
        <button className="card-art" onClick={() => onPlay?.(track)}>
          <Artwork track={track} size={width} radius={10} />
          <span className="card-play"><Icon name="play" size={18} /></span>
        </button>
        <div className="card-title" title={track.title}>{track.title}</div>
        <div className="card-subtitle">{track.artist}</div>
      </div>
    );
  }
  const collection = item.collection;
  const round = collection.kind === 'artist';
  return (
    <div className={`card ${round ? 'round' : ''}`} style={{ width }} onContextMenu={(e) => showMenu(e, collectionMenu(collection))}>
      <div className="card-art" role="button" tabIndex={0} onClick={() => open(routeFor(collection))}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(routeFor(collection)); }}>
        <Artwork url={collection.artwork} size={width} radius={10} round={round} />
        {!round && (
          <button className="card-play" onClick={(e) => { e.stopPropagation(); void playCollection(collection); }} aria-label="Lire">
            <Icon name="play" size={18} />
          </button>
        )}
      </div>
      <div className="card-title link" onClick={() => open(routeFor(collection))} title={collection.title}>{collection.title}</div>
      {collection.subtitle && <div className="card-subtitle">{collection.subtitle}</div>}
    </div>
  );
}

const icons: [RegExp, string][] = [
  [/chill|calme|détente|relax|sommeil|sleep/i, 'moon'], [/sport|fitness|entra|workout/i, 'sparkles'],
  [/fête|party|soirée/i, 'sparkles'], [/amour|romance|love/i, 'heart'], [/concentr|focus|travail/i, 'clock'],
  [/hip|rap/i, 'mic'], [/classement|charts|top/i, 'list'], [/nouveaut|new/i, 'sparkles'],
];

export function CategoryTile({ category, height = 88 }: { category: Category; height?: number }) {
  const icon = icons.find(([pattern]) => pattern.test(category.title))?.[1] ?? 'music';
  return (
    <button className="category" style={{ background: `linear-gradient(135deg, ${category.color}, ${category.color}bb)`, height }}
      onClick={() => open({ name: 'browse', title: category.title, link: { browseId: category.browseId, params: category.params } })}>
      <span>{category.title}</span>
      <Icon name={icon} size={30} className="category-icon" />
    </button>
  );
}

export function ShelfView({ shelf, onPlay, limit = 6, ranked, moreRoute }: {
  shelf: Shelf; onPlay?: (track: Track, tracks: Track[]) => void; limit?: number; ranked?: boolean; moreRoute?: Route;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const tracks = shelf.items.flatMap((i) => (i.type === 'track' ? [i.track] : []));
  const play = (track: Track) => (onPlay ? onPlay(track, tracks) : player.play(tracks, tracks.indexOf(track)));
  const target = moreRoute ?? (shelf.more ? routeForLink(shelf.more, shelf.title) : undefined);
  const scroll = (direction: number) => scroller.current?.scrollBy({ left: direction * scroller.current.clientWidth * 0.8, behavior: 'smooth' });
  const allCategories = shelf.items.every((i) => i.type === 'category');

  return (
    <section className="shelf">
      {(shelf.title || shelf.layout !== 'list') && (
        <header className="shelf-header">
          <h2 className={target ? 'link' : ''} onClick={() => target && open(target)}>
            {shelf.title}{target && <Icon name="forward" size={18} />}
          </h2>
          {shelf.layout !== 'list' && (
            <div className="scroll-buttons">
              <button onClick={() => scroll(-1)} aria-label="Précédent"><Icon name="back" size={16} /></button>
              <button onClick={() => scroll(1)} aria-label="Suivant"><Icon name="forward" size={16} /></button>
            </div>
          )}
        </header>
      )}
      {shelf.layout === 'list' && (
        <div className="rows">
          {shelf.items.slice(0, limit).map((item, i) => item.type === 'track'
            ? <TrackRow key={`${item.track.id}-${i}`} track={item.track} onPlay={() => play(item.track)} rank={ranked ? i : undefined} />
            : <div key={i} className="collection-row"><Card item={item} width={56} /></div>)}
        </div>
      )}
      {shelf.layout === 'grid' && (
        <div className="row-grid" ref={scroller}>
          {shelf.items.map((item, i) => item.type === 'track'
            ? <div className="grid-cell" key={`${item.track.id}-${i}`}><TrackRow track={item.track} onPlay={() => play(item.track)} showAlbum={false} /></div>
            : <div className="grid-cell" key={i}><Card item={item} width={56} /></div>)}
        </div>
      )}
      {shelf.layout === 'cards' && (
        <div className={`carousel ${allCategories ? 'categories' : ''}`} ref={scroller}>
          {shelf.items.map((item, i) => <Card key={i} item={item} onPlay={play} />)}
        </div>
      )}
    </section>
  );
}

/** Grille de tuiles sur toute la largeur (humeurs et genres). */
export function CategoryGrid({ shelf }: { shelf: Shelf }) {
  return (
    <section className="shelf">
      {shelf.title && <header className="shelf-header"><h2>{shelf.title}</h2></header>}
      <div className="category-grid">
        {shelf.items.map((item, i) => item.type === 'category' && <CategoryTile key={i} category={item.category} />)}
      </div>
    </section>
  );
}

/** Grille de cartes sur toute la largeur. */
export function CardGrid({ items, onPlay }: { items: Item[]; onPlay?: (track: Track) => void }) {
  return (
    <div className="card-grid">
      {items.map((item, i) => <Card key={i} item={item} onPlay={onPlay} />)}
    </div>
  );
}
