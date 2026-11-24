import type { Concert } from '../shared/types.js';

type Search = { artist?: string; city?: string; country?: string; key?: string };
type DiscoveryPage = { page?: { totalPages?: number }; _embedded?: { attractions?: { id: string; name: string }[]; events?: TicketmasterEvent[] } };
type TicketmasterEvent = {
  id: string; name: string; url?: string; images?: { width?: number; url: string }[];
  dates?: { start?: { dateTime?: string; localDate?: string }; status?: { code?: string } };
  _embedded?: { venues?: { name?: string; city?: { name?: string }; country?: { countryCode?: string } }[] };
};
type AgendaRecord = {
  uid: string; title_fr: string; firstdate_begin?: string; lastdate_begin?: string; timings?: string; status?: string;
  location_name?: string; location_city?: string; location_countrycode?: string; registration?: string;
  canonicalurl?: string; image?: string;
};

const ticketmaster = 'https://app.ticketmaster.com/discovery/v2/';
const agenda = 'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/evenements-publics-openagenda/records';
const readable = (value?: string) => value?.trim().slice(0, 120) || undefined;
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const phrase = (value: string) => '"' + value.replace(/["\\\p{Cc}]/gu, ' ').trim() + '"';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function https(value?: string): string | undefined {
  try { const url = new URL(value ?? ''); if (url.protocol === 'https:' && !url.username && !url.password) return url.href; } catch {}
}

function decode<T>(value: string | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

async function get<T>(base: string, query: Record<string, string>, fetcher: typeof fetch): Promise<T> {
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  for (let attempt = 0; ; attempt++) {
    const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
    if (response.ok) return response.json() as Promise<T>;
    if (response.status === 429 && attempt === 0) { await wait(650); continue; }
    if (base.startsWith(ticketmaster) && [401, 403].includes(response.status)) throw new Error('Clé Ticketmaster refusée.');
    throw new Error(`${base.startsWith(ticketmaster) ? 'Ticketmaster' : 'OpenAgenda'} a répondu ${response.status}.`);
  }
}

async function discovery(options: Search, fetcher: typeof fetch): Promise<Concert[]> {
  const query: Record<string, string> = { size: '100', sort: 'date,asc', locale: '*', classificationName: 'music', apikey: options.key! };
  if (options.city) query.city = options.city;
  else if (!options.artist && options.country) query.countryCode = options.country;
  const artist = options.artist;
  const variants: Record<string, string>[] = artist ? [{ keyword: artist }] : [{}];
  if (artist) {
    const results = await get<DiscoveryPage>(ticketmaster + 'attractions.json', { keyword: artist, size: '10', locale: '*', apikey: options.key! }, fetcher).catch(() => undefined);
    const exact = results?._embedded?.attractions?.filter(item => normalize(item.name) === normalize(artist)).slice(0, 2) ?? [];
    for (const item of exact) variants.push({ attractionId: item.id });
  }
  let lastError: unknown;
  let succeeded = false;
  const concerts: Concert[] = [];
  for (const variant of variants) {
    const eventsQuery = { ...query, ...variant };
    // Un mot-clé peut retrouver une date dont la fiche n'est pas liée à l'attraction.
    if (variant.keyword) delete eventsQuery.classificationName;
    for (let page = 0; page < 10; page++) {
      try {
        const data = await get<DiscoveryPage>(ticketmaster + 'events.json', { ...eventsQuery, page: String(page) }, fetcher);
        succeeded = true;
        for (const event of data._embedded?.events ?? []) {
          const date = event.dates?.start?.dateTime ?? event.dates?.start?.localDate;
          if (!event.id || !event.name || !date || event.dates?.status?.code === 'cancelled') continue;
          const venue = event._embedded?.venues?.[0];
          const image = [...(event.images ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url;
          concerts.push({ id: event.id, name: event.name, date, place: venue?.name ?? '', city: venue?.city?.name ?? '',
            url: https(event.url), image: https(image), source: 'Ticketmaster' });
        }
        if (page + 1 >= (data.page?.totalPages ?? 1)) break;
      } catch (error) { lastError = error; break; }
    }
  }
  if (!succeeded && lastError) throw lastError;
  return concerts;
}

async function openAgenda(options: Search, fetcher: typeof fetch): Promise<Concert[]> {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const clauses = [`lastdate_begin >= date'${today}'`];
  if (options.artist) clauses.push(`search(title_fr, ${phrase(options.artist)})`);
  else {
    const music = ['concert', 'musique', 'rock', 'metal', 'punk', 'jazz', 'rap', 'hip-hop', 'electro', 'pop', 'reggae', 'soul'];
    clauses.push(`(search(title_fr, "concert") or ${music.map(term => `search(keywords_fr, "${term}")`).join(' or ')})`);
  }
  if (options.city) clauses.push(`location_city = ${phrase(options.city)}`);
  else if (!options.artist) clauses.push(`location_countrycode = ${phrase(options.country ?? 'FR')}`);
  const select = 'uid,title_fr,firstdate_begin,lastdate_begin,timings,status,location_name,location_city,location_countrycode,registration,canonicalurl,image';
  const results: Concert[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const data = await get<{ total_count: number; results: AgendaRecord[] }>(agenda, {
      where: clauses.join(' and '), select, order_by: 'lastdate_begin asc', limit: '100', offset: String(offset),
    }, fetcher).catch(error => { if (!results.length) throw error; return undefined; });
    if (!data) break;
    for (const event of data.results ?? []) {
      if (!event.uid || !event.title_fr || decode<{ id?: number } | null>(event.status, null)?.id === 3) continue;
      const registration = decode<{ value?: string }[]>(event.registration, []);
      const url = (Array.isArray(registration) ? registration.map(link => https(link.value)).find(Boolean) : undefined) ?? https(event.canonicalurl);
      const timings = decode<{ begin?: string }[]>(event.timings, []);
      const dates = Array.isArray(timings) && timings.length ? timings.map(item => item.begin) : [event.firstdate_begin, event.lastdate_begin];
      for (const date of new Set(dates)) {
        if (!date || !Number.isFinite(Date.parse(date)) || concertDay(date) < today) continue;
        results.push({ id: `openagenda:${event.uid}:${date}`, name: event.title_fr, date, place: event.location_name ?? '', city: event.location_city ?? '',
          image: https(event.image), url, source: 'OpenAgenda' });
      }
    }
    if (offset + 100 >= data.total_count || !data.results?.length) break;
  }
  return results;
}

const dayFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
function concertDay(date: string): string {
  return date.length === 10 ? date : dayFormatter.format(new Date(date));
}

export function mergeConcerts(sources: Concert[][], artist?: string): Concert[] {
  const result: Concert[] = [];
  const ids = new Set<string>();
  for (const concerts of sources) for (const concert of concerts) {
    if (!Number.isFinite(Date.parse(concert.date)) || ids.has(concert.id)) continue;
    ids.add(concert.id);
    const city = normalize(concert.city.split(',')[0]);
    const venue = normalize(concert.place);
    const name = normalize(concert.name);
    const wanted = normalize(artist ?? '');
    const withoutCity = (title: string) => title.endsWith(` a ${city}`) ? title.slice(0, -(city.length + 3)) : title;
    const duplicate = result.find(previous => {
      if (previous.source === concert.source || concertDay(previous.date) !== concertDay(concert.date)) return false;
      if (!city || normalize(previous.city.split(',')[0]) !== city) return false;
      if (concert.date.includes('T') && previous.date.includes('T') && Math.abs(Date.parse(concert.date) - Date.parse(previous.date)) > 90 * 60_000) return false;
      const earlier = normalize(previous.place);
      const sameVenue = venue && earlier && (venue.includes(earlier) || earlier.includes(venue)
        || venue.split(' ').filter(word => word.length > 4).some(word => earlier.split(' ').includes(word)));
      const earlierName = normalize(previous.name);
      return Boolean(sameVenue && (withoutCity(name) === withoutCity(earlierName)
        || (wanted && name.includes(wanted) && earlierName.includes(wanted))));
    });
    if (duplicate) {
      duplicate.url ??= concert.url;
      duplicate.image ??= concert.image;
    } else result.push({ ...concert });
  }
  return result.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

export async function searchConcerts(options: Search, fetcher: typeof fetch = fetch): Promise<Concert[]> {
  const query = { artist: readable(options.artist), city: readable(options.city),
    country: /^[A-Z]{2}$/.test(options.country ?? '') ? options.country : 'FR', key: options.key?.trim() };
  const [tm, oa] = await Promise.allSettled([query.key ? discovery(query, fetcher) : Promise.resolve([]), openAgenda(query, fetcher)]);
  const concerts = mergeConcerts([tm.status === 'fulfilled' ? tm.value : [], oa.status === 'fulfilled' ? oa.value : []], query.artist);
  if (!concerts.length && oa.status === 'rejected' && (!query.key || tm.status === 'rejected')) throw new Error('Les agendas de concerts sont momentanément indisponibles.');
  if (!concerts.length && tm.status === 'rejected') throw tm.reason;
  return concerts;
}
