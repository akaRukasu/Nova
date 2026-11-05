// Accès à YouTube Music (bibliothèque youtubei.js), traduit dans les modèles de Nova.
import vm from 'node:vm';
import { Innertube, Platform, UniversalCache } from 'youtubei.js';
import type {
  BrowseLink, Category, Collection, CollectionKind, CollectionPage, Item, Page, PageHeader, Shelf, Track,
} from '../shared/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

// Le déchiffrement des liens audio exécute un extrait du lecteur de YouTube. Il tourne dans un
// bac à sable (sans accès aux fichiers ni au réseau), avec une limite de temps.
Platform.shim.eval = (data, env) => {
  const args = [env.n, env.sp, env.sig].map((value) => JSON.stringify(value ?? ''));
  const code = `${data.output}\nprocess(${args.join(', ')});`;
  return vm.runInNewContext(code, { URL, URLSearchParams }, { timeout: 4000 }) as Record<string, unknown>;
};

let client: Innertube | null = null;
let creating: Promise<Innertube> | null = null;
let options = { lang: 'fr', location: 'FR', cookie: undefined as string | undefined, cacheDir: '' };

export function configure(next: Partial<typeof options>) {
  options = { ...options, ...next };
  client = null;
  creating = null;
}

export async function yt(): Promise<Innertube> {
  if (client) return client;
  if (!creating) {
    creating = Innertube.create({
      lang: options.lang,
      location: options.location,
      cookie: options.cookie,
      retrieve_player: true,
      generate_session_locally: true,
      cache: options.cacheDir ? new UniversalCache(true, options.cacheDir) : undefined,
    }).then((created) => {
      client = created;
      return created;
    }).catch((error) => {
      creating = null;
      throw error;
    });
  }
  return creating;
}

// MARK: - Conversion

export function text(value: any): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) return value.toString();
  return value.text ?? '';
}

/** Plus grande image ; les pochettes Google sont demandées en 544 px (l'interface ajuste ensuite). */
export function artwork(thumbs: any): string | undefined {
  const list: any[] = Array.isArray(thumbs) ? thumbs : thumbs?.contents ?? [];
  if (!list.length) return undefined;
  const best = [...list].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  let url: string = best?.url ?? '';
  if (url.startsWith('//')) url = 'https:' + url;
  return url.replace(/=w\d+-h\d+/, '=w544-h544') || undefined;
}

export function isSquare(url?: string) {
  return !!url && /googleusercontent|ggpht/.test(url);
}

function payload(endpoint: any): any {
  return endpoint?.payload ?? {};
}

function kindOf(type?: string, browseId?: string): CollectionKind | undefined {
  if (type === 'album' || type === 'single' || type === 'ep') return 'album';
  if (type === 'playlist') return 'playlist';
  if (type === 'artist' || type === 'library_artist' || type === 'channel') return 'artist';
  if (browseId?.startsWith('MPREb')) return 'album';
  if (browseId?.startsWith('VL') || browseId?.startsWith('PL') || browseId?.startsWith('RD')) return 'playlist';
  if (browseId?.startsWith('UC')) return 'artist';
  return undefined;
}

function artistsText(artists?: any[], fallback?: string) {
  const names = (artists ?? []).map((a) => a?.name).filter(Boolean);
  if (names.length) return names.length > 1 ? `${names.slice(0, -1).join(', ')} et ${names.at(-1)}` : names[0];
  return fallback ?? '';
}

