// Android TV : les flèches de la télécommande déplacent le focus vers l'élément le plus proche dans cette direction.
const focusable = 'button:not(:disabled), a[href], input:not([type=hidden]), select, [tabindex]:not([tabindex="-1"])';

function visible(element: HTMLElement) {
  const box = element.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return false;
  const style = getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
}

function candidates(): HTMLElement[] {
  // Menu ou boîte de dialogue ouverts : le focus y reste.
  const scope = document.querySelector<HTMLElement>('.context-menu, .modal-backdrop, .now-playing') ?? document.body;
  return [...scope.querySelectorAll<HTMLElement>(focusable)].filter(visible);
}

function move(direction: 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight') {
  const current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const all = candidates();
  if (!current || !all.includes(current)) {
    all.find((element) => element.getBoundingClientRect().top >= 0)?.focus();
    return;
  }
  const from = current.getBoundingClientRect();
  const cx = from.left + from.width / 2, cy = from.top + from.height / 2;
  let best: HTMLElement | undefined, bestScore = Infinity;
  for (const element of all) {
    if (element === current || current.contains(element) || element.contains(current)) continue;
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2, y = box.top + box.height / 2;
    const dx = x - cx, dy = y - cy;
    let along: number, across: number;
    switch (direction) {
      case 'ArrowRight': if (box.left < from.right - 4) continue; along = dx; across = Math.abs(dy); break;
      case 'ArrowLeft': if (box.right > from.left + 4) continue; along = -dx; across = Math.abs(dy); break;
      case 'ArrowDown': if (box.top < from.bottom - 4) continue; along = dy; across = Math.abs(dx); break;
      case 'ArrowUp': if (box.bottom > from.top + 4) continue; along = -dy; across = Math.abs(dx); break;
    }
    const score = along + across * 2.5;
    if (score < bestScore) { bestScore = score; best = element; }
  }
  if (best) {
    best.focus({ preventScroll: true });
    best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
}

export function enableSpatialNavigation() {
  window.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) || event.altKey || event.ctrlKey) return;
    const target = event.target as HTMLElement;
    // Champs de texte : gauche/droite déplacent le curseur. Curseurs (volume, position) : gauche/droite les règlent.
    if (target instanceof HTMLInputElement && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      && (target.type === 'range' || target.type === 'text' || target.type === 'search' || !target.type)) return;
    if (target instanceof HTMLSelectElement) return;
    event.preventDefault();
    move(event.key as 'ArrowUp');
  }, true);
}
