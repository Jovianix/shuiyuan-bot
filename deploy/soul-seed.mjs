import { createHash } from 'node:crypto';

export const hash = text => createHash('sha256').update(text).digest('hex');

/**
 * The Soul card the profile currently uses, when `cordis.patch.yml` is still the JSON this
 * entrypoint writes. Undefined means the file is gone or was rewritten in another format
 * (for example by DSH Web), which this module cannot safely edit.
 */
export function currentCard(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!Array.isArray(parsed)) return undefined;
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const nodes = [...(Array.isArray(entry.insert) ? entry.insert : []), entry];
    for (const node of nodes) {
      const config = node?.config;
      if (node?.id !== 'soul-md' || !config) continue;
      const card = config.cards?.[config.active];
      if (typeof card === 'string') return card;
    }
  }
  return undefined;
}

/**
 * True when the patch file holds no entries: DSH's profile template is a comment header
 * followed by `[]`. Nothing in that file can be a user's card, so seeding it is safe.
 */
export function isEmptyPatch(text) {
  const body = text.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n').trim();
  if (!body) return true;
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

/**
 * How the profile's card relates to the image's `config/soul.md`, given what this entrypoint
 * last seeded (`recorded`, a hash) and what the profile holds now (`card`, undefined when
 * `cordis.patch.yml` is absent, empty, or not the JSON this entrypoint writes; `patch` says
 * whether a file exists at all, `empty` whether it holds no entries).
 *
 * The card is user-managed once initialized, so it is only rewritten while it still holds
 * exactly what was seeded. Anything else is left alone unless `force` is set, because
 * overwriting it would silently discard a card edited in DSH Web.
 */
export function planSeed({soul, recorded, card, patch = card !== undefined, empty = false, force}) {
  // No patch file, or one with no entries: there is no card to protect.
  if (!patch || empty) return {action: 'write'};
  // The file exists but cannot be read as ours, so someone else owns it.
  if (card === undefined) return force ? {action: 'write'} : {action: 'conflict', reason: 'unreadable'};
  if (card === soul) return {action: recorded === hash(soul) ? 'none' : 'record'};
  if (recorded !== undefined && hash(card) === recorded) return {action: 'write'};
  // No record: this volume was seeded before hashes were recorded, so a difference from the
  // image is either a Web edit or a stale seed, and only a person can tell those apart.
  if (recorded === undefined) return force ? {action: 'write'} : {action: 'conflict', reason: 'unrecorded'};
  return force ? {action: 'write'} : {action: 'conflict', reason: 'edited'};
}
