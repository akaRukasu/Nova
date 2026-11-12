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
    return { endpoint: url.href, key };
  } catch {
    return;
  }
}

export class JamRelayError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function jamRelay<T>(circle: JamCircle, body: object): Promise<T> {
  const response = await fetch(circle.endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + circle.key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(6000),
  });
  const payload = await response.json();
  if (!response.ok) throw new JamRelayError(response.status, payload.error ?? 'Relais indisponible.');
  return payload as T;
}
