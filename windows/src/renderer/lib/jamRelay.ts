export interface JamCircle { endpoint: string; key: string }
export interface RemoteRoom { id: string; name: string; people: number }

export function parseJamInvitation(value: string) {
  try {
    const url = new URL(value.trim());
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    const match = /^#([a-f0-9]{16})\.([a-f0-9]{48})$/.exec(url.hash);
    if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || !match
      || url.pathname !== '/nova-jam/app/') return;
    return { id: match[1], circle: { endpoint: new URL('/nova-jam', url).href, key: match[2] } };
  } catch { return; }
}

export function jamInvitation(circle: JamCircle, id: string, key: string) {
  const url = new URL('/nova-jam/app/', circle.endpoint);
  url.hash = id + '.' + key;
  return parseJamInvitation(url.href) ? url.href : undefined;
}

export function parseJamCircle(value: string): JamCircle | undefined {
  try {
    const url = new URL(value.trim());
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
    if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search
      || !/^\/nova-jam\/?$/.test(url.pathname) || !/^#[a-f\d]{32,128}$/i.test(url.hash)) return;
    const key = url.hash.slice(1);
    url.hash = '';
    url.pathname = '/nova-jam';
    return { endpoint: url.href, key };
  } catch {
    return;
  }
}

export class JamRelayError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function requireHostInvitation(circle: JamCircle, room: string, key?: string): string {
  const invitation = typeof key === 'string' && jamInvitation(circle, room, key);
  if (!invitation) throw new JamRelayError(200, 'Le relais n’a pas fourni d’invitation. Réessaie de créer le Jam.');
  return invitation;
}

export async function jamRelay<T>(circle: JamCircle, body: object): Promise<T> {
  let status: number;
  let data: unknown;
  try {
    if (window.nova?.platform === 'android') {
      ({ status, data } = await window.nova.invoke<{ status: number; data: unknown }>('jam:relay', circle, body));
    } else {
      const response = await fetch(circle.endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + circle.key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(7000),
      });
      status = response.status;
      data = await response.text();
    }
  } catch {
    throw new JamRelayError(0, 'Impossible de joindre le relais Jam. Vérifie ta connexion.');
  }
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = undefined; }
  }
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data as { error?: unknown } : undefined;
  if (status !== 200) {
    const fallback = status === 401 || status === 403
      ? 'Vérifie le lien de configuration hôte dans Nova.'
      : 'Le relais Jam ne répond pas (HTTP ' + status + ').';
    throw new JamRelayError(status, typeof payload?.error === 'string' ? payload.error : fallback);
  }
  if (!payload) throw new JamRelayError(status, 'Réponse du relais Jam illisible.');
  return payload as T;
}
