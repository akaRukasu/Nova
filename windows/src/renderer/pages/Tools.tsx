// Import depuis d'autres plateformes, concerts, Jam, réglages.
import { useEffect, useState } from 'react';
import type { Concert, ImportedPlaylist, ImportedTrack, ImportProgress, OctaveAudioSettings, Track } from '../../shared/types';
import { octaveAudioDefaults } from '../../shared/octave';
import { Icon } from '../components/icons';
import { EQ_PRESETS } from '../lib/equalizer';
import { api, isAndroid, on, supportsOctave } from '../lib/api';
import { jam, jamCommand, joinJam, joinJamInvitation, joinRemoteJam, leaveJam, openJamInvitation, refreshJamCircle, saveJamCircle, setGuestsCanControl, setListenAlong, startJam } from '../lib/jam';
import { account, importIntoPlaylist, library, mergeFromPhone, notify, phoneSync, refreshAccount, updateSettings, upsertPlaylist } from '../lib/library';
import { player } from '../lib/player';
import { pairPCHistory, pcHistory, syncPCHistory, unpairPCHistory } from '../lib/pcHistory';
import QRCode from 'qrcode';
import { useStore } from '../lib/store';
import { Artwork } from '../components/Artwork';
import { ask } from '../components/menus';
import { Empty, PageTitle } from './common';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// MARK: - Import

