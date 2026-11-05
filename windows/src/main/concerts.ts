// Concerts via l'API Discovery de Ticketmaster (clé gratuite de l'utilisateur, dans les réglages).
import type { Concert } from '../shared/types.js';

async function get(path: string, query: Record<string, string>, key: string): Promise<any> {
  const url = new URL(`https://app.ticketmaster.com/discovery/v2/${path}`);
  for (const [name, value] of Object.entries({ ...query, apikey: key, locale: '*' })) url.searchParams.set(name, value);
  const response = await fetch(url);
  if (response.status === 401) throw new Error('Clé Ticketmaster refusée : vérifie-la dans les réglages.');
  if (!response.ok) throw new Error(`Ticketmaster a répondu ${response.status}.`);
  return response.json();
}

export async function searchConcerts(options: { artist?: string; city?: string; radiusKm?: number; key: string }): Promise<Concert[]> {
  if (!options.key) throw new Error('Ajoute ta clé Ticketmaster (gratuite) dans les réglages.');
  const query: Record<string, string> = { size: '100', sort: 'date,asc', classificationName: 'music' };
  if (options.artist) {
    const found = await get('attractions.json', { keyword: options.artist, size: '5' }, options.key);
    const attraction = (found._embedded?.attractions ?? []).find((a: any) =>
      String(a.name).toLowerCase() === options.artist!.toLowerCase()) ?? found._embedded?.attractions?.[0];
    if (attraction) query.attractionId = attraction.id;
    else query.keyword = options.artist;
  }
  if (options.city) query.city = options.city;
  const json = await get('events.json', query, options.key);
  return (json._embedded?.events ?? []).map((event: any): Concert => {
    const venue = event._embedded?.venues?.[0];
    const image = (event.images ?? []).sort((a: any, b: any) => (b.width ?? 0) - (a.width ?? 0))[0]?.url;
    return {
      id: event.id,
      name: event.name,
      date: event.dates?.start?.dateTime ?? event.dates?.start?.localDate ?? '',
      place: venue?.name ?? '',
      city: [venue?.city?.name, venue?.country?.name].filter(Boolean).join(', '),
      url: event.url,
      image,
    };
  });
}
