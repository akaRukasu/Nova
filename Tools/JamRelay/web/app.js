const byId = id => document.getElementById(id);
const endpoint = new URL('../', location.href);
endpoint.pathname = endpoint.pathname.replace(/\/$/, '');
const pattern = /^#([a-f0-9]{16})\.([a-f0-9]{48})$/;
let invite = parseInvite(location.hash);
let session;
let state;
let refreshTimer;
let pendingSearch = 0;
let queueSignature;
const pendingAdditions = new Map();

function parseInvite(hash) {
  const match = pattern.exec(hash);
  return match && { room: match[1], key: match[2], hash };
}

function show(id, text) {
  const element = byId(id);
  element.textContent = text;
  element.hidden = !text;
}

function landing(browser = false) {
  byId('landing').hidden = false;
  byId('room').hidden = true;
  byId('leave').hidden = true;
  byId('invitation').hidden = Boolean(invite);
  byId('choices').hidden = !invite || browser;
  byId('join').hidden = !invite || !browser;
  if (invite) {
    const url = new URL('nova://jam/invite');
    url.searchParams.set('link', new URL(invite.hash, location.href).href);
    byId('native').href = url.href;
  }
}

async function request(action, fields = {}, connection = session) {
  const credential = connection?.invite ?? invite;
  if (!credential) throw new Error('Ouvre le lien envoyé par l’hôte.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + credential.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, room: credential.room, token: connection?.token, ...fields }),
    signal: AbortSignal.timeout(8500),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Le Jam est indisponible.'), { status: response.status });
  return data;
}

function setArtwork(image, url) {
  const next = typeof url === 'string' && url.startsWith('https://') ? url : '';
  if (image.getAttribute('src') === next) return;
  if (!next) {
    image.removeAttribute('src');
    image.hidden = true;
  } else {
    image.hidden = false;
    image.src = next;
  }
}

function trackRow(track, action, by) {
  const li = document.createElement('li');
  const image = document.createElement('img');
  image.className = 'thumb';
  image.alt = '';
  image.loading = 'lazy';
  setArtwork(image, track.artwork);
  const text = document.createElement('div');
  text.className = 'track-text';
  const title = document.createElement('strong');
  title.textContent = track.title;
  const artist = document.createElement('small');
  artist.textContent = [track.artist, by && 'Ajouté par ' + by].filter(Boolean).join(' · ');
  text.append(title, artist);
  li.append(image, text);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '+ Ajouter';
    button.setAttribute('aria-label', 'Ajouter ' + track.title);
    button.addEventListener('click', () => action(button));
    li.append(button);
  }
  return li;
}

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(value));
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

function renderProgress() {
  const duration = state?.queue[state.index]?.duration;
  const available = Number.isFinite(duration) && duration > 0 && Number.isFinite(state.position);
  byId('timeline').hidden = !available;
  if (!available) return;
  const elapsed = state.playing ? Math.max(0, Math.min(5, (Date.now() - state.sentAt) / 1000)) : 0;
  const position = Math.max(0, Math.min(duration, state.position + elapsed));
  byId('progress').max = duration;
  byId('progress').value = position;
  byId('elapsed').textContent = formatTime(position);
  byId('duration').textContent = formatTime(duration);
}

function trackOccurrences(id) {
  return state?.queue.filter(track => track.id === id).length ?? 0;
}

function confirmAdditions() {
  for (const [id, entry] of pendingAdditions) {
    if (trackOccurrences(id) <= entry.before) continue;
    pendingAdditions.delete(id);
    clearTimeout(entry.timeout);
    entry.button.textContent = '✓ Ajouté';
    entry.button.dataset.added = 'true';
    entry.button.setAttribute('aria-label', entry.title + ' ajouté à la file');
    show('result-status', '« ' + entry.title + ' » ajouté à la file.');
  }
}

async function addToQueue(track, button, connection) {
  if (pendingAdditions.has(track.id)) return;
  button.disabled = true;
  button.textContent = 'Envoi…';
  const entry = { before: trackOccurrences(track.id), button, title: track.title };
  pendingAdditions.set(track.id, entry);
  const retry = message => {
    if (pendingAdditions.get(track.id) !== entry) return;
    pendingAdditions.delete(track.id);
    button.disabled = false;
    button.textContent = '+ Ajouter';
    show('result-status', message);
  };
  try {
    await request('send', { event: { type: 'add', track, next: false } }, connection);
    if (pendingAdditions.get(track.id) !== entry) return;
    confirmAdditions();
    if (pendingAdditions.get(track.id) !== entry) return;
    button.textContent = 'En attente…';
    show('result-status', 'En attente de la file de l’hôte…');
    entry.timeout = setTimeout(() => retry('L’ajout n’a pas été confirmé par l’hôte.'), 12000);
  } catch (error) { retry(error.message); }
}