const palette = ['#e5484d', '#f76b15', '#ffb224', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f', '#8e4ec6', '#3e63dd'];
function colorFor(title: string) {
  let hash = 0;
  for (const char of title) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

export function trackFrom(node: Node): Track | undefined {
  switch (node?.type) {
    case 'MusicResponsiveListItem': {
      if (!['song', 'video', 'non_music_track'].includes(node.item_type) && !payload(node.endpoint).videoId && !node.id) return undefined;
      const id = node.id ?? payload(node.endpoint).videoId ?? payload(node.overlay?.content?.endpoint).videoId;
      if (!id || !node.title) return undefined;
      const art = artwork(node.thumbnail ?? node.thumbnails);
      return {
        id,
        title: node.title,
        artist: artistsText(node.artists ?? node.authors, node.author?.name),
        album: node.album?.name,
        albumId: node.album?.id,
        artistId: (node.artists ?? node.authors)?.[0]?.channel_id,
        duration: node.duration?.seconds || undefined,
        artwork: art,
        square: isSquare(art),
      };
    }
    case 'MusicTwoRowItem': {
      const videoId = payload(node.endpoint).videoId;
      if (!videoId) return undefined;
      const art = artwork(node.thumbnail);
      return {
        id: videoId,
        title: text(node.title),
        artist: artistsText(node.artists, node.author?.name ?? text(node.subtitle).split(' • ').at(-1)),
        artistId: node.artists?.[0]?.channel_id,
        artwork: art,
        square: isSquare(art),
      };
    }
    case 'PlaylistPanelVideo': {
      const art = artwork(node.thumbnail);
      return {
        id: node.video_id,
        title: text(node.title),
        artist: artistsText(node.artists, node.author),
        artistId: node.artists?.[0]?.channel_id,
        album: node.album?.name,
        albumId: node.album?.id,
        duration: node.duration?.seconds || undefined,
        artwork: art,
        square: isSquare(art),
      };
    }
    case 'PlaylistPanelVideoWrapper':
      return trackFrom(node.primary);
    default:
      return undefined;
  }
}

function collectionFrom(node: Node): Collection | undefined {
  const browseId: string | undefined = payload(node.endpoint).browseId ?? node.id;
  if (!browseId) return undefined;
  const kind = kindOf(node.item_type, browseId);
  if (!kind) return undefined;
  const title = node.type === 'MusicTwoRowItem' ? text(node.title) : node.title ?? node.name ?? '';
  const subtitle = node.type === 'MusicTwoRowItem' ? text(node.subtitle) : text(node.subtitle) || node.author?.name || '';
  return { id: browseId, kind, title, subtitle, artwork: artwork(node.thumbnail ?? node.thumbnails) };
}

function categoryFrom(node: Node): Category | undefined {
  const endpoint = payload(node.endpoint);
  if (!endpoint.browseId) return undefined;
  const title = node.button_text ?? text(node.title);
  return { title, color: colorFor(title), browseId: endpoint.browseId, params: endpoint.params };
}

export function itemFrom(node: Node): Item | undefined {
  if (node?.type === 'MusicNavigationButton') {
    const category = categoryFrom(node);
    return category && { type: 'category', category };
  }
  const track = trackFrom(node);
  if (track) return { type: 'track', track };
  const collection = collectionFrom(node);
  return collection && { type: 'collection', collection };
}

function linkFrom(endpoint: any): BrowseLink | undefined {
  const data = payload(endpoint);
  return data.browseId ? { browseId: data.browseId, params: data.params } : undefined;
}

/** Étagères d'une page (carrousels, listes, grilles), quelles que soient leurs enveloppes. */
export function shelvesFrom(sections: any[] | undefined, prefix = 's'): Shelf[] {
  const shelves: Shelf[] = [];
  const visit = (node: Node) => {
    if (!node) return;
    switch (node.type) {
      case 'MusicCarouselShelf': {
        const items = (node.contents ?? []).map(itemFrom).filter(Boolean) as Item[];
        const listLike = (node.contents ?? []).every((c: Node) => c?.type === 'MusicResponsiveListItem');
        if (items.length) shelves.push({
          id: `${prefix}${shelves.length}`, title: text(node.header?.title), items,
          layout: listLike ? 'grid' : 'cards', more: linkFrom(node.header?.more_content?.endpoint),
        });
        break;
      }
      case 'MusicShelf':
      case 'MusicPlaylistShelf': {
        const items = (node.contents ?? []).map(itemFrom).filter(Boolean) as Item[];
        if (items.length) shelves.push({
          id: `${prefix}${shelves.length}`, title: text(node.title), items, layout: 'list',
          more: linkFrom(node.bottom_button?.endpoint ?? node.endpoint),
        });
        break;
      }
      case 'MusicCardShelf': {
        const items: Item[] = [];
        const main = itemFrom({ ...node, type: node.on_tap ? 'MusicTwoRowItem' : node.type, endpoint: node.on_tap ?? node.endpoint,
          thumbnail: node.thumbnail?.contents ?? node.thumbnail });
        if (main) items.push(main);
        for (const child of node.contents ?? []) {
          const item = itemFrom(child);
          if (item) items.push(item);
        }
        if (items.length) shelves.push({ id: `${prefix}${shelves.length}`, title: 'Meilleur résultat', items, layout: 'list' });
        break;
      }
      case 'Grid': {
        const items = (node.items ?? node.contents ?? []).map(itemFrom).filter(Boolean) as Item[];
        if (items.length) shelves.push({
          id: `${prefix}${shelves.length}`, title: text(node.header?.title ?? node.header?.grid_header_text), items,
          layout: items.every((i) => i.type === 'category') ? 'cards' : 'cards',
        });
        break;
      }
      case 'ItemSection':
      case 'SectionList': {
        const children: Node[] = node.contents ?? [];
        // Recherche « Tout » : YouTube renvoie parfois une liste à plat ; on la range par type.
        const flat = children.filter((c) => c?.type === 'MusicResponsiveListItem' || c?.type === 'MusicTwoRowItem');
        if (flat.length) {
          const titles: Record<string, string> = { song: 'Titres', video: 'Vidéos', album: 'Albums', artist: 'Artistes', playlist: 'Playlists' };
          const groups = new Map<string, Item[]>();
          for (const child of flat) {
            const item = itemFrom(child);
            if (!item) continue;
            const kind = item.type === 'track' ? (child.item_type === 'video' ? 'video' : 'song') : item.type === 'collection' ? item.collection.kind : 'other';
            groups.set(kind, [...(groups.get(kind) ?? []), item]);
          }
          for (const [kind, items] of groups) {
            shelves.push({ id: `${prefix}${shelves.length}`, title: titles[kind] ?? '', items, layout: items[0].type === 'track' ? 'list' : 'cards' });
          }
        }
        children.filter((c) => !flat.includes(c)).forEach(visit);
        break;
      }
      default:
        break;
    }
  };
  (sections ?? []).forEach(visit);
  return shelves;
}

function headerFrom(header: Node): PageHeader {
  if (!header) return { title: '' };
  const art = artwork(header.thumbnail ?? header.foreground_thumbnail);
  return {
    title: text(header.title),
    subtitle: [text(header.strapline_text_one), text(header.subtitle)].filter(Boolean).join(' · ') || undefined,
    description: text(header.description?.description ?? header.description) || undefined,
    artwork: art,
  };
}

// MARK: - Pages

export type SearchScope = 'all' | 'song' | 'video' | 'album' | 'artist' | 'playlist';

export async function search(query: string, scope: SearchScope = 'all'): Promise<Shelf[]> {
  const result = await (await yt()).music.search(query, scope === 'all' ? undefined : { type: scope });
  return shelvesFrom(result.contents as any[], `search-${scope}-`);
}

export async function suggestions(query: string): Promise<string[]> {
  if (!query.trim()) return [];
  const sections = await (await yt()).music.getSearchSuggestions(query);
  const values: string[] = [];
  for (const section of sections as any[]) {
    for (const entry of section.contents ?? []) {
      if (entry.type === 'SearchSuggestion') values.push(text(entry.suggestion));
    }
  }
  return values.slice(0, 8);
}

let homeFeed: any = null;

export async function home(): Promise<Page> {
  homeFeed = await (await yt()).music.getHomeFeed();
  return { shelves: shelvesFrom(homeFeed.sections, 'home-'), continuation: !!homeFeed.has_continuation };
}

export async function homeMore(): Promise<Page> {
  if (!homeFeed?.has_continuation) return { shelves: [], continuation: false };
  try {
    homeFeed = await homeFeed.getContinuation();
  } catch {
    // Fin de l'accueil : YouTube Music n'a plus rien à proposer.
    homeFeed = null;
    return { shelves: [], continuation: false };
  }
  return { shelves: shelvesFrom(homeFeed.sections, `home-${Date.now()}-`), continuation: !!homeFeed.has_continuation };
}

export async function explore(): Promise<Page> {
  const page: any = await (await yt()).music.getExplore();
  const shelves = shelvesFrom(page.sections, 'explore-');
  const buttons = (page.top_buttons ?? []).map(itemFrom).filter(Boolean) as Item[];
  if (buttons.length) shelves.unshift({ id: 'explore-top', title: '', items: buttons, layout: 'cards' });
  return { shelves };
}

/** Page quelconque (humeurs et genres, catégorie, « Tout afficher »). */
export async function browse(link: BrowseLink): Promise<Page> {
  const client = await yt();
  const response: any = await client.actions.execute('/browse', {
    browseId: link.browseId, params: link.params, client: 'YTMUSIC', parse: true,
  } as any);
  const memo = response.contents_memo;
  const nodes: Node[] = [];
  if (memo) {
    for (const type of ['MusicCarouselShelf', 'MusicShelf', 'Grid', 'MusicPlaylistShelf']) {
      nodes.push(...(memo.get(type) ?? []));
    }
  }
  // Ordre de la page : tri par position d'apparition dans la réponse.
  const order = JSON.stringify(response.contents ?? {});
  const header: PageHeader = { title: text(response.header?.title ?? response.header?.header?.title) };
  return { header, shelves: shelvesFrom(nodes.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type)), `browse-${link.browseId}-`) };
}

