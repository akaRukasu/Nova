// Import depuis les autres plateformes : liens publics (Spotify, Deezer, Apple Music, YouTube)
// et fichiers d'export (CSV Exportify / TuneMyMusic / Soundiiz, TXT « Artiste - Titre », JSON Spotify).
import type { ImportedPlaylist, ImportedTrack } from '../shared/types.js';
import { collection } from './yt.js';

const browserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

async function fetchText(url: string, service: string): Promise<string> {
  const response = await fetch(url, { headers: { 'user-agent': browserAgent, 'accept-language': 'fr-FR,fr;q=0.9' } });
  if (!response.ok) throw new Error(`${service} a répondu ${response.status}.`);
  return response.text();
}

async function fetchJSON(url: string, service: string): Promise<any> {
  const response = await fetch(url, { headers: { 'user-agent': browserAgent } });
  if (!response.ok) throw new Error(`${service} a répondu ${response.status}.`);
  return response.json();
}

function scriptJSON(html: string, id: string): any {
  const start = html.indexOf(`id="${id}"`);
  if (start < 0) return undefined;
  const open = html.indexOf('>', start);
  const close = html.indexOf('</script>', open);
  try {
    return JSON.parse(html.slice(open + 1, close));
  } catch {
    return undefined;
  }
}

function walk(value: any, visit: (dict: Record<string, any>) => void) {
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit));
  else if (value && typeof value === 'object') {
    visit(value);
    for (const key of Object.keys(value)) walk(value[key], visit);
  }
}