function render() {
  const track = state?.queue[state.index];
  const next = state?.queue.slice(state.index + 1) ?? [];
  byId('room-name').textContent = state ? 'Jam de ' + state.hostName : 'Jam';
  byId('members').textContent = (state?.participants ?? []).join(' · ');
  setArtwork(byId('artwork'), track?.artwork);
  byId('playing-title').textContent = track?.title || 'La file est vide';
  byId('playing-artist').textContent = track?.artist || 'Ajoute un titre pour lancer la musique.';
  byId('transport').hidden = !state?.guestsCanControl;
  const toggle = byId('toggle');
  toggle.setAttribute('aria-label', state?.playing ? 'Pause' : 'Lire');
  toggle.dataset.command = state?.playing ? 'pause' : 'play';
  byId('queue-empty').hidden = next.length > 0;
  byId('view-queue').hidden = next.length === 0;
  show('queue-count', next.length ? String(next.length) : '');
  const signature = JSON.stringify(next.map(track => [track, state.addedBy?.[track.id]]));
  if (queueSignature !== signature) {
    queueSignature = signature;
    byId('queue').replaceChildren(...next.map(track => trackRow(track, undefined, state.addedBy?.[track.id])));
  }
  renderProgress();
  confirmAdditions();
}

function disconnect(message) {
  clearTimeout(refreshTimer);
  pendingSearch++;
  session = undefined;
  state = undefined;
  queueSignature = undefined;
  for (const entry of pendingAdditions.values()) clearTimeout(entry.timeout);
  pendingAdditions.clear();
  byId('results').replaceChildren();
  byId('results').hidden = true;
  show('result-status', '');
  if (message) {
    invite = null;
    history.replaceState(null, '', location.pathname);
  }
  landing();
  show('status', message ?? '');
}

async function poll(connection) {
  try {
    const update = await request('poll', { after: connection.after }, connection);
    if (connection !== session) return;
    byId('connection').textContent = 'Connecté';
    delete byId('connection').dataset.offline;
    if (update.state) {
      connection.after = update.version;
      state = update.state;
      render();
    }
  } catch (error) {
    if (connection !== session) return;
    if ([403, 404].includes(error.status)) return disconnect('Ce Jam est terminé ou l’invitation a expiré.');
    byId('connection').textContent = 'Reconnexion…';
    byId('connection').dataset.offline = 'true';
  }
  if (connection === session) refreshTimer = setTimeout(() => poll(connection), 1600);
}

byId('invitation').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const url = new URL(byId('link').value);
    if (url.origin !== location.origin || url.pathname !== location.pathname || !parseInvite(url.hash)) throw new Error();
    location.hash = url.hash;
  } catch { show('status', 'Ce lien ne correspond pas à une invitation Jam Nova.'); }
});
window.addEventListener('hashchange', () => {
  if (session) return;
  invite = parseInvite(location.hash);
  show('status', '');
  landing();
});
byId('browser').addEventListener('click', () => { landing(true); byId('name').focus(); });
byId('join').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  const target = invite;
  button.disabled = true;
  show('status', '');
  try {
    const reply = await request('join', { name: byId('name').value });
    const connection = { invite: target, token: reply.token, after: 0 };
    if (invite !== target) return void request('leave', {}, connection).catch(() => {});
    session = connection;
    byId('landing').hidden = true;
    byId('room').hidden = false;
    byId('leave').hidden = false;
    render();
    void poll(session);
  } catch (error) { show('status', error.message); }
  finally { button.disabled = false; }
});
byId('leave').addEventListener('click', async () => {
  const connection = session;
  const button = byId('leave');
  button.disabled = true;
  try {
    await request('leave', {}, connection);
    if (session === connection) disconnect();
  } catch (error) {
    if ([403, 404].includes(error.status)) disconnect('Ce Jam est terminé.');
    else show('status', 'Impossible de quitter pour le moment. Réessaie.');
  } finally { button.disabled = false; }
});

byId('search').addEventListener('submit', async event => {
  event.preventDefault();
  const search = ++pendingSearch;
  const connection = session;
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  byId('results').hidden = true;
  show('result-status', 'Recherche sur Octave…');
  try {
    const { tracks } = await request('search', { query: byId('query').value }, connection);
    if (search !== pendingSearch || connection !== session) return;
    byId('results').replaceChildren(...tracks.map(track => trackRow(track, button => void addToQueue(track, button, connection))));
    byId('results').hidden = !tracks.length;
    show('result-status', tracks.length ? '' : 'Aucun morceau trouvé.');
  } catch (error) {
    if (search === pendingSearch) show('result-status', error.message);
  } finally { button.disabled = false; }
});

byId('transport').addEventListener('click', async event => {
  const command = event.target.closest('button')?.dataset.command;
  if (!command) return;
  try {
    await request('send', { event: { type: 'command', command } });
    show('status', '');
  } catch (error) { show('status', error.message); }
});

byId('view-queue').addEventListener('click', () => {
  const panel = byId('queue-panel');
  panel.focus({ preventScroll: true });
  panel.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
});

landing();
setInterval(() => { if (session) renderProgress(); }, 500);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