export async function artist(id: string): Promise<{ header: PageHeader; shelves: Shelf[]; tracks: Track[] }> {
  const page: any = await (await yt()).music.getArtist(id);
  const shelves = shelvesFrom(page.sections, `artist-${id}-`);
  const songs = shelves.find((s) => s.layout === 'list');
  return {
    header: headerFrom(page.header),
    shelves,
    tracks: (songs?.items ?? []).flatMap((i) => (i.type === 'track' ? [i.track] : [])),
  };
}

export async function artistAllSongs(id: string): Promise<Track[]> {
  const page: any = await (await yt()).music.getArtist(id);
  try {
    const shelf: any = await page.getAllSongs?.();
    const tracks = (shelf?.contents ?? []).map(trackFrom).filter(Boolean) as Track[];
    if (tracks.length) return tracks;
  } catch {
    // La bibliothèque cherche l'intitulé anglais (« Top songs ») : on passe par le lien de la liste.
  }
  const list = shelvesFrom(page.sections, 'all-').find((s) => s.layout === 'list');
  if (list?.more?.browseId.startsWith('VL')) {
    return (await collection({ id: list.more.browseId, kind: 'playlist', title: '' }, 500)).tracks;
  }
  return (list?.items ?? []).flatMap((i) => (i.type === 'track' ? [i.track] : []));
}

