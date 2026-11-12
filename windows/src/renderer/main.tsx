import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

/** Erreur d'affichage : un message lisible et un bouton pour recharger, plutôt qu'une fenêtre vide. */
class Guard extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  // Interface affichée : le processus principal arrête de surveiller le démarrage.
  componentDidMount() { void window.nova?.invoke('ui:ready').catch(() => undefined); }
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('Nova :', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h2>Nova a rencontré un problème d’affichage</h2>
        <p className="muted">Envoie une capture de ce message pour qu’il soit corrigé.</p>
        <pre>{String(this.state.error?.stack ?? this.state.error).slice(0, 1500)}</pre>
        <button className="button" onClick={() => location.reload()}>Recharger</button>
      </div>
    );
  }
}

const container = document.getElementById('root')!;
if (location.hash === '#mini') {
  // Mini lecteur : rien d'autre n'est chargé (pas de second lecteur, pas de bibliothèque).
  void import('./mini').then(({ renderMini }) => renderMini(container));
} else {
  void Promise.all([import('./App'), import('./lib/library'), import('./lib/remote'), import('./lib/ambient')]).then(async ([{ App }, { loadLibrary }]) => {
    await loadLibrary().catch((error) => console.error('Nova : bibliothèque illisible', error));
    createRoot(container).render(<Guard><App /></Guard>);
  });
}
