// Petit magasin observable : les vues se mettent à jour quand la valeur change.
import { useSyncExternalStore } from 'react';

export class Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}

  get = () => this.value;

  set(next: T | ((current: T) => T)) {
    this.value = typeof next === 'function' ? (next as (current: T) => T)(this.value) : next;
    this.listeners.forEach((listener) => listener());
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}
