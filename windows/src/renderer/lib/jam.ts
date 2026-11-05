// Jam côté interface : l'hôte joue la musique et diffuse l'état ; les invités ajoutent des titres,
// pilotent la lecture si l'hôte le permet, et peuvent écouter en même temps.
import type { JamState, NearbyJam, Track } from '../../shared/types';
import { api, on } from './api';
import { library, notify } from './library';
import { currentTrack, player, playerState, timeState } from './player';
import { Store } from './store';

export interface JamView {
  role: 'none' | 'host' | 'guest';
  nearby: NearbyJam[];
  state?: JamState;
  addresses: string[];
  port?: number;
  guestsCanControl: boolean;
  listenAlong: boolean;
  connecting: boolean;
}

export const jam = new Store<JamView>({ role: 'none', nearby: [], addresses: [], guestsCanControl: true, listenAlong: false, connecting: false });
const set = (change: Partial<JamView>) => jam.set((s) => ({ ...s, ...change }));

let participants: string[] = [];
const addedBy: Record<string, string> = {};
let heartbeat: ReturnType<typeof setInterval> | undefined;
let lastSignature = '';

const name = () => library.get().settings.jamName.trim() || 'Ami Nova';

function hostState(): JamState {
  const { queue, index, playing } = playerState.get();
  return {
    hostName: name(), queue: queue.slice(0, 200), index, playing, position: timeState.get().time, sentAt: Date.now(),
    participants, addedBy: { ...addedBy },
  };
}

function broadcast() {
  const state = hostState();
  set({ state });
  lastSignature = `${state.queue.map((t) => t.id).join(',')}|${state.index}|${state.playing}`;
  void api.jamBroadcast({ type: 'state', state, guestsCanControl: jam.get().guestsCanControl });
}

export async function startJam() {
  await leaveJam();
  const { port, addresses } = await api.jamHost(name());
  participants = [];
  set({ role: 'host', port, addresses });
  broadcast();
  heartbeat = setInterval(() => {
    const { queue, index, playing } = playerState.get();
    const signature = `${queue.map((t) => t.id).join(',')}|${index}|${playing}`;
    if (signature !== lastSignature || Date.now() - (jam.get().state?.sentAt ?? 0) > 3000) broadcast();
  }, 1000);
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
    void api.jamToHost({ type: 'add', track, next });
    notify(`« ${track.title} » ajouté au Jam`);
  }
}

export function jamCommand(command: 'play' | 'pause' | 'next' | 'previous') {
  void api.jamToHost({ type: 'command', command });
}

export async function leaveJam() {
  clearInterval(heartbeat);
  heartbeat = undefined;
  await api.jamStop();
  player.followingJam = false;
  set({ role: 'none', state: undefined, listenAlong: false, port: undefined });
}

// Messages du processus principal.
on('jam:nearby', (list: NearbyJam[]) => set({ nearby: list }));
on('jam:participants', (list: string[]) => {
  participants = list;
  if (jam.get().role === 'host') broadcast();
});
on('jam:info', (message: string) => notify(message));
on('jam:fromGuest', (message: any, guest: string) => {
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
});
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