export function ImportPage() {
  const user = useStore(account);
  const [link, setLink] = useState('');
  const [found, setFound] = useState<ImportedPlaylist[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<Record<string, ImportProgress>>({});
  const [running, setRunning] = useState(false);
  const [toAccount, setToAccount] = useState(true);
  const [outcomes, setOutcomes] = useState<Record<string, { added: number; alreadyPresent: number; duplicates: number }>>({});

  useEffect(() => on('import:progress', (p: ImportProgress) => setProgress((all) => ({ ...all, [p.name]: p }))), []);

  const load = async (task: () => Promise<ImportedPlaylist[]>) => {
    setBusy(true);
    setError(undefined);
    try {
      const lists = await task();
      setFound(lists);
      setSelected(new Set(lists.map((_, i) => i)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    const chosen = found.filter((_, i) => selected.has(i)).map(playlist => ({
      ...playlist,
      existingYoutubeId: library.get().playlists.find(p => p.name.trim().toLowerCase() === playlist.name.trim().toLowerCase())?.youtubeId,
    }));
    setRunning(true);
    setProgress({});
    try {
      const results = await api.runImport(chosen, toAccount && user.signedIn);
      const done: typeof outcomes = {};
      for (const result of results) if (result.tracks.length) done[result.name] = importIntoPlaylist(result.name, result.tracks, result.youtubeId);
      setOutcomes(done);
      const added = Object.values(done).reduce((sum, o) => sum + o.added, 0);
      const present = Object.values(done).reduce((sum, o) => sum + o.alreadyPresent, 0);
      notify(`${added} titre${added > 1 ? 's' : ''} ajouté${added > 1 ? 's' : ''}${present ? `, ${present} déjà présent${present > 1 ? 's' : ''}` : ''} dans ${results.length} playlist${results.length > 1 ? 's' : ''}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="page narrow">
      <PageTitle>Importer</PageTitle>
      <PhoneTransfer />
      <h3 className="section-title">Depuis une autre plateforme</h3>
      <p className="muted">Copie le lien d’une playlist ou d’un album <b>Spotify</b>, <b>Deezer</b> (ou ton profil Deezer), <b>Apple Music</b> ou <b>YouTube</b>,
        ou ouvre un export CSV, TXT ou JSON. Nova cherche d’abord sur Octave, puis sur YouTube Music. Un nouvel import complète la playlist du même nom et corrige les correspondances, sans doublons.</p>
      <form className="import-form" onSubmit={(e) => { e.preventDefault(); if (link.trim()) void load(() => api.importLink(link)); }}>
        <input placeholder="https://open.spotify.com/playlist/…" value={link} onChange={(e) => setLink(e.target.value)} />
        <button className="button" disabled={busy || !link.trim()}>Lire le lien</button>
        <button type="button" className="button secondary" disabled={busy} onClick={() => void load(() => api.importFile())}><Icon name="import" size={16} /> Ouvrir un fichier</button>
      </form>
      {busy && <p className="muted"><span className="spinner" /> Lecture…</p>}
      {error && <p className="error">{error}</p>}
      {found.length > 0 && (
        <section className="import-list">
          {found.map((playlist, i) => {
            const state = progress[playlist.name];
            return (
              <label key={i} className="import-item">
                <input type="checkbox" checked={selected.has(i)} disabled={running}
                  onChange={() => setSelected((s) => { const next = new Set(s); next.has(i) ? next.delete(i) : next.add(i); return next; })} />
                <div>
                  <strong>{playlist.name}</strong>
                  <span className="muted"> · {playlist.source} · {playlist.tracks.length} titres</span>
                  {state && (
                    <div className="import-progress">
                      <progress max={state.total} value={state.processed} />
                      <span className="muted small">
                        {state.verifying ? `Vérification : nouvelle recherche des titres pas encore trouvés… (${state.matched} / ${state.total} trouvés)`
                          : state.done && !state.missing.length ? `✓ tous les titres trouvés (${state.matched} / ${state.total})`
                          : `${state.matched} / ${state.total} trouvés${state.missing.length ? `, ${state.missing.length} introuvables` : ''}${state.done ? ' · terminé' : ''}`}
                        {outcomes[playlist.name] && ` · ${outcomes[playlist.name].added} ajoutés`}
                        {outcomes[playlist.name]?.alreadyPresent ? ` · ${outcomes[playlist.name].alreadyPresent} déjà présents (non doublés)` : ''}
                        {outcomes[playlist.name]?.duplicates ? ` · ${outcomes[playlist.name].duplicates} doublons ignorés` : ''}
                      </span>
                      {state.done && state.missing.length > 0 && <MissingTracks missing={state.missing} playlistName={playlist.name} />}
                    </div>
                  )}
                </div>
              </label>
            );
          })}
          {user.signedIn && (
            <label className="toggle-row"><input type="checkbox" checked={toAccount} onChange={(e) => setToAccount(e.target.checked)} />
              Créer aussi les playlists sur mon compte YouTube (visibles sur l’iPhone)</label>
          )}
          <div className="row-buttons">
            <button className="button" disabled={running || !selected.size} onClick={() => void start()}>
              {running ? 'Import en cours…' : `Importer ${selected.size} playlist${selected.size > 1 ? 's' : ''}`}
            </button>
            {running && <button className="button secondary" onClick={() => void api.cancelImport()}>Arrêter</button>}
          </div>
        </section>
      )}
    </div>
  );
}

/** Bibliothèque de l'iPhone : association une fois par QR code, puis envois automatiques. */
export function PhoneTransfer() {
  const sync = useStore(phoneSync);
  const [pairing, setPairing] = useState<{ link: string; address: string; paired: boolean; phoneName?: string; lastSync?: number }>();
  const [qr, setQr] = useState<string>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<string>();
  const [network, setNetwork] = useState<{ publicNetworks: string[]; allowed: boolean }>();
  const [allowing, setAllowing] = useState(false);
  useEffect(() => { if (!isAndroid) void api.phoneNetwork().then(setNetwork).catch(() => undefined); }, []);

  const allowNetwork = async () => {
    setAllowing(true);
    const ok = await api.allowPhoneNetwork().catch(() => false);
    setAllowing(false);
    setNetwork(await api.phoneNetwork().catch(() => network));
    if (ok) setResult('Nova est autorisé sur tous les réseaux : l’iPhone peut le joindre, même en partage de connexion.');
    else setError('Autorisation non accordée (Windows demande la confirmation de l’administrateur).');
  };

  const refresh = async () => {
    const found = await api.phonePairing();
    setPairing(found);
    return found;
  };
  useEffect(() => { void refresh().catch(() => undefined); }, [sync.lastSync]);

  const show = async () => {
    setError(undefined);
    try {
      const found = await refresh();
      setQr(await QRCode.toDataURL(found.link, { margin: 1, width: 240, errorCorrectionLevel: 'M' }));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const openFile = async () => {
    try {
      const raw = await api.openPhoneExport();
      if (!raw) return;
      const summary = mergeFromPhone(raw);
      setResult(`Bibliothèque de l’iPhone importée : ${summary.playlists} playlists, ${summary.tracks} morceaux.`);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const last = sync.lastSync ?? pairing?.lastSync;
  const paired = pairing?.paired || !!sync.lastSync;
  return (
    <>
    {isAndroid && <PCHistoryTransfer />}
    <section className="phone-transfer">
      <div>
        <h3>Depuis l’iPhone</h3>
        {paired ? (
          <p className="muted">
            <b className="success">Associé à {sync.phoneName ?? pairing?.phoneName ?? 'ton iPhone'}.</b> Les nouveaux titres, playlists et likes arrivent tout seuls
            quand Nova est ouvert sur les deux appareils, sur le même Wi-Fi.
            {last ? ` Dernière synchronisation : ${new Date(last).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })}.` : ''}
          </p>
        ) : (
          <p className="muted">Associe ton iPhone une fois : scanne le QR code avec l’appareil photo de l’iPhone et confirme dans Nova.
            Ensuite, tout ce que tu ajoutes sur l’iPhone (playlists, titres likés, historique, albums et artistes suivis) arrive ici automatiquement,
            sur le même Wi-Fi. Rien n’est doublé.</p>
        )}
        <div className="row-buttons">
          <button className="button" onClick={() => void show()}><Icon name="import" size={16} /> {paired ? 'Afficher le QR code' : 'Associer l’iPhone'}</button>
          {!isAndroid && <button className="button secondary" onClick={() => void refresh().then(found =>
            navigator.clipboard.writeText(found.link)).then(() => setResult('Lien d’association copié. Colle-le dans Nova sur Android.')).catch(error => setError(errorText(error)))}>Copier le lien pour Android</button>}
          <button className="button secondary" onClick={() => void openFile()}>Ouvrir un export de l’iPhone</button>
          {paired && <button className="button secondary danger" onClick={() => void api.unpairPhone().then(refresh).then(() => setQr(undefined))}>Dissocier</button>}
        </div>
        {network && !network.allowed && (network.publicNetworks.length > 0 ? (
          <div className="network-warning">
            <p><b>Windows bloque l’iPhone sur ce réseau</b> (« {network.publicNetworks.join(', ')} », classé public, comme souvent un partage de connexion) :
              il ne peut ni envoyer ses titres ni piloter la lecture.</p>
            <button className="button" disabled={allowing} onClick={() => void allowNetwork()}>{allowing ? 'Confirme dans la fenêtre de Windows…' : 'Autoriser Nova sur tous les réseaux'}</button>
          </div>
        ) : (
          <p className="muted small">L’iPhone ne trouve pas ce PC (partage de connexion, autre réseau) ?{' '}
            <button className="link" disabled={allowing} onClick={() => void allowNetwork()}>Autoriser Nova sur tous les réseaux</button></p>
        ))}
        {qr && <p className="muted small">Scanne avec l’appareil photo de l’iPhone, puis confirme dans Nova.{isAndroid ? '' : ' Si Windows le demande, autorise Nova sur le réseau privé.'} ({pairing?.address})</p>}
        {result && <p className="success">{result}</p>}
        {error && <p className="error">{error}</p>}
      </div>
      {qr && <img className="qr" src={qr} data-link={pairing?.link} alt="QR code à scanner avec l’iPhone" />}
    </section>
    </>
  );
}

function PCHistoryTransfer() {
  const status = useStore(pcHistory);
  const [link, setLink] = useState('');
  const [error, setError] = useState<string>();
  return <section className="phone-transfer">
    <div>
      <h3>Historique avec le PC</h3>
      <p className="muted">{status.name
        ? `Associé à ${status.name}. L’historique s’échange quand Nova est ouvert sur les deux appareils, sur le réseau local.`
        : 'Sur ton PC, ouvre Importer puis copie le lien pour Android et colle-le ici pour partager ton historique.'}</p>
      {!status.name && <div className="row-buttons">
        <input type="password" autoComplete="off" aria-label="Lien d’association du PC" value={link}
          placeholder="Lien d’association Nova" onChange={event => setLink(event.target.value)} />
        <button className="button" disabled={!link.trim() || status.syncing} onClick={() => {
          setError(undefined);
          void pairPCHistory(link).then(() => setLink('')).catch(error => setError(errorText(error)));
        }}>Associer le PC</button>
      </div>}
      {status.name && <div className="row-buttons">
        <button className="button" disabled={status.syncing} onClick={() => void syncPCHistory()}>
          {status.syncing ? 'Synchronisation…' : 'Synchroniser maintenant'}</button>
        <button className="button secondary" disabled={status.syncing} onClick={unpairPCHistory}>Dissocier</button>
      </div>}
      {status.lastSync && <p className="success">Historique synchronisé à {new Date(status.lastSync).toLocaleTimeString('fr-FR')}.</p>}
      {(error || status.error) && <p className="error" role="status">{error || status.error}</p>}
    </div>
  </section>;
}

/** Titres introuvables : nouvel essai, ou choix à la main parmi les résultats de recherche. */
function MissingTracks({ missing, playlistName }: { missing: ImportedTrack[]; playlistName: string }) {
  const [openList, setOpenList] = useState(false);
  const [results, setResults] = useState<Record<number, Track[]>>({});
  const addTrack = (track: Track) => {
    const playlist = library.get().playlists.find((p) => p.name === playlistName);
    upsertPlaylist(playlistName, [...(playlist?.tracks ?? []), track], playlist?.youtubeId);
    notify(`« ${track.title} » ajouté`);
  };
  return (
    <div className="missing">
      <button type="button" className="text-button" onClick={() => setOpenList(!openList)}>{openList ? 'Masquer' : 'Voir'} les titres introuvables</button>
      {openList && missing.map((wanted, i) => (
        <div key={i} className="missing-row">
          <span>{wanted.artist} — {wanted.title}</span>
          <button type="button" className="text-button" onClick={async () => {
            const shelves = await api.search(`${wanted.title} ${wanted.artist}`, 'song').catch(() => []);
            setResults((r) => ({ ...r, [i]: shelves.flatMap((s) => s.items.flatMap((it) => (it.type === 'track' ? [it.track] : []))).slice(0, 5) }));
          }}>Chercher</button>
          {results[i]?.map((track) => (
            <button type="button" key={track.id} className="choice" onClick={() => addTrack(track)}>
              <Artwork track={track} size={28} radius={4} /> {track.title} · {track.artist}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// MARK: - Concerts

export function ConcertsPage({ artist: initial }: { artist?: string }) {
  const state = useStore(library);
  const [artist, setArtist] = useState(initial ?? '');
  const [city, setCity] = useState(localStorage.getItem('concertCity') ?? '');
  const [concerts, setConcerts] = useState<Concert[] | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const key = state.settings.ticketmasterKey;

  const run = async (artistName = artist) => {
    setBusy(true);
    setError(undefined);
    localStorage.setItem('concertCity', city);
    try {
      setConcerts(await api.concerts({ artist: artistName || undefined, city: city || undefined, key }));
    } catch (e) {
      setError(errorText(e));
      setConcerts([]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { if (initial && key) void run(initial); }, [initial]);

  const myArtists = [...new Set(state.recents.map((t) => t.artist.split(/,| et | & /)[0].trim()))].slice(0, 12);
  const byMonth = new Map<string, Concert[]>();
  for (const concert of concerts ?? []) {
    const month = concert.date ? new Date(concert.date).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }) : 'Date inconnue';
    byMonth.set(month, [...(byMonth.get(month) ?? []), concert]);
  }
  return (
    <div className="page narrow">
      <PageTitle>Concerts</PageTitle>
      {!key && <p className="error">Ajoute ta clé Ticketmaster gratuite dans les Réglages (developer.ticketmaster.com).</p>}
      <form className="import-form" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <input placeholder="Artiste (vide : tous les concerts)" value={artist} onChange={(e) => setArtist(e.target.value)} />
        <input placeholder="Ville (ex. Paris)" value={city} onChange={(e) => setCity(e.target.value)} />
        <button className="button" disabled={busy || !key}>Rechercher</button>
      </form>
      {myArtists.length > 0 && <div className="chips">{myArtists.map((a) => <button key={a} className="chip" onClick={() => { setArtist(a); void run(a); }}>{a}</button>)}</div>}
      {busy && <p className="muted"><span className="spinner" /> Recherche des concerts…</p>}
      {error && <p className="error">{error}</p>}
      {concerts && !concerts.length && !error && <p className="muted">Aucun concert trouvé. Essaie sans ville, ou une autre orthographe.</p>}
      {[...byMonth].map(([month, items]) => (
        <section key={month} className="concert-month">
          <h3>{month.charAt(0).toUpperCase() + month.slice(1)}</h3>
          {items.map((concert) => (
            <div key={concert.id} className="concert-row" onClick={() => concert.url && void api.openExternal(concert.url)}>
              {concert.image ? <img src={concert.image} alt="" /> : <div className="artwork placeholder" style={{ width: 64, height: 64 }}><Icon name="ticket" /></div>}
              <div>
                <strong>{concert.name}</strong>
                <p className="muted">{concert.date && new Date(concert.date).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: concert.date.includes('T') ? '2-digit' : undefined, minute: concert.date.includes('T') ? '2-digit' : undefined })}</p>
                <p className="muted">{concert.place} · {concert.city}</p>
              </div>
              {concert.url && <span className="button secondary small">Billets</span>}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

// MARK: - Jam

function JamInvitationCard({ invitation }: { invitation: string }) {
  const [qr, setQr] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(invitation, { width: 400, margin: 4, errorCorrectionLevel: 'M' })
      .then(code => { if (active) setQr(code); })
      .catch(() => { if (active) setError('Le QR code est indisponible. Tu peux copier le lien.'); });
    return () => { active = false; };
  }, [invitation]);

  const copy = async () => {
    try {
      await api.copyJamInvitation(invitation);
      setCopied(true);
    } catch {
      setCopied(false);
      setError('Impossible de copier le lien.');
    }
  };
  return <section className="jam-panel jam-invitation">
    {qr && <img src={qr} alt="QR code d’invitation au Jam" width={188} height={188} />}
    <div>
      <h2>Invitation au Jam</h2>
      <p className="muted">Scanne le QR code avec l’appareil photo ou partage le lien.</p>
      <button className="button secondary" onClick={() => void copy()}><Icon name="share" size={16} /> Copier le lien</button>
      <span role="status">{copied ? 'Lien copié' : error}</span>
      <input className="jam-invitation-link" readOnly aria-label="Lien d’invitation au Jam" value={invitation}
        onFocus={event => event.currentTarget.select()} />
    </div>
  </section>;
}

export function JamPage() {
  const state = useStore(jam);
  const settings = useStore(library).settings;
  const [circle, setCircle] = useState(state.circleLink ?? '');
  const [launching, setLaunching] = useState(false);
  const [circleError, setCircleError] = useState<string>();
  const [launchError, setLaunchError] = useState<string>();
  const [configuringCircle, setConfiguringCircle] = useState(false);
  const [createAfterSetup, setCreateAfterSetup] = useState(false);
  useEffect(() => {
    if (state.role !== 'none') return;
    void api.jamBrowse();
    void refreshJamCircle();
    const timer = setInterval(() => void refreshJamCircle(), 2500);
    return () => { clearInterval(timer); void api.jamStopBrowsing(); };
  }, [state.role, state.circleLink]);
  const launch = async (atDistance: boolean) => {
    setLaunching(true);
    setLaunchError(undefined);
    try { await startJam(atDistance); } catch (error) {
      if (atDistance) setLaunchError(errorText(error));
      else notify(errorText(error));
    }
    finally { setLaunching(false); }
  };
  const shared = state.state;
  const queue = shared ? shared.queue.slice(shared.index) : [];
  return (
    <div className="page jam-page">
      <header className="jam-hero">
        <span className="jam-hero-icon"><Icon name="jam" size={30} /></span>
        <div><p>Jam Nova</p><h1>Écoutez ensemble</h1><span>Une file commune. Chacun peut proposer le prochain titre.</span></div>
      </header>
      {state.pendingInvitation && <section className="jam-panel">
        <h2>Invitation à un Jam</h2>
        <button className="button" disabled={state.connecting} onClick={() => void joinJamInvitation()}>Rejoindre la session</button>
      </section>}
      {state.role === 'none' && (
        <div className="jam-start">
          <label className="field">Ton prénom
            <input value={settings.jamName} placeholder="Visible par les autres" onChange={(e) => updateSettings({ jamName: e.target.value })} />
          </label>
          <div className="jam-options">
            <section className="jam-panel">
              <h2>À distance</h2>
              <p className="muted">Retrouve les Jams des amis de ton cercle, où qu’ils soient.</p>
              <button className="button" disabled={launching || state.connecting} onClick={() => {
                if (state.circleLink) void launch(true);
                else { setCreateAfterSetup(true); setConfiguringCircle(true); }
              }}>{launching ? 'Création en cours…' : 'Créer un Jam à distance'}</button>
              {configuringCircle ? <form className="jam-setup" onSubmit={event => {
                event.preventDefault();
                try {
                  saveJamCircle(circle);
                  setCircleError(undefined);
                  setConfiguringCircle(false);
                  setCreateAfterSetup(false);
                  if (createAfterSetup) void launch(true);
                } catch (error) { setCircleError(errorText(error)); }
              }}>
                <label className="field">Lien du cercle hôte
                  <input type="password" autoComplete="off" autoFocus required={createAfterSetup} value={circle} onChange={event => setCircle(event.target.value)}
                    placeholder="Colle le lien de configuration" />
                </label>
                <button className="button secondary" type="submit">{createAfterSetup ? 'Enregistrer et créer le Jam' : 'Enregistrer le lien'}</button>
              </form> : state.circleLink && <button className="button secondary" onClick={() => {
                setCircle(state.circleLink ?? '');
                setConfiguringCircle(true);
              }}>Configuration hôte</button>}
              <button className="button secondary" onClick={async () => {
                const link = await ask('Lien d’invitation à un Jam', '', 'Ouvrir');
                if (link && !openJamInvitation(link)) notify('Ce lien ne correspond pas à une invitation Jam.');
              }}>J’ai un lien d’invitation</button>
              {(circleError || launchError || state.relayError) && <p role="status" className="muted">{circleError ?? launchError ?? state.relayError}</p>}
              {state.circleLink && !state.relayError && !state.remoteRooms?.length && <p className="muted">Aucun Jam ouvert dans ton cercle.</p>}
              {state.remoteRooms?.map(room => <div className="jam-row" key={room.id}>
                <Icon name="jam" size={18} /><strong>{room.name} <small className="muted">· {room.people} en ligne</small></strong>
                <button className="button secondary" disabled={state.connecting} onClick={() => void joinRemoteJam(room)}>Rejoindre</button>
              </div>)}
            </section>
            <section className="jam-panel">
          <h2>À proximité</h2>
          <p className="muted">Retrouve les Jams ouverts sur ton réseau.</p>
          <button className="button secondary" disabled={launching || state.connecting} onClick={() => void launch(false)}><Icon name="jam" size={18} /> Créer un Jam local</button>
          {!state.nearby.length && <p className="muted">Aucun Jam local pour le moment.</p>}
          {state.nearby.map((nearby) => (
            <div key={nearby.id} className="jam-row">
              <Icon name="jam" size={18} /> <strong>Jam de {nearby.name}</strong>
              <button className="button secondary" disabled={state.connecting} onClick={() => void joinJam(nearby)}>Rejoindre</button>
            </div>
          ))}
            </section>
          </div>
        </div>
      )}
      {state.role === 'host' && (
        <>
          <p className="eyebrow">Ton Jam est ouvert</p>
          <p className="muted">{state.remote ? 'Les membres de ton cercle voient ton Jam dans Nova.' : 'Tes amis sur le même réseau voient ton Jam dans Nova.'}</p>
          {state.invitation && <JamInvitationCard key={state.invitation} invitation={state.invitation} />}
          <div className="chips">{(shared?.participants ?? []).map((p) => <span key={p} className="chip on"><Icon name="person" size={13} /> {p}</span>)}
            {!shared?.participants.length && <span className="muted">En attente d’amis…</span>}</div>
          <label className="toggle-row"><input type="checkbox" checked={state.guestsCanControl} onChange={(e) => setGuestsCanControl(e.target.checked)} /> Les invités contrôlent la lecture</label>
          <button className="button secondary danger" onClick={() => void leaveJam(true)}>Terminer le Jam</button>
        </>
      )}
      {state.role === 'guest' && (
        <>
          <p className="eyebrow">Jam de {shared?.hostName ?? '…'}</p>
          <label className="toggle-row"><input type="checkbox" checked={state.listenAlong} onChange={(e) => setListenAlong(e.target.checked)} /> Écouter sur cet appareil</label>
          {state.guestsCanControl && (
            <div className="controls">
              <button onClick={() => jamCommand('previous')}><Icon name="previous" size={22} /></button>
              <button className="play-button" onClick={() => jamCommand(shared?.playing ? 'pause' : 'play')}><Icon name={shared?.playing ? 'pause' : 'play'} size={24} /></button>
              <button onClick={() => jamCommand('next')}><Icon name="next" size={22} /></button>
            </div>
          )}
          <p className="muted">Pour ajouter un titre : clic droit sur un titre → « Ajouter au Jam ».</p>
          <button className="button secondary danger" onClick={() => void leaveJam(true)}>Quitter le Jam</button>
        </>
      )}
      {queue.length > 0 && (
        <section>
          <h3>File commune</h3>
          {queue.slice(0, 40).map((track, i) => (
            <div key={`${track.id}-${i}`} className="queue-row">
              <Artwork track={track} size={40} radius={5} />
              <div className="row-text"><div className="row-title">{i === 0 ? '▶ ' : ''}{track.title}</div>
                <div className="row-subtitle">{track.artist}{shared?.addedBy[track.id] ? ` · ajouté par ${shared.addedBy[track.id]}` : ''}</div></div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

// MARK: - Réglages

const regions: [string, string][] = [['FR', 'France'], ['BE', 'Belgique'], ['CH', 'Suisse'], ['CA', 'Canada'], ['LU', 'Luxembourg'], ['US', 'États-Unis'],
  ['GB', 'Royaume-Uni'], ['DE', 'Allemagne'], ['ES', 'Espagne'], ['IT', 'Italie'], ['MA', 'Maroc'], ['SN', 'Sénégal'], ['CI', 'Côte d’Ivoire']];

export function SettingsPage() {
  const state = useStore(library);
  const user = useStore(account);
  const settings = state.settings;
  const octave = { ...octaveAudioDefaults, ...settings.octaveAudio };
  const setOctave = (patch: Partial<OctaveAudioSettings>) => updateSettings({ octaveAudio: { ...octave, ...patch } });
  return (
    <div className="page narrow settings">
      <PageTitle>Réglages</PageTitle>
      <section>
        <h3>Compte YouTube</h3>
        {user.signedIn ? (
          <div className="account-row">
            {user.photo && <img className="avatar large" src={user.photo} alt="" />}
            <div><strong>{user.name || 'Connecté'}</strong><p className="muted">Likes et playlists synchronisés avec l’iPhone via ton compte.</p></div>
            <button className="button secondary" onClick={() => void api.logout().then(refreshAccount)}>Se déconnecter</button>
          </div>
        ) : (
          <div className="account-row">
            <p className="muted">Connecte-toi pour retrouver tes likes, tes playlists et tes recommandations, comme sur l’iPhone.</p>
            <button className="button" onClick={() => void api.login().then(async (ok) => { if (ok) await refreshAccount(); })}>Se connecter</button>
          </div>
        )}
      </section>
      <section>
        {supportsOctave && <>
          <h3>Lecture Octave</h3>
          <label className="field">Source des playlists
            <select value={settings.playlistSource ?? 'octave'} onChange={(e) => updateSettings({
              playlistSource: e.target.value === 'youtube' ? 'youtube' : 'octave',
            })}>
              <option value="octave">Octave</option>
              <option value="youtube">YouTube Music</option>
            </select>
          </label>
          <label className="field">Qualité Octave
            <select value={octave.quality} onChange={(e) => setOctave({ quality: e.target.value as OctaveAudioSettings['quality'] })}>
              <option value="low">Économie de données</option>
              <option value="high">Haute</option>
              <option value="lossless">Lossless (FLAC)</option>
            </select>
          </label>
          <label className="field">Transitions Octave
            <select value={octave.transition} onChange={(e) => setOctave({ transition: e.target.value as OctaveAudioSettings['transition'] })}>
              <option value="off">Désactivées</option>
              <option value="crossfade">Fondu enchaîné</option>
              <option value="automix">AutoMix</option>
            </select>
          </label>
          {octave.transition === 'automix' && <label className="field">Style AutoMix
            <select value={octave.automixStyle ?? 'apple'} onChange={event => setOctave({ automixStyle: event.target.value as OctaveAudioSettings['automixStyle'] })}>
              <option value="legacy">Octave · phrases courtes</option>
              <option value="automatic">Automatique</option>
              <option value="apple">Apple · phrases longues</option>
            </select>
          </label>}
          {([
            ['autoplay', 'Autoplay · continuer avec des morceaux similaires'],
            ['gapless', 'Lecture sans blanc entre les morceaux'],
            ['soundCheck', 'Sound Check · égaliser le volume des morceaux'],
            ['smartShuffle', 'Smart Shuffle · insérer des recommandations'],
          ] as const).map(([key, label]) => (
            <label className="toggle-row" key={key}><input type="checkbox" checked={octave[key]}
              onChange={(e) => setOctave({ [key]: e.target.checked })} /> {label}</label>
          ))}
          <p className="muted small">Les changements s’appliquent pendant la lecture Octave.</p>
          <button className="button secondary" onClick={() => player.openOctave()}>Compte et réglages avancés Octave</button>
          <label className="toggle-row"><input type="checkbox" checked={settings.syncOctaveToYouTube !== false}
            disabled={!settings.recordHistory} onChange={(e) => updateSettings({ syncOctaveToYouTube: e.target.checked })} />
            Ajouter les écoutes Octave à mon historique YouTube Music</label>
          {!user.signedIn && <p className="muted small">Connecte ton compte YouTube dans Nova pour synchroniser les morceaux trouvés sur YouTube Music.</p>}
        </>}
        <h3>{supportsOctave ? 'Lecture YouTube Music' : 'Lecture'}</h3>
        <label className="field">Qualité audio
          <select value={settings.highQuality ? 'high' : 'low'} onChange={(e) => updateSettings({ highQuality: e.target.value === 'high' })}>
            <option value="high">Haute</option><option value="low">Économie de données</option>
          </select>
          <span className="muted small">Haute : le meilleur flux de YouTube Music, en général l’Opus (environ 160 kbit/s, plus fin que l’AAC
            à 128 kbit/s), 256 kbit/s avec YouTube Premium. Avec le lecteur officiel, la qualité est celle choisie dans les réglages de YouTube Music.</span>
        </label>
        <label className="field">Égaliseur
          <select value={settings.equalizer ?? 'off'} onChange={(e) => updateSettings({ equalizer: e.target.value })}>
            {EQ_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          </select>
          <span className="muted small">« Amélioration du son » donne plus de présence et de relief (basses et aigus un peu relevés), comme sur
            Apple Music. Le volume est légèrement ajusté pour ne jamais saturer. Désactivé : le son tel que YouTube le fournit.</span>
        </label>
        <label className="field">Transitions entre les titres
          <select value={settings.transition} onChange={(e) => updateSettings({ transition: e.target.value as typeof settings.transition })}>
            <option value="automix">AutoMix (DJ)</option><option value="crossfade">Fondu enchaîné</option><option value="off">Désactivées</option>
          </select>
          {settings.transition === 'automix' && (
            <span className="muted small">Nova analyse chaque titre (tempo, temps, intro, fin) : le suivant est calé sur le rythme de celui qui se
              termine, part sur un temps, et les basses s’échangent comme chez un DJ. Avec le lecteur officiel, un titre est analysé pendant
              sa première écoute ; les transitions deviennent calées dès qu’il revient.</span>
          )}
        </label>
        <label className="toggle-row"><input type="checkbox" checked={settings.normalizeVolume !== false} onChange={(e) => updateSettings({ normalizeVolume: e.target.checked })} /> Volume égalisé entre les titres (titres très forts baissés au niveau des autres)</label>
        {settings.transition === 'crossfade' && (
          <label className="field">Durée du fondu : {settings.crossfadeSeconds} s
            <input type="range" min={1} max={12} value={settings.crossfadeSeconds} onChange={(e) => updateSettings({ crossfadeSeconds: Number(e.target.value) })} />
          </label>
        )}
        {!isAndroid && <label className="field">Moteur de lecture
          <select value={settings.engine ?? 'auto'} onChange={(e) => updateSettings({ engine: e.target.value as typeof settings.engine })}>
            <option value="auto">Automatique (recommandé)</option>
            <option value="web">Lecteur officiel YouTube Music</option>
            <option value="direct">Flux direct</option>
          </select>
          <span className="muted small">Si YouTube refuse la lecture directe (« confirme que tu n’es pas un robot »), Nova passe tout seul au lecteur officiel
            de YouTube Music, avec ton compte. Sans YouTube Premium, ses publicités ont le son coupé et sont passées dès que YouTube le permet.</span>
        </label>}
        <label className="toggle-row"><input type="checkbox" checked={settings.autoplayRadio} onChange={(e) => updateSettings({ autoplayRadio: e.target.checked })} /> Lecture automatique (titres similaires à la fin de la file)</label>
        <label className="toggle-row"><input type="checkbox" checked={settings.recordHistory} onChange={(e) => updateSettings({ recordHistory: e.target.checked })} /> Historique d’écoute</label>
      </section>
      <section>
        <h3>Contenu</h3>
        <label className="field">Pays
          <select value={settings.region} onChange={(e) => updateSettings({ region: e.target.value })}>
            {regions.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </label>
        <label className="field">Langue
          <select value={settings.language} onChange={(e) => updateSettings({ language: e.target.value })}>
            <option value="fr">Français</option><option value="en">English</option><option value="es">Español</option><option value="de">Deutsch</option>
          </select>
        </label>
        <label className="field">Apparence
          <select value={settings.theme} onChange={(e) => updateSettings({ theme: e.target.value as typeof settings.theme })}>
            <option value="system">{isAndroid ? 'Comme le système' : 'Comme Windows'}</option><option value="dark">Sombre</option><option value="light">Clair</option>
          </select>
        </label>
      </section>
      <section>
        <h3>Concerts</h3>
        <label className="field">Clé Ticketmaster (gratuite sur developer.ticketmaster.com)
          <input type="password" value={settings.ticketmasterKey} onChange={(e) => updateSettings({ ticketmasterKey: e.target.value.trim() })} />
        </label>
      </section>
      <section>
        <h3>À propos</h3>
        <p className="muted">{isAndroid ? 'Nova pour Android 0.4.1' : 'Nova pour Windows 0.4.9'} · paroles LRCLIB · concerts Ticketmaster.</p>
      </section>
    </div>
  );
}

export { Empty };