export async function collection(target: Collection, limit = 1500): Promise<CollectionPage> {
  const client = await yt();
  if (target.kind === 'album') {
    const album: any = await client.music.getAlbum(target.id);
    const header = headerFrom(album.header);
    const artistName = text(album.header?.strapline_text_one) || target.subtitle?.split(' • ').at(-1) || '';
    const tracks = (album.contents ?? []).map(trackFrom).filter(Boolean).map((t: Track) => ({
      ...t,
      artist: t.artist || artistName,
      album: t.album ?? header.title,
      albumId: t.albumId ?? target.id,
      artwork: t.artwork ?? header.artwork,
      square: true,
    })) as Track[];
    return { header, tracks, related: shelvesFrom(album.sections, `album-${target.id}-`) };
  }
  const playlistId = target.id.startsWith('VL') ? target.id.slice(2) : target.id;
  let playlist: any = await client.music.getPlaylist(playlistId);
  const header = headerFrom(playlist.header);
  const tracks: Track[] = [];
  const add = (list: any[]) => list.map(trackFrom).forEach((t) => t && tracks.push(t));
  add(playlist.items ?? []);
  while (playlist.has_continuation && tracks.length < limit) {
    playlist = await playlist.getContinuation();
    add(playlist.items ?? []);
  }
  return { header: header.title ? header : { ...header, title: target.title }, tracks, related: [] };
}

/** Radio d'un titre : le titre lui-même puis la suite (avec la durée réelle). */
export async function radio(videoId: string): Promise<Track[]> {
  const panel: any = await (await yt()).music.getUpNext(videoId, true);
  const seen = new Set<string>();
  return ((panel.contents ?? []).map(trackFrom).filter(Boolean) as Track[]).filter((t) => !seen.has(t.id) && seen.add(t.id));
}

export async function related(videoId: string): Promise<Shelf[]> {
  const result: any = await (await yt()).music.getRelated(videoId);
  return shelvesFrom(result?.contents ?? [], `related-${videoId}-`);
}

export async function plainLyrics(videoId: string): Promise<{ text: string; source?: string } | undefined> {
  const shelf: any = await (await yt()).music.getLyrics(videoId);
  const value = text(shelf?.description);
  return value ? { text: value, source: text(shelf?.footer) || undefined } : undefined;
}

/** Vraie pochette carrée d'un titre qui n'a qu'une miniature vidéo (version audio, album). */
const artworkKey = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\b(official|clip|video|lyrics?|audio|visualizer)\b/g, '').replace(/[^\p{L}\p{N}]/gu, '');

export async function squareArtwork(videoId: string): Promise<string | undefined> {
  const found = await squareFromPanel(videoId);
  if (found) return found;
  // Dernier essai, comme sur l'iPhone : le même titre du même artiste parmi les titres de la recherche.
  const panel: any = await (await yt()).music.getUpNext(videoId, true).catch(() => null);
  const self = ((panel?.contents ?? []).map(trackFrom).filter(Boolean) as Track[]).find((t) => t.id === videoId);
  if (!self?.artist) return undefined;
  const names = self.artist.replace(/\s*(-\s*topic|vevo|official|officiel)\s*$/i, '').split(/\s*(?:,|&| et | x | feat\.?)\s*/i).filter(Boolean);
  let title = self.title.replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+(feat\.?|ft\.?|avec)\s+.*$/i, '');
  const parts = title.split(' - ');
  if (parts.length > 1 && names.some((n) => artworkKey(parts[0]).includes(artworkKey(n)))) title = parts.slice(1).join(' - ');
  const shelves = await search(`${title} ${names[0] ?? ''}`, 'song').catch(() => [] as Shelf[]);
  const wanted = artworkKey(title);
  const match = shelves.flatMap((s) => s.items).find((i) => i.type === 'track' && i.track.square && artworkKey(i.track.title) === wanted
    && names.some((n) => artworkKey(i.track.artist).includes(artworkKey(n)) || artworkKey(n).includes(artworkKey(i.track.artist))));
  return match?.type === 'track' ? match.track.artwork : undefined;
}

