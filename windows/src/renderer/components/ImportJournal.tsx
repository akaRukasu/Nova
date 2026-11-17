import { useEffect, useState } from 'react';
import type { ImportJournalEntry, Track } from '../../shared/types';
import { api, on } from '../lib/api';
import { importIntoPlaylist } from '../lib/library';
import { Artwork } from './Artwork';

export function ImportJournal({ disabled, onBusy }: { disabled: boolean; onBusy: (value: boolean) => void }) {
  const [entries, setEntries] = useState<ImportJournalEntry[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState<string>();
  const [queries, setQueries] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Record<string, Track[]>>({});
  const refresh = () => api.importJournal().then(setEntries).catch(e => setError(String(e)));
  useEffect(() => {
    void refresh();
    return on('import:progress', progress => { if (progress.done) void refresh(); });
  }, []);
  const pending = entries.filter(entry => entry.status !== 'resolved');
  const visible = showResolved ? entries : pending;

  const retry = async (wanted: ImportJournalEntry[]) => {
    onBusy(true);
    setError(undefined);
    try {
      const groups = new Map<string, ImportJournalEntry[]>();
      for (const entry of wanted) {
        const key = JSON.stringify([entry.playlist, entry.source]);
        groups.set(key, [...(groups.get(key) ?? []), entry]);
      }
      const playlists = [...groups.values()].map(group => ({
        name: group[0].playlist, source: group[0].source, tracks: group.map(entry => entry.track),
      }));
      const results = await api.runImport(playlists, false);
      for (const result of results) if (result.tracks.length) importIntoPlaylist(result.name, result.tracks, result.youtubeId);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      onBusy(false);
    }
  };

  const choose = async (entry: ImportJournalEntry, track: Track) => {
    onBusy(true);
    try {
      const recording = { ...track, youtubeId: track.youtubeId ?? entry.track.youtubeId };
      importIntoPlaylist(entry.playlist, [recording]);
      await api.resolveImportJournal(entry.id, recording);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      onBusy(false);
    }
  };

  return <section className="import-journal">
    <h3 className="section-title">Journal des imports</h3>
    <p className="muted small">Les titres restés sans correspondance Octave sont conservés ici après la fermeture de Nova.</p>
    <div className="row-buttons">
      <button className="button secondary" disabled={disabled || !pending.length} onClick={() => void retry(pending)}>
        Relancer la recherche approfondie ({pending.length})
      </button>
      <label className="toggle-row"><input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)} /> Voir aussi les corrections terminées</label>
    </div>
    {error && <p className="error" role="status">{error}</p>}
    {!visible.length && <p className="muted small">{entries.length ? 'Toutes les correspondances du journal sont corrigées.' : 'Les prochains titres non retrouvés pendant un import apparaîtront ici.'}</p>}
    {visible.map(entry => <details key={entry.id} className="import-journal-entry">
      <summary>{entry.track.artist} — {entry.track.title} <span className="muted small">· {entry.status === 'resolved' ? 'Corrigé' : entry.status === 'youtube' ? 'Importé sur YouTube · Octave à vérifier' : 'À retrouver'}</span></summary>
      <p className="muted small">{entry.playlist} · {entry.source} · {new Date(entry.lastAttempt).toLocaleString('fr-FR')} · {entry.attempts} tentatives</p>
      <p className="small">{entry.reason}</p>
      {entry.recording && <p className="muted small">{entry.recording.artist} — {entry.recording.title}{entry.recording.album ? ' · ' + entry.recording.album : ''}</p>}
      {entry.status !== 'resolved' && <div className="row-buttons">
        <button className="button secondary small" disabled={disabled} onClick={() => void retry([entry])}>Réessayer</button>
        <input aria-label={'Rechercher ' + entry.track.title} value={queries[entry.id] ?? entry.track.title + ' ' + entry.track.artist}
          onChange={e => setQueries(previous => ({ ...previous, [entry.id]: e.target.value }))} />
        <button className="button secondary small" disabled={disabled} onClick={async () => {
          try {
            const result = await api.search(queries[entry.id] ?? entry.track.title + ' ' + entry.track.artist, 'song');
            setChoices(previous => ({ ...previous, [entry.id]: result.flatMap(s => s.items).flatMap(item => item.type === 'track' ? [item.track] : []).slice(0, 8) }));
          } catch (e) { setError(String(e)); }
        }}>Choisir sur Octave</button>
      </div>}
      {choices[entry.id]?.map(track => <button key={track.id} className="choice" disabled={disabled} onClick={() => void choose(entry, track)}>
        <Artwork track={track} size={28} radius={4} /> {track.artist} — {track.title} · {track.album}
      </button>)}
      {choices[entry.id]?.length === 0 && <p className="muted small">Aucun résultat pour cette recherche. Tu peux modifier le titre ou l’artiste.</p>}
    </details>)}
  </section>;
}

