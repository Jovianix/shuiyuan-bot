import type { Config } from './config.js';
import type { Forum } from './types.js';
import { PermanentError } from './types.js';
import { prepare } from './context.js';
import type { Store } from './store.js';

/**
 * One request lists the newest activity: the owner's own posts and posts mentioning the
 * owner. A post is new when it was not on the previous scan's page; each new post costs
 * one read, which is the invocation check and the context read at once. Only invocations
 * are stored, and the unique task key is the last guard against answering a post twice.
 * The first scan only records what is already there, and after downtime nothing older
 * than catchUpMs is answered.
 */
export class Discovery {
  busy = false;
  constructor(readonly store: Store, readonly forum: Forum, readonly config: Config) {}
  async scan(): Promise<void> {
    if (this.busy || this.store.getMeta('paused')) return;
    this.busy = true;
    try {
      const scanStart = Date.now();
      const previous = this.store.getMeta<{baseline: number; seen: number[]}>('scan');
      const baseline = previous?.baseline ?? scanStart;
      const cutoff = Math.max(baseline, scanStart - this.config.catchUpMs);
      const seen = new Set(previous?.seen ?? []);
      const actions = (await this.forum.actions(this.config.scanPageSize))
        .filter(a => Number.isSafeInteger(a.post_id) && a.post_id! > 0 && Number.isFinite(Date.parse(a.created_at)));
      const retry = new Set<number>();
      // Oldest first, so earlier invocations are answered first.
      for (const action of previous ? [...actions].reverse() : []) {
        const id = action.post_id!;
        if (seen.has(id) || Date.parse(action.created_at) < cutoff) continue;
        seen.add(id);
        try {
          const context = await prepare(this.forum, this.config, {id, topic: action.topic_id, floor: action.post_number});
          if (context) this.store.enqueue(id, this.config.mode, action.action_type === 'mentions' ? 'mentions' : 'owner', context);
        } catch (error) {
          // Gone or private posts are settled; anything else is read again next scan.
          if (!(error instanceof PermanentError)) retry.add(id);
        }
      }
      this.store.setMeta('scan', {baseline, lastScan: scanStart,
        seen: actions.map(a => a.post_id!).filter(id => !retry.has(id))});
    } finally { this.busy = false; }
  }
}
