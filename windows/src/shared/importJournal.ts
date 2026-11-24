import type { ImportJournalEntry, Track } from './types.js';

/** Les imports et corrections peuvent terminer en parallèle. Les écritures restent ordonnées. */
export class ImportJournal {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly read: () => Promise<ImportJournalEntry[]>,
    private readonly write: (entries: ImportJournalEntry[]) => Promise<void>,
  ) {}

  async load() {
    await this.pending.catch(() => undefined);
    return this.read();
  }

  record(entries: ImportJournalEntry[]) {
    const task = this.pending.catch(() => undefined).then(async () => {
      const current = new Map((await this.read()).map(entry => [entry.id, entry]));
      for (const entry of entries) {
        const previous = current.get(entry.id);
        if (entry.status === 'resolved' && !previous && entry.attempts === 1) continue;
        current.set(entry.id, { ...entry, firstAttempt: previous?.firstAttempt ?? entry.firstAttempt,
          attempts: (previous?.attempts ?? 0) + entry.attempts });
      }
      await this.write([...current.values()].sort((a, b) => b.lastAttempt - a.lastAttempt));
    });
    this.pending = task;
    return task;
  }

  resolve(id: string, recording: Track) {
    const task = this.pending.catch(() => undefined).then(async () => {
      const entries = await this.read();
      await this.write(entries.map(entry => entry.id === id ? { ...entry, recording,
        status: 'resolved', reason: 'Correspondance choisie manuellement.', lastAttempt: Date.now() } : entry));
    });
    this.pending = task;
    return task;
  }
}
