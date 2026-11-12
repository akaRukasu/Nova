// Jam côté interface : l'hôte joue la musique et diffuse l'état ; les invités ajoutent des titres,
// pilotent la lecture si l'hôte le permet, et peuvent écouter en même temps.
import type { JamState, NearbyJam, Track } from '../../shared/types';
import { api, on } from './api';
import { library, notify } from './library';
import { currentTrack, player, playerState, timeState } from './player';
import { Store } from './store';
import { jamRelay, JamRelayError, parseJamCircle, type JamCircle, type RemoteRoom } from './jamRelay';

export interface JamView {
  role: 'none' | 'host' | 'guest';
  nearby: NearbyJam[];
  state?: JamState;
  addresses: string[];
  port?: number;
  guestsCanControl: boolean;
  listenAlong: boolean;
  connecting: boolean;
  remote?: boolean;
  circleLink?: string;
  remoteRooms?: RemoteRoom[];
  relayError?: string;
}

export const jam = new Store<JamView>({ role: 'none', nearby: [], addresses: [], guestsCanControl: true, listenAlong: false, connecting: false,
  circleLink: localStorage.getItem('novaJamCircle') ?? undefined });
const set = (change: Partial<JamView>) => jam.set((s) => ({ ...s, ...change }));

let participants: string[] = [];
const addedBy: Record<string, string> = {};
let heartbeat: ReturnType<typeof setInterval> | undefined;
let lastSignature = '';
let remote: { circle: JamCircle; id: string; token: string; after: number; host: boolean; polling: boolean; publishing: boolean; pending?: JamState } | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;

const name = () => library.get().settings.jamName.trim() || 'Ami Nova';

function hostState(): JamState {
  const { queue, index, playing } = playerState.get();
  return {
    hostName: name(), queue: queue.slice(Math.max(index, 0), Math.max(index, 0) + 200), index: 0, playing, position: timeState.get().time, sentAt: Date.now(),
    participants, addedBy: { ...addedBy },
  };
}

function broadcast() {
  const state = hostState();
  set({ state });
  lastSignature = `${state.queue.map((t) => t.id).join(',')}|${state.index}|${state.playing}`;
  if (remote?.host) {
    remote.pending = state;
    void publishRemote(remote);
  } else void api.jamBroadcast({ type: 'state', state, guestsCanControl: jam.get().guestsCanControl });
}

async function publishRemote(session: NonNullable<typeof remote>) {
  if (session.publishing) return;
  session.publishing = true;
  try {
    while (remote === session && session.pending) {
      const state = session.pending;
      session.pending = undefined;
      await jamRelay(session.circle, { action: 'send', room: session.id, token: session.token,
        state: { ...state, guestsCanControl: jam.get().guestsCanControl } });
    }
  } catch {
    // Le prochain heartbeat renverra l'état courant.
  } finally { session.publishing = false; }
}

export function saveJamCircle(value: string) {
  if (value.trim() && !parseJamCircle(value)) throw new Error('Colle le lien HTTPS complet du cercle Jam.');
  const circleLink = value.trim();
  if (circleLink) localStorage.setItem('novaJamCircle', circleLink);
  else localStorage.removeItem('novaJamCircle');
  set({ circleLink, remoteRooms: [], relayError: undefined });
}

export async function refreshJamCircle() {
  const link = jam.get().circleLink ?? '';
  const circle = parseJamCircle(link);
  if (!circle) return;
  try {
    const result = await jamRelay<{ rooms: RemoteRoom[] }>(circle, { action: 'list' });
    if (jam.get().circleLink === link) set({ remoteRooms: result.rooms, relayError: undefined });
  } catch (error) {
    if (jam.get().circleLink === link) set({ remoteRooms: [], relayError: error instanceof JamRelayError ? error.message : 'Relais Jam indisponible.' });
  }
}

async function connectRemote(host: boolean, room?: string) {
  const circle = parseJamCircle(jam.get().circleLink ?? '');
  if (!circle) throw new Error('Configure le lien du cercle pour jouer à distance.');
  const connection = await jamRelay<{ id: string; token: string }>(circle, { action: host ? 'host' : 'join', room, name: name() });
  remote = { circle, ...connection, after: 0, host, polling: false, publishing: false };
  const session = remote;
  pollTimer = setInterval(() => void pollRemote(session), 1400);
  set({ role: host ? 'host' : 'guest', remote: true, addresses: [] });
  void pollRemote(session);
}

async function pollRemote(session: NonNullable<typeof remote>) {
  if (session.polling || session !== remote) return;
  session.polling = true;
  try {
    const result = await jamRelay<{ participants?: string[]; events?: { seq: number; name: string; event: any }[];
      version?: number; state?: JamState & { guestsCanControl: boolean } }>(
      session.circle, { action: 'poll', room: session.id, token: session.token, after: session.after },
    );
    if (session !== remote) return;
    if (session.host) {
      if (result.participants && JSON.stringify(result.participants) !== JSON.stringify(participants)) {
        participants = result.participants;
        broadcast();
      }
      for (const event of result.events ?? []) {
        session.after = event.seq;
        fromGuest(event.event, event.name);
      }
    } else if (result.state) {
      session.after = result.version ?? session.after;
      set({ state: result.state, guestsCanControl: result.state.guestsCanControl });
      if (jam.get().listenAlong) follow(result.state);
    }
  } catch (error) {
    if (session === remote && error instanceof JamRelayError && [403, 404].includes(error.status)) {
      void leaveJam();
      notify('Le Jam est terminé.');
    }
  } finally { session.polling = false; }
}

