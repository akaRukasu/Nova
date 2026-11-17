import { createHash } from 'node:crypto';
import type { LibraryState } from '../shared/types.js';

function uuid(value: string) {
  if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) return value;
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

import { portableBackup } from '../shared/portableBackup.js';

export function createPhoneBackup(state: LibraryState, exportedAt = Date.now()) {
  return portableBackup(state, exportedAt, uuid);
}
