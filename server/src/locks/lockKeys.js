import { ids } from '../db/ids.js';

// Deterministic lock ids (architecture v0.3 §4 'locks' row). Built only here.
export const lockKeys = Object.freeze({
  group: (groupId) => ids.lock('sync:group', String(groupId)),
  bootstrap: () => ids.lock('sync:bootstrap'),
  migrate: () => ids.lock('migrate'),
});
