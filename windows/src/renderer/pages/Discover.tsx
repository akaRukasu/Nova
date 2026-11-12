// Accueil, Nouveautés, pages de catégories (humeurs et genres) et recherche.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Collection, Item, Shelf, Track } from '../../shared/types';
import { Artwork } from '../components/Artwork';
import { Icon } from '../components/icons';
import { CardGrid, CategoryGrid, ShelfView } from '../components/Shelf';
import { api, type SearchScope } from '../lib/api';
import { addSearch, clearSearches, library, songs } from '../lib/library';
import { player, playerState } from '../lib/player';
import { open } from '../lib/router';
import { useStore } from '../lib/store';
import { ErrorState, Loading, PageTitle, useCached } from './common';
import { mixKinds, MixCard } from './Mixes';

function greeting() {
  const hour = new Date().getHours();
  return hour < 6 ? 'Bonne nuit' : hour < 18 ? 'Bonjour' : 'Bonsoir';
}

/** « Tes artistes » (les plus écoutés) et « Tes playlists ». */
function personalShelves(): Shelf[] {
  const state = library.get();
  const counts = new Map<string, { count: number; track: Track }>();
  for (const track of state.recents) {
    if (!track.artistId) continue;
    const entry = counts.get(track.artistId) ?? { count: 0, track };
    entry.count += state.stats[track.id]?.playCount ?? 1;
    counts.set(track.artistId, entry);
  }
  const artists: Item[] = [...counts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 15)
    .map(([id, { track }]) => ({ type: 'collection', collection: { id, kind: 'artist', title: track.artist.split(/,| et /)[0], subtitle: 'Artiste', artwork: track.artwork } }));
  const playlists: Item[] = state.playlists.slice(0, 15).map((p) => ({
    type: 'collection',
    collection: { id: `local:${p.id}`, kind: 'playlist', title: p.name, subtitle: `${p.tracks.length} titres`, artwork: p.tracks[0]?.artwork } as Collection,
  }));
  const result: Shelf[] = [];
  if (artists.length >= 3) result.push({ id: 'my-artists', title: 'Tes artistes', items: artists, layout: 'cards' });
  if (playlists.length) result.push({ id: 'my-playlists', title: 'Tes playlists', items: playlists, layout: 'cards' });
  return result;
}

/** « Parce que tu as écouté… » : calculé une fois par visite, pas à chaque titre. */
function useDiscoverSections() {
  const [sections, setSections] = useState<{ seed: Track; shelves: Shelf[] }[]>([]);
  useEffect(() => {
    const state = library.get();
    const seen = new Set<string>();
    const seeds = [...state.recents.slice(0, 40)].sort((a, b) => (state.stats[b.id]?.playCount ?? 0) - (state.stats[a.id]?.playCount ?? 0))
      .concat(state.liked.slice(0, 20)).filter((t) => !seen.has(t.artist) && !!seen.add(t.artist)).slice(0, 3);
    let alive = true;
    void Promise.all(seeds.map(async (seed) => ({
      seed,
      shelves: (await api.related(seed.id).catch(() => [] as Shelf[]))
        .filter((s) => s.items.length && !/performance/i.test(s.title) && s.title !== seed.artist).slice(0, 2),
    }))).then((found) => alive && setSections(found.filter((s) => s.shelves.length)));
    return () => { alive = false; };
  }, []);
  return sections;
}

/** Grande carte « Reprendre l'écoute » : dernier titre écouté, pochette floutée en fond. */
function ResumeCard({ track }: { track: Track }) {
  const art = track.artwork?.replace(/=w\d+-h\d+/, '=w600-h600');
  return (
    <div className="resume-card">
      <div className="resume-bg" style={{ backgroundImage: art ? `url("${art}")` : undefined }} />
      <Artwork track={track} size={148} radius={10} />
      <div className="resume-info">
        <p className="eyebrow">Reprendre l’écoute</p>
        <h2>{track.title}</h2>
        <p className="resume-artist">{track.artist}</p>
        <div className="row-buttons">
          <button className="button" onClick={() => player.play([track])}><Icon name="play" size={16} /> Lecture</button>
          {track.artistId && <button className="button glass" onClick={() => open({ name: 'artist', id: track.artistId!, title: track.artist })}>Voir l’artiste</button>}
        </div>
      </div>
    </div>
  );
}

/** Écoutés récemment, sans répétition : un album écouté plusieurs fois n'apparaît qu'une fois. */
function recentItems(recents: Track[]): Item[] {
  const seen = new Set<string>();
  const items: Item[] = [];
  for (const track of recents) {
    if (items.length >= 20) break;
    if (track.albumId && track.album) {
      if (seen.has(track.albumId)) continue;
      seen.add(track.albumId);
      items.push({ type: 'collection', collection: { id: track.albumId, kind: 'album', title: track.album, subtitle: track.artist, artwork: track.artwork } });
    } else if (!seen.has(track.id)) {
      seen.add(track.id);
      items.push({ type: 'track', track });
    }
  }
  return items;
}