export async function startJam(atDistance = false) {
  await leaveJam();
  participants = [];
  for (const id of Object.keys(addedBy)) delete addedBy[id];
  if (atDistance) await connectRemote(true);
  else {
    const { port, addresses } = await api.jamHost(name());
    set({ role: 'host', port, addresses });
  }
  broadcast();
  heartbeat = setInterval(() => {
    const { queue, index, playing } = playerState.get();
    const signature = queue.slice(Math.max(index, 0), Math.max(index, 0) + 200).map(t => t.id).join(',') + '|0|' + playing;
    if (signature !== lastSignature || Date.now() - (jam.get().state?.sentAt ?? 0) > 3000) broadcast();
  }, 1000);
}

export async function joinRemoteJam(room: RemoteRoom) {
  set({ connecting: true });
  try { await leaveJam(); await connectRemote(false, room.id); }
  catch (error) { notify(error instanceof JamRelayError ? error.message : 'Connexion au Jam impossible.'); }
  finally { set({ connecting: false }); }
}

export function setGuestsCanControl(value: boolean) {
  set({ guestsCanControl: value });
  if (jam.get().role === 'host') broadcast();
}

export async function joinJam(target: NearbyJam) {
  set({ connecting: true });
  try {
    await api.jamJoin(target.address, target.port, name());
    set({ role: 'guest', connecting: false });
    void api.jamStopBrowsing();
  } catch {
    set({ connecting: false });
    notify('Impossible de rejoindre ce Jam.');
  }
}

export function setListenAlong(value: boolean) {
  set({ listenAlong: value });
  player.followingJam = value;
  const state = jam.get().state;
  if (value && state) follow(state);
}

function follow(state: JamState) {
  const elapsed = state.playing ? Math.min(Math.max((Date.now() - state.sentAt) / 1000, 0), 5) : 0;
  player.followJam(state.queue, state.index, state.position + elapsed, state.playing);
}

export function addToJam(track: Track, next = false) {
  const role = jam.get().role;
  if (role === 'host') {
    addedBy[track.id] = name();
    next ? player.playNext(track) : player.enqueue([track]);
    broadcast();
  } else if (role === 'guest') {
    sendToHost({ type: 'add', track, next });
    notify(`« ${track.title} » ajouté au Jam`);
  }
}

export function jamCommand(command: 'play' | 'pause' | 'next' | 'previous') {
  sendToHost({ type: 'command', command });
}

function sendToHost(event: object) {
  if (remote) void jamRelay(remote.circle, { action: 'send', room: remote.id, token: remote.token, event })
    .catch(() => notify('Le Jam ne répond pas.'));
  else void api.jamToHost(event);
}

export async function leaveJam() {
  clearInterval(heartbeat);
  heartbeat = undefined;
  clearInterval(pollTimer);
  const session = remote;
  remote = undefined;
  if (session) void jamRelay(session.circle, { action: 'leave', room: session.id, token: session.token }).catch(() => undefined);
  await api.jamStop();
  player.followingJam = false;
  set({ role: 'none', state: undefined, listenAlong: false, port: undefined, remote: false });
}

// Messages du processus principal.
on('jam:nearby', (list: NearbyJam[]) => set({ nearby: list }));
on('jam:participants', (list: string[]) => {
  participants = list;
  if (jam.get().role === 'host') broadcast();
});
on('jam:info', (message: string) => notify(message));
function fromGuest(message: any, guest: string) {
  if (jam.get().role !== 'host') return;
  if (message.type === 'hello') notify(`${message.name} a rejoint le Jam`);
  if (message.type === 'add' && message.track) {
    addedBy[message.track.id] = guest;
    message.next ? player.playNext(message.track) : player.enqueue([message.track]);
  }
  if (message.type === 'command' && jam.get().guestsCanControl) {
    if (message.command === 'play') player.resume();
    if (message.command === 'pause') player.pause();
    if (message.command === 'next') player.next();
    if (message.command === 'previous') player.previous();
  }
  broadcast();
}
on('jam:fromGuest', fromGuest);
on('jam:fromHost', (message: any) => {
  if (message.type === 'state') {
    set({ state: message.state, guestsCanControl: message.guestsCanControl });
    if (jam.get().listenAlong) follow(message.state);
  }
  if (message.type === 'ended') {
    void leaveJam();
    notify('Le Jam est terminé');
  }
});
on('jam:ended', () => {
  if (jam.get().role === 'guest') {
    void leaveJam();
    notify('Connexion au Jam perdue');
  }
});

export const jamCurrent = () => currentTrack();
