// Retrouve sur YouTube Music les titres venant d'ailleurs (Spotify, Deezer, Apple Music, fichiers).
// Même logique que l'iPhone : plusieurs recherches, du plus précis au plus large, puis une recherche
// approfondie (nom officiel via Deezer, chaque artiste, titre seul, écriture latine, album).
import type { ImportedTrack, Track } from '../shared/types.js';
import { search, type SearchScope } from './yt.js';

export function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !['feat', 'ft', 'the', 'et', 'and', 'with', 'avec'].includes(w))
    .join(' ');
}

export function stripExtras(value: string): string {
  return value
    .replace(/\s*[([][^)\]]*(feat|ft\.|with|avec|remaster|version|edit|mix|live|radio|explicit|bonus|deluxe|from|soundtrack|original|mono|stereo|prod\.)[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+.*(remaster|version|edit|mix|live|radio|explicit|from|soundtrack|mono|stereo|single).*$/gi, '')
    .replace(/\s+(feat|ft)\.?\s.*$/gi, '')
    .trim();
}

export function mainArtist(value: string): string {
  let result = value;
  for (const separator of [',', '&', ' feat', ' ft.', ' x ', ' et ', ' and ', ';', '/']) {
    const index = result.toLowerCase().indexOf(separator);
    if (index > 0) result = result.slice(0, index);
  }
  return result.trim();
}

export function artistNames(value: string): string[] {
  return value
    .split(/\s*(?:,|&|;|\/|\bfeat\.?|\bft\.?|\bx\b|\bet\b|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function matchRecording(wanted: Track, candidates: Track[]): Track | undefined {
  const title = normalize(wanted.title);
  const artist = normalize(wanted.artist);
  if (!title || !artist) return undefined;
  const artists = artistNames(wanted.artist).map(normalize).filter(Boolean);
  const matchingCredits = candidates.filter((candidate) => {
    if (normalize(candidate.title) !== title) return false;
    if (normalize(candidate.artist) === artist) return true;
    const names = artistNames(candidate.artist).map(normalize).filter(Boolean);
    return Boolean(artists[0] && names[0] === artists[0]
      && (names.every((name) => artists.includes(name)) || artists.every((name) => names.includes(name))));
  });
  const exact = matchingCredits.filter((candidate) =>
    !wanted.duration || !candidate.duration || Math.abs(candidate.duration - wanted.duration) <= 8);
  const album = normalize(wanted.album ?? '');
  const match = (album ? exact.find((candidate) => normalize(candidate.album ?? '') === album) : undefined)
    ?? exact.find((candidate) => wanted.duration && candidate.duration && Math.abs(candidate.duration - wanted.duration) <= 2)
    ?? exact[0];
  if (match || wanted.square !== false || !wanted.duration) return match;
  // Un clip officiel peut ajouter une courte intro ou un générique au même enregistrement.
  const audio = matchingCredits.filter((candidate) => candidate.square && candidate.duration
    && normalize(candidate.artist) === artist && wanted.duration! > candidate.duration
    && wanted.duration! - candidate.duration <= Math.min(15, wanted.duration! * 0.04));
  return audio.length === 1 ? audio[0] : undefined;
}

type Scored = { track: Track; score: number };
const unwanted = ['live', 'remix', 'cover', 'karaoke', 'instrumental', 'acoustic', 'acoustique', 'sped', 'slowed',
  'nightcore', '8d', 'reverb', 'extended', 'edit'];

function bestCandidate(candidates: Track[], wanted: ImportedTrack, penalty: number): Scored | undefined {
  const wantedTitle = normalize(stripExtras(wanted.title));
  const wantedFull = normalize(wanted.title).split(' ');
  const wantedArtists = new Set(normalize(wanted.artist).split(' ').filter(Boolean));
  const wantedAlbum = wanted.album ? normalize(wanted.album) : '';
  let best: Scored | undefined;
  candidates.slice(0, 10).forEach((candidate, rank) => {
    const title = normalize(stripExtras(candidate.title));
    let titleScore: number;
    if (title === wantedTitle) titleScore = 3;
    else if (wantedTitle && (title.includes(wantedTitle) || wantedTitle.includes(title))) titleScore = 2;
    else {
      const a = new Set(title.split(' ')), b = wantedTitle.split(' ');
      titleScore = (b.filter((w) => a.has(w)).length / Math.max(b.length, 1)) * 1.5;
    }
    if (titleScore < 1) return;
    let score = titleScore;
    const artists = new Set(normalize(candidate.artist).split(' '));
    if (wantedArtists.size) score += ([...wantedArtists].filter((w) => artists.has(w)).length / wantedArtists.size) * 2;
    if (wanted.duration && candidate.duration) {
      const gap = Math.abs(wanted.duration - candidate.duration);
      score += gap < 4 ? 1.2 : gap < 12 ? 0.5 : gap < 30 ? -0.3 : -1;
    }
    if (wantedAlbum && candidate.album && normalize(candidate.album) === wantedAlbum) score += 0.5;
    const candidateWords = normalize(candidate.title).split(' ');
    for (const word of unwanted) if (candidateWords.includes(word) && !wantedFull.includes(word)) score -= 1.5;
    score -= rank * 0.1 + penalty;
    if (!best || score > best.score) best = { track: candidate, score };
  });
  return best;
}

async function run(attempts: [string, SearchScope][], wanted: ImportedTrack): Promise<Scored | undefined> {
  let best: Scored | undefined;
  for (const [query, scope] of attempts) {
    if (!query.trim()) continue;
    // Le réseau ou YouTube peuvent échouer : nouvel essai, sinon le titre passerait pour introuvable.
    let shelves;
    for (let attempt = 0; attempt < 3 && !shelves; attempt++) {
      try {
        shelves = await search(query, scope);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1500 : 4000));
      }
    }
    if (!shelves) continue;
    const tracks = shelves.flatMap((s) => s.items.flatMap((i) => (i.type === 'track' ? [i.track] : [])));
    const found = bestCandidate(tracks, wanted, scope === 'video' ? 0.6 : scope === 'all' ? 0.2 : 0);
    if (found && (!best || found.score > best.score)) best = found;
    if (best && best.score >= 4.5) break;
  }
  return best;
}

function acceptable(result: Scored, wanted: ImportedTrack) {
  if (result.score >= 2) return true;
  return result.score >= 1.3 && !!wanted.duration && !!result.track.duration
    && Math.abs(wanted.duration - result.track.duration) < 3;
}

/** Nom officiel d'après Deezer (orthographe, artiste principal). */
async function deezerCanonical(wanted: ImportedTrack): Promise<ImportedTrack | undefined> {
  const title = stripExtras(wanted.title), artist = mainArtist(wanted.artist);
  for (const query of [`artist:"${artist}" track:"${title}"`, `${title} ${artist}`]) {
    try {
      const response = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=5`);
      const json: any = await response.json();
      const words = new Set(normalize(title).split(' '));
      for (const item of json.data ?? []) {
        const name: string = item.title ?? '';
        const found = normalize(stripExtras(name)).split(' ');
        if (words.size && found.filter((w) => words.has(w)).length / words.size >= 0.5) {
          return { title: name, artist: item.artist?.name ?? artist, album: item.album?.title, duration: item.duration };
        }
      }
    } catch {
      // Deezer indisponible : on continue sans.
    }
  }
  return undefined;
}

const cache = new Map<string, Track>();
export function loadMatches(entries: Record<string, Track>) {
  for (const [key, value] of Object.entries(entries)) cache.set(key, value);
}
export function savedMatches(): Record<string, Track> {
  return Object.fromEntries(cache);
}
const keyOf = (t: ImportedTrack) => `${normalize(stripExtras(t.title))}|${normalize(mainArtist(t.artist))}`;

export async function match(wanted: ImportedTrack): Promise<Track | undefined> {
  const known = cache.get(keyOf(wanted));
  if (known) return known;
  const artist = mainArtist(wanted.artist);
  const clean = stripExtras(wanted.title);
  const seen = new Set<string>();
  const attempts: [string, SearchScope][] = ([
    [`${wanted.title} ${wanted.artist}`, 'song'],
    [`${clean} ${artist}`, 'song'],
    [`${clean} ${artist}`, 'video'],
  ] as [string, SearchScope][]).filter(([q, s]) => !seen.has(`${q.toLowerCase()}|${s}`) && !!seen.add(`${q.toLowerCase()}|${s}`));
  let best = await run(attempts, wanted);

  if (!best || best.score < 2) {
    const deep: [string, SearchScope][] = [];
    const add = (query: string, scope: SearchScope) => {
      const key = `${query.trim().toLowerCase()}|${scope}`;
      if (query.trim() && !seen.has(key)) { seen.add(key); deep.push([query.trim(), scope]); }
    };
    const canonical = await deezerCanonical(wanted);
    if (canonical) add(`${stripExtras(canonical.title)} ${mainArtist(canonical.artist)}`, 'song');
    const names = artistNames(wanted.artist);
    for (const name of names.slice(1)) add(`${clean} ${name}`, 'song');
    add(`${clean} ${names.join(' ')}`, 'all');
    add(clean, 'song');
    const latin = `${clean} ${artist}`.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    if (latin !== `${clean} ${artist}`) add(latin, 'song');
    if (wanted.album) add(`${clean} ${wanted.album}`, 'song');
    const deeper = await run(deep, canonical ? { ...wanted, ...canonical, duration: wanted.duration ?? canonical.duration } : wanted);
    if (deeper && (!best || deeper.score > best.score)) best = deeper;
  }
  if (!best || !acceptable(best, wanted)) return undefined;
  cache.set(keyOf(wanted), best.track);
  return best.track;
}