/** Sélection rapide : la grille de titres de YouTube Music, sinon la radio du dernier titre écouté. */
function useQuickPicks(seed: Track | undefined, youtube: Shelf | undefined) {
  const [shelf, setShelf] = useState<Shelf>();
  useEffect(() => {
    if (youtube || !seed) return;
    let alive = true;
    void api.radio(seed.id).then((tracks) => {
      if (!alive || tracks.length < 4) return;
      setShelf({ id: 'quick-picks', title: 'Sélection rapide', layout: 'grid', items: tracks.slice(1, 25).map((track) => ({ type: 'track', track })) });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [seed?.id, !!youtube]);
  return youtube ?? shelf;
}

export function HomePage() {
  const state = useStore(library);
  const { data, error, loading, reload, setData } = useCached('home', () => api.home());
  const discover = useDiscoverSections();
  const personal = useMemo(personalShelves, [state.playlists, state.recents.length > 0]);
  const loadingMore = useRef(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const mixes = useMemo(() => mixKinds(), [state.recents.length > 5, state.liked.length > 5]);

  useEffect(() => {
    const element = sentinel.current;
    if (!element) return;
    const observer = new IntersectionObserver(async ([entry]) => {
      if (!entry.isIntersecting || loadingMore.current || !data?.continuation) return;
      loadingMore.current = true;
      try {
        const more = await api.homeMore();
        const known = new Set(data.shelves.map((s) => s.title));
        setData({ shelves: [...data.shelves, ...more.shelves.filter((s) => !s.title || !known.has(s.title))], continuation: more.continuation });
      } catch {
        setData({ ...data, continuation: false });
      } finally {
        loadingMore.current = false;
      }
    }, { rootMargin: '600px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [data]);

  const all = data?.shelves ?? [];
  // Grille de titres de YouTube Music (« Sélection rapide ») mise en avant, juste après les mix.
  const youtubePicks = all.find((shelf) => shelf.layout === 'grid' && shelf.items.some((i) => i.type === 'track'));
  const quickPicks = useQuickPicks(state.recents[0], youtubePicks);
  const shelves = all.filter((shelf) => shelf !== youtubePicks);
  const { data: explore } = useCached('explore', () => api.explore(), 60 * 60_000);
  const moods = explore?.shelves.find((shelf) => shelf.items.length > 6 && shelf.items.every((i) => i.type === 'category'));
  return (
    <div className="page home">
      <div className="home-heading">
        <PageTitle>{greeting()}</PageTitle>
        <p className="muted home-date">{new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      </div>
      {(state.recents[0] || mixes.length > 0) && (
        <section className="home-hero">
          {state.recents[0] && <ResumeCard track={state.recents[0]} />}
          {mixes.map((kind) => <MixCard key={kind.id} kind={kind} />)}
        </section>
      )}
      {quickPicks && <ShelfView shelf={{ ...quickPicks, title: quickPicks.title || 'Sélection rapide' }} />}
      {state.recents.length > 0 && (
        <ShelfView shelf={{ id: 'recents', title: 'Écoutés récemment', layout: 'cards', items: recentItems(state.recents) }}
          moreRoute={{ name: 'history' }} />
      )}
      {personal.map((shelf) => <ShelfView key={shelf.id} shelf={shelf} />)}
      {moods && <ShelfView shelf={{ ...moods, title: 'Humeurs et genres' }} moreRoute={{ name: 'explore' }} />}
      {shelves.slice(0, 3).map((shelf) => <ShelfView key={shelf.id} shelf={shelf} />)}
      {discover.map((section) => (
        <div key={section.seed.id} className="discover-section">
          <p className="eyebrow">Parce que tu as écouté « {section.seed.title} »</p>
          {section.shelves.map((shelf) => <ShelfView key={shelf.id} shelf={shelf} />)}
        </div>
      ))}
      {shelves.slice(3).map((shelf) => <ShelfView key={shelf.id} shelf={shelf} />)}
      {loading && !data && <Loading />}
      {error && !data && <ErrorState message={error} retry={() => reload(true)} />}
      <div ref={sentinel} className="sentinel">{data?.continuation && <span className="spinner" />}</div>
    </div>
  );
}

export function ExplorePage() {
  const { data, error, loading, reload } = useCached('explore', () => api.explore());
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState message={error} retry={() => reload(true)} />;
  return (
    <div className="page">
      <PageTitle>Nouveautés</PageTitle>
      {data?.shelves.map((shelf) => (shelf.id === 'explore-top'
        ? <div key={shelf.id} className="top-buttons"><CategoryGrid shelf={shelf} /></div>
        : <ShelfView key={shelf.id} shelf={shelf} ranked={shelf.layout === 'grid'} />))}
    </div>
  );
}

export function BrowsePage({ title, link }: { title: string; link: { browseId: string; params?: string } }) {
  const { data, error, loading, reload } = useCached(`browse-${link.browseId}-${link.params ?? ''}`, () => api.browse(link), 30 * 60_000);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState message={error} retry={() => reload(true)} />;
  const shelves = data?.shelves ?? [];
  return (
    <div className="page">
      <PageTitle>{data?.header?.title || title}</PageTitle>
      {shelves.map((shelf) => {
        // Humeurs et genres : grille de tuiles complète.
        if (shelf.items.every((i) => i.type === 'category')) return <CategoryGrid key={shelf.id} shelf={shelf} />;
        if (shelves.length === 1 && shelf.layout === 'cards') return <CardGrid key={shelf.id} items={shelf.items} />;
        return <ShelfView key={shelf.id} shelf={shelf.layout === 'grid' ? { ...shelf, layout: 'list' } : shelf}
          limit={shelf.layout === 'grid' ? 100 : 6} ranked={shelf.layout === 'grid'} />;
      })}
      {!shelves.length && <p className="muted">Rien ici pour l’instant.</p>}
    </div>
  );
}

const scopes: [SearchScope, string][] = [['all', 'Tout'], ['song', 'Titres'], ['video', 'Vidéos'], ['album', 'Albums'], ['artist', 'Artistes'], ['playlist', 'Playlists']];

export function SearchPage({ query: initial }: { query?: string }) {
  const state = useStore(library);
  const [query, setQuery] = useState(initial ?? '');
  const [submitted, setSubmitted] = useState(initial ?? '');
  const [scope, setScope] = useState<SearchScope>('all');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [results, setResults] = useState<Shelf[] | null>(null);
  const [error, setError] = useState<string>();
  const moods = useCached('moods', () => api.browse({ browseId: 'FEmusic_moods_and_genres' }), 24 * 3600_000);
  useStore(playerState);

  useEffect(() => { setQuery(initial ?? ''); setSubmitted(initial ?? ''); }, [initial]);

  useEffect(() => {
    if (!query.trim() || query === submitted) return setSuggestions([]);
    const timer = setTimeout(() => void api.suggestions(query).then(setSuggestions).catch(() => setSuggestions([])), 200);
    return () => clearTimeout(timer);
  }, [query, submitted]);

  useEffect(() => {
    if (!submitted.trim()) return setResults(null);
    let alive = true;
    setResults(null);
    setError(undefined);
    void api.search(submitted, scope).then((found) => alive && setResults(found)).catch((e) => alive && setError(String(e.message ?? e)));
    return () => { alive = false; };
  }, [submitted, scope]);

  const submit = (text: string) => {
    setQuery(text);
    setSubmitted(text);
    setSuggestions([]);
    addSearch(text);
  };

  return (
    <div className="page">
      <form className="search-field" onSubmit={(e) => { e.preventDefault(); submit(query); }}>
        <Icon name="search" size={20} />
        <input autoFocus placeholder="Titres, artistes, albums, playlists" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && <button type="button" className="icon-button" onClick={() => { setQuery(''); setSubmitted(''); }}><Icon name="close" size={16} /></button>}
        {suggestions.length > 0 && (
          <div className="suggestions">
            {suggestions.map((s) => <button type="button" key={s} onClick={() => submit(s)}><Icon name="search" size={14} /> {s}</button>)}
          </div>
        )}
      </form>
      {submitted ? (
        <>
          <div className="chips">
            {scopes.map(([value, label]) => <button key={value} className={`chip ${scope === value ? 'on' : ''}`} onClick={() => setScope(value)}>{label}</button>)}
          </div>
          {error && <ErrorState message={error} />}
          {!results && !error && <Loading />}
          {results?.map((shelf) => scope === 'all'
            ? <ShelfView key={shelf.id} shelf={shelf} onPlay={(track) => player.startRadio(track)} />
            : <ShelfView key={shelf.id} shelf={{ ...shelf, title: '', layout: shelf.items.every((i) => i.type === 'track') ? 'list' : 'cards' }} limit={100}
                onPlay={(track) => player.startRadio(track)} />)}
          {results && !results.length && <p className="muted">Aucun résultat pour « {submitted} ».</p>}
        </>
      ) : (
        <>
          {state.searches.length > 0 && (
            <section className="shelf">
              <header className="shelf-header"><h2>Recherches récentes</h2><button className="text-button" onClick={clearSearches}>Effacer</button></header>
              <div className="chips">{state.searches.slice(0, 12).map((s) => <button key={s} className="chip" onClick={() => submit(s)}><Icon name="clock" size={13} /> {s}</button>)}</div>
            </section>
          )}
          {songs().length > 0 && <p className="eyebrow">Parcourir</p>}
          {moods.data?.shelves.filter((s) => s.items.every((i) => i.type === 'category')).map((shelf) => <CategoryGrid key={shelf.id} shelf={shelf} />)}
          {moods.loading && !moods.data && <Loading />}
        </>
      )}
    </div>
  );
}

export function ResumeArt({ track }: { track: Track }) {
  return <Artwork track={track} size={64} radius={8} />;
}
