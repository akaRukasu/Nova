import { useEffect, useState } from 'react';
import type { ExternalAppsSettings, ExternalAppsStatus } from '../../shared/externalApps';
import { api } from '../lib/api';
import { notify } from '../lib/library';

const messages: Record<ExternalAppsStatus['discordStatus'], string> = {
  off: 'Désactivé',
  'missing-id': 'Renseigne l’identifiant de l’application Discord.',
  waiting: 'En attente de l’application Discord sur ce PC.',
  ready: 'Connecté à Discord. Lance un morceau pour afficher ton écoute.',
  active: 'Discord a accepté l’activité en cours.',
  rejected: 'Discord a refusé l’activité. Vérifie l’identifiant de l’application ou relance Discord.',
};

export function ExternalApps() {
  const [status, setStatus] = useState<ExternalAppsStatus>();
  const [id, setId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let open = true;
    const refresh = () => {
      void window.nova.invoke<ExternalAppsStatus>('external:status')
        .then(value => { if (open) setStatus(value); })
        .catch(() => { if (open) setError('Réglages des applications externes indisponibles.'); });
    };
    refresh();
    const timer = setInterval(refresh, 2500);
    return () => { open = false; clearInterval(timer); };
  }, []);

  async function change(patch: Partial<ExternalAppsSettings>) {
    if (!status || busy) return;
    setBusy(true);
    setError('');
    try {
      setStatus(await window.nova.invoke<ExternalAppsStatus>('external:settings', { ...status.settings, ...patch }));
      if (patch.discordId !== undefined) setId(undefined);
    } catch { setError('Impossible d’enregistrer les réglages des applications externes.'); }
    finally { setBusy(false); }
  }

  return <section aria-label="Applications externes" className="external-apps">
    <h3>Applications externes</h3>
    {status && <>
      <div className="external-app">
        <label className="toggle-row">
          <input type="checkbox" checked={status.settings.nowPlaying} disabled={busy}
            onChange={event => void change({ nowPlaying: event.target.checked })} />
          <strong>Now Playing pour OBS</strong>
        </label>
        <p className="muted small">Affiche le titre, l’artiste et la pochette dans OBS. Nova peut aussi envoyer les événements de lecture compatibles Cider sur ce PC.</p>
        {status.obsURL && <div className="external-app-details">
          <label className="field">URL de la source Navigateur
            <input readOnly value={status.obsURL} onFocus={event => event.target.select()} />
          </label>
          <div className="row-buttons">
            <button className="button" onClick={() => void navigator.clipboard.writeText(status.obsURL!)
              .then(() => notify('Lien OBS copié')).catch(() => notify('Sélectionne l’URL pour la copier.'))}>Copier le lien OBS</button>
            <button className="button secondary" onClick={() => void api.openExternal(status.obsURL!)}>Aperçu</button>
            <button className="button secondary" onClick={() => void window.nova.invoke('external:open-folder')
              .catch(() => notify('Impossible d’ouvrir le dossier PlayingNow.'))}>Dossier PlayingNow</button>
          </div>
          <p className="muted small">Dans OBS, ajoute une source Navigateur de 400 × 100. Le widget reprend les couleurs de la pochette et affiche le temps écoulé et la durée du morceau. Pour un outil compatible Cider, indique 127.0.0.1 et le port {status.port}.</p>
        </div>}
        {status.error && <p className="error small" role="status">{status.error}</p>}
      </div>
      <div className="external-app">
        <label className="toggle-row">
          <input type="checkbox" checked={status.settings.discord} disabled={busy}
            onChange={event => void change({ discord: event.target.checked })} />
          <strong>Afficher mon écoute sur Discord</strong>
        </label>
        <p className="muted small">Le titre et l’artiste apparaissent dans ton activité Discord pendant la lecture.</p>
        <p className="muted small" role="status">{messages[status.discordStatus]}</p>
        <details>
          <summary>Configurer l’application Discord</summary>
          <label className="field">Identifiant de l’application
            <input inputMode="numeric" value={id ?? status.settings.discordId} onChange={e => setId(e.target.value)} />
          </label>
          <div className="row-buttons">
            <button className="button secondary" disabled={busy || !id || !/^\d{17,20}$/.test(id.trim())}
              onClick={() => void change({ discordId: id?.trim() })}>Enregistrer</button>
            <button className="button secondary" onClick={() => void api.openExternal('https://discord.com/developers/applications')}>Portail Discord</button>
          </div>
        </details>
      </div>
    </>}
    {error && <p className="error small" role="status">{error}</p>}
  </section>;
}
