// Minuteries précises des transitions. Sur Android, une page invisible (écran verrouillé) voit ses minuteries
// ralenties : les transitions y sont rythmées par Android lui-même (window.novaTicker, fourni par le pont).
type Ticker = { every(ms: number, fn: () => void): number; clear(id: number): void };
export type Timer = { native: boolean; id: number } | undefined;

const ticker = (window as unknown as { novaTicker?: Ticker }).novaTicker;

/** Répète `fn` toutes les `ms` millisecondes. */
export function every(ms: number, fn: () => void): Timer {
  if (ticker) return { native: true, id: ticker.every(ms, fn) };
  return { native: false, id: setInterval(fn, ms) as unknown as number };
}

/** Lance `fn` une fois, dans `ms` millisecondes. */
export function after(ms: number, fn: () => void): Timer {
  if (!ticker) return { native: false, id: setTimeout(fn, ms) as unknown as number };
  const start = performance.now();
  const timer: { native: boolean; id: number } = { native: true, id: 0 };
  timer.id = ticker.every(10, () => {
    if (performance.now() - start < ms) return;
    ticker.clear(timer.id);
    fn();
  });
  return timer;
}

export function cancel(timer: Timer) {
  if (!timer) return;
  if (timer.native) ticker?.clear(timer.id);
  else { clearInterval(timer.id); clearTimeout(timer.id); }
}