async function squareFromPanel(videoId: string): Promise<string | undefined> {
  const panel: any = await (await yt()).music.getUpNext(videoId, false);
  for (const node of panel.contents ?? []) {
    if (node.type === 'PlaylistPanelVideoWrapper') {
      const primary = trackFrom(node.primary);
      if (primary?.id !== videoId) continue;
      if (primary.square) return primary.artwork;
      for (const counterpart of node.counterpart ?? []) {
        const audio = trackFrom(counterpart);
        if (audio?.square) return audio.artwork;
      }
    }
    const track = trackFrom(node);
    if (track?.id === videoId && track.square) return track.artwork;
  }
  return undefined;
}

// MARK: - Flux audio

export interface Stream {
  url: string;
  mime: string;
  expires: number;
  duration?: number;
}

export async function stream(videoId: string, highQuality: boolean): Promise<Stream> {
  const client = await yt();
  const pick = async (info: any) => {
    const format = info.chooseFormat({ type: 'audio', quality: highQuality ? 'best' : 'bestefficiency', format: 'mp4' })
      ?? info.chooseFormat({ type: 'audio', quality: 'best' });
    const url = await format.decipher(client.session.player);
    const expires = Number(new URL(url).searchParams.get('expire') ?? 0) * 1000 || Date.now() + 3 * 3600_000;
    return {
      url,
      mime: (format.mime_type ?? 'audio/mp4').split(';')[0],
      expires,
      duration: format.approx_duration_ms ? Number(format.approx_duration_ms) / 1000 : info.basic_info?.duration,
    };
  };
  // Les clients par défaut de la bibliothèque, l'un après l'autre ; la raison du refus est gardée.
  const reasons: string[] = [];
  for (const load of [() => client.music.getInfo(videoId), () => client.getInfo(videoId), () => client.getBasicInfo(videoId)]) {
    try {
      const info: any = await load();
      if (info.streaming_data) return await pick(info);
      reasons.push(info.playability_status?.reason ?? info.playability_status?.status ?? 'pas de flux');
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`Lecture refusée par YouTube : ${[...new Set(reasons)].join(' / ')}`);
}

// MARK: - Compte

export async function accountInfo(): Promise<{ name?: string; photo?: string }> {
  const client = await yt();
  const info: any = await client.account.getInfo();
  const header = info?.contents?.contents?.[0]?.header ?? info?.contents?.header;
  return { name: text(header?.account_name ?? header?.title), photo: artwork(header?.account_photo) };
}

export async function likedSongs(): Promise<Track[]> {
  const page = await collection({ id: 'LM', kind: 'playlist', title: 'Titres likés' }, 5000);
  return page.tracks;
}

export async function accountPlaylists(): Promise<Collection[]> {
  const library: any = await (await yt()).music.getLibrary();
  const items: Collection[] = [];
  for (const section of library.contents ?? []) {
    for (const node of section.items ?? section.contents ?? []) {
      const found = collectionFrom(node);
      if (found?.kind === 'playlist' && found.id !== 'VLLM') items.push(found);
    }
  }
  return items;
}

export async function setLike(videoId: string, liked: boolean) {
  const client = await yt();
  if (liked) await client.interact.like(videoId);
  else await client.interact.removeRating(videoId);
}

export async function createAccountPlaylist(name: string, videoIds: string[]): Promise<string | undefined> {
  const client = await yt();
  const created: any = await client.playlist.create(name, videoIds.slice(0, 200));
  const id: string | undefined = created?.playlist_id ?? created?.data?.playlistId;
  if (id && videoIds.length > 200) {
    for (let start = 200; start < videoIds.length; start += 200) {
      await client.playlist.addVideos(id, videoIds.slice(start, start + 200));
    }
  }
  return id;
}

export async function addToAccountPlaylist(playlistId: string, videoIds: string[]) {
  const client = await yt();
  await client.playlist.addVideos(playlistId, videoIds);
}