function meta(html: string, property: string): string | undefined {
  const match = html.match(new RegExp(`property="${property}"[^>]*content="([^"]*)"`));
  return match?.[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

// MARK: - Liens

export async function fromLink(input: string): Promise<ImportedPlaylist[]> {
  const raw = input.trim().slice(Math.max(0, input.trim().indexOf('http'))).split(/\s+/)[0];
  let url = new URL(raw);
  if (/link\.deezer\.com|spotify\.link|deezer\.page\.link/.test(url.host)) {
    const response = await fetch(url, { headers: { 'user-agent': browserAgent }, redirect: 'follow' });
    url = new URL(response.url);
    if (/link\.deezer|spotify\.link|page\.link/.test(url.host)) {
      const found = (await response.text()).match(/https:\/\/(www\.)?(deezer|open\.spotify)\.com\/[^"'\s<>]+/);
      if (found) url = new URL(found[0]);
    }
  }
  const parts = url.pathname.split('/').filter((p) => p && !p.startsWith('intl-'));
  if (url.host.includes('spotify.com')) {
    const index = parts.findIndex((p) => ['playlist', 'album', 'track'].includes(p));
    if (index < 0 || !parts[index + 1]) throw new Error('Lien Spotify non reconnu.');
    return [await spotify(parts[index], parts[index + 1])];
  }
  if (url.host.includes('deezer.com')) {
    const profile = parts.indexOf('profile');
    if (profile >= 0 && parts[profile + 1]) return deezerProfile(parts[profile + 1]);
    const index = parts.findIndex((p) => ['playlist', 'album'].includes(p));
    if (index < 0 || !parts[index + 1]) throw new Error('Lien Deezer non reconnu.');
    return [await deezer(parts[index], parts[index + 1])];
  }
  if (url.host.includes('music.apple.com') || url.host.includes('itunes.apple.com')) return [await appleMusic(url.toString())];
  if (url.host.includes('youtube.com') || url.host.includes('youtu.be')) {
    const list = url.searchParams.get('list');
    const browse = parts.at(-1)?.startsWith('MPREb') ? parts.at(-1) : undefined;
    const id = list ? `VL${list}` : browse;
    if (!id) throw new Error('Lien YouTube non reconnu.');
    const page = await collection({ id, kind: id.startsWith('MPREb') ? 'album' : 'playlist', title: '' });
    return [{
      name: page.header.title || 'Playlist YouTube',
      source: 'YouTube',
      tracks: page.tracks.map((t) => ({ title: t.title, artist: t.artist, album: t.album, duration: t.duration, youtubeId: t.id })),
    }];
  }
  throw new Error('Ce lien n’est pas reconnu (Spotify, Deezer, Apple Music ou YouTube).');
}

async function spotify(kind: string, id: string): Promise<ImportedPlaylist> {
  const html = await fetchText(`https://open.spotify.com/embed/${kind}/${id}`, 'Spotify');
  let entity: any;
  walk(scriptJSON(html, '__NEXT_DATA__'), (dict) => { if (!entity && dict.entity) entity = dict.entity; });
  if (!entity) throw new Error('Spotify : rien trouvé (playlist privée ?).');
  const tracks: ImportedTrack[] = (entity.trackList ?? [])
    .filter((item: any) => item.title)
    .map((item: any) => ({
      title: item.title,
      artist: String(item.subtitle ?? '').replace(/ /g, ' '),
      duration: item.duration ? item.duration / 1000 : undefined,
    }));
  if (!tracks.length && kind === 'track') {
    tracks.push({ title: entity.title ?? entity.name, artist: (entity.artists ?? []).map((a: any) => a.name).join(', ') });
  }
  if (!tracks.length) throw new Error('Spotify : aucun titre.');
  return { name: entity.name ?? entity.title ?? 'Playlist Spotify', source: 'Spotify', tracks };
}

async function deezerTracks(first: string, album?: string): Promise<ImportedTrack[]> {
  const tracks: ImportedTrack[] = [];
  let next: string | undefined = first;
  for (let page = 0; next && page < 100; page++) {
    const json: any = await fetchJSON(next, 'Deezer');
    for (const item of json.data ?? []) {
      tracks.push({ title: item.title ?? item.title_short, artist: item.artist?.name ?? '', album: item.album?.title ?? album, duration: item.duration });
    }
    next = json.next;
  }
  return tracks;
}

async function deezer(kind: string, id: string): Promise<ImportedPlaylist> {
  const info: any = await fetchJSON(`https://api.deezer.com/${kind}/${id}`, 'Deezer');
  if (info.error) throw new Error(`Deezer : ${info.error.message ?? 'introuvable'}.`);
  const name = info.title ?? 'Playlist Deezer';
  const tracks = await deezerTracks(`https://api.deezer.com/${kind}/${id}/tracks?limit=100`, kind === 'album' ? name : undefined);
  if (!tracks.length) throw new Error('Deezer : aucun titre.');
  return { name, source: 'Deezer', tracks };
}

async function deezerProfile(userId: string): Promise<ImportedPlaylist[]> {
  const result: ImportedPlaylist[] = [];
  const favorites = await deezerTracks(`https://api.deezer.com/user/${userId}/tracks?limit=100`);
  if (favorites.length) result.push({ name: 'Coups de cœur Deezer', source: 'Deezer', tracks: favorites });
  let next: string | undefined = `https://api.deezer.com/user/${userId}/playlists?limit=100`;
  while (next) {
    const page: any = await fetchJSON(next, 'Deezer');
    for (const item of page.data ?? []) {
      if (item.is_loved_track) continue;
      result.push({ name: item.title, source: 'Deezer', tracks: await deezerTracks(`https://api.deezer.com/playlist/${item.id}/tracks?limit=100`) });
    }
    next = page.next;
  }
  if (!result.length) throw new Error('Deezer : profil vide ou privé.');
  return result;
}

async function appleMusic(url: string): Promise<ImportedPlaylist> {
  const html = await fetchText(url, 'Apple Music');
  let name = (meta(html, 'og:title') ?? 'Playlist Apple Music').replace(/&nbsp;| | /g, ' ');
  name = name.replace(/ (sur|on) Apple.?Music.*$/, '');
  if (url.includes('/album/')) name = name.replace(/ (par|by) .+$/, '');
  const tracks: ImportedTrack[] = [];
  const seen = new Set<string>();
  walk(scriptJSON(html, 'serialized-server-data'), (dict) => {
    if (typeof dict.title !== 'string' || typeof dict.artistName !== 'string') return;
    if (dict.duration == null && dict.trackNumber == null && dict.contentDescriptor == null) return;
    const key = `${dict.title}|${dict.artistName}`;
    if (seen.has(key)) return;
    seen.add(key);
    const duration = typeof dict.duration === 'number' ? (dict.duration > 10_000 ? dict.duration / 1000 : dict.duration) : undefined;
    tracks.push({ title: dict.title, artist: dict.artistName, album: dict.albumName, duration });
  });
  if (!tracks.length) throw new Error('Apple Music : aucun titre (playlist privée ?).');
  return { name, source: 'Apple Music', tracks };
}

// MARK: - Fichiers

export function parseCSV(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

const headerKey = (value: string) => value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');

function fromCSV(text: string, fallbackName: string): ImportedPlaylist[] {
  const first = text.split(/\r?\n/)[0] ?? '';
  const delimiter = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const [header, ...rows] = parseCSV(text, delimiter);
  if (!header) return [];
  const keys = header.map(headerKey);
  const column = (names: string[]) => keys.findIndex((k) => names.includes(k));
  const title = column(['trackname', 'title', 'titre', 'name', 'song', 'songname', 'track']);
  const artist = column(['artistnames', 'artistname', 'artist', 'artists', 'artiste', 'artistes']);
  const album = column(['albumname', 'album']);
  const duration = column(['durationms', 'tracklengthms', 'duration', 'duree']);
  const playlist = column(['playlistname', 'playlist']);
  if (title < 0) return [];
  const groups = new Map<string, ImportedTrack[]>();
  for (const row of rows) {
    const name = row[title]?.trim();
    if (!name) continue;
    let seconds = duration >= 0 ? Number(row[duration]) : NaN;
    if (seconds > 10_000) seconds /= 1000;
    const group = (playlist >= 0 && row[playlist]?.trim()) || fallbackName;
    const list = groups.get(group) ?? [];
    list.push({ title: name, artist: artist >= 0 ? row[artist] ?? '' : '', album: album >= 0 ? row[album] || undefined : undefined,
      duration: Number.isFinite(seconds) ? seconds : undefined });
    groups.set(group, list);
  }
  return [...groups].map(([name, tracks]) => ({ name, source: 'Fichier', tracks }));
}

function fromLines(text: string, name: string): ImportedPlaylist[] {
  const tracks = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const parts = line.split(/\s+[-–—]\s+/);
    return parts.length >= 2 ? { artist: parts[0], title: parts.slice(1).join(' - ') } : { artist: '', title: line };
  });
  return tracks.length ? [{ name, source: 'Fichier', tracks }] : [];
}

function fromJSON(json: any, fallbackName: string): ImportedPlaylist[] {
  const lists: ImportedPlaylist[] = [];
  const toTrack = (dict: any): ImportedTrack | undefined => {
    const title = dict.trackName ?? dict.track?.trackName ?? dict.title ?? dict.name;
    const artist = dict.artistName ?? dict.track?.artistName ?? dict.artist ?? dict.artists ?? '';
    return typeof title === 'string' ? { title, artist: Array.isArray(artist) ? artist.join(', ') : String(artist), album: dict.albumName } : undefined;
  };
  for (const playlist of json?.playlists ?? []) {
    const tracks = (playlist.items ?? []).map(toTrack).filter(Boolean) as ImportedTrack[];
    if (tracks.length) lists.push({ name: playlist.name ?? fallbackName, source: 'Fichier', tracks });
  }
  if (!lists.length) {
    const items = Array.isArray(json) ? json : json?.tracks ?? json?.items ?? [];
    const tracks = items.map(toTrack).filter(Boolean) as ImportedTrack[];
    if (tracks.length) lists.push({ name: fallbackName, source: 'Fichier', tracks });
  }
  return lists;
}

export function fromFile(content: string, fileName: string): ImportedPlaylist[] {
  const base = fileName.replace(/\.[^.]+$/, '');
  const lower = fileName.toLowerCase();
  let result: ImportedPlaylist[] = [];
  if (lower.endsWith('.json')) {
    try { result = fromJSON(JSON.parse(content), base); } catch { result = []; }
  } else if (lower.endsWith('.csv') || lower.endsWith('.tsv')) result = fromCSV(content, base);
  else result = fromLines(content, base);
  if (!result.length) throw new Error('Aucun titre trouvé dans ce fichier.');
  return result;
}
