import type { Config } from './config.js';
import type { ContextPack, Forum, Post } from './types.js';
import { PermanentError } from './types.js';
import { isCall, quoteTargets } from './trigger.js';
import { createHash } from 'node:crypto';
export const sourceHash = (raw: string): string => createHash('sha256').update(raw).digest('hex');

// Five floors either side of the post: one request, and usually the parent is among them.
const WINDOW = 11;

/**
 * Every forum read an invocation needs, done once. The window around the post is at the
 * same time the invocation check, the source and, most of the time, the parent; only a
 * parent or quoted floor outside it costs another request. Returns undefined when the
 * post is not an invocation. `manual` drafts skip the invocation check.
 */
export async function prepare(forum: Forum, config: Config, at: {id: number; topic?: number | null; floor?: number | null},
  manual = false): Promise<ContextPack | undefined> {
  const where = at.topic && at.floor ? {topic: at.topic, floor: at.floor}
    : await forum.locate(at.id).then(head => ({topic: head.topic_id, floor: head.post_number}));
  const window = await forum.readAround(where.topic, where.floor, WINDOW);
  const source = window.find(post => post.post_number === where.floor);
  if (!source || source.id !== at.id) throw new PermanentError(`Post ${at.id} is not visible at ${where.topic}/${where.floor}`);
  if (source.hidden || source.deleted_at || (!manual && !isCall(source, config))) return undefined;
  return buildContext(source, window, forum, config);
}

export async function buildContext(source: Post, window: Post[], forum: Pick<Forum, 'readAround'>,
  config: Pick<Config, 'relatedLimit' | 'contextChars'>): Promise<ContextPack> {
  const pack: ContextPack = {source: {...source}, sourceHash: sourceHash(source.raw), related: [], missing: [], truncated: []};
  let remaining = config.contextChars;
  function bounded(post: Post): Post {
    const raw = post.raw.slice(0, remaining);
    remaining -= raw.length;
    if (raw.length !== post.raw.length) pack.truncated.push(post.id);
    return {...post, raw};
  }
  pack.source = bounded(source);
  const targets = [
    ...(source.reply_to_post_number ? [{topic: source.topic_id, floor: source.reply_to_post_number}] : []),
    ...quoteTargets(source.raw, source.topic_id),
  ];
  const seen = new Set([`${source.topic_id}/${source.post_number}`]);
  let used = 0;
  for (const target of targets) {
    const ref = `${target.topic}/${target.floor}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (!remaining || used >= config.relatedLimit) { pack.missing.push(`${ref}: budget`); continue; }
    used++;
    const at = (post: Post) => post.topic_id === target.topic && post.post_number === target.floor;
    try {
      const post = window.find(at) ?? (await forum.readAround(target.topic, target.floor, 1)).find(at);
      if (!post || post.hidden || post.deleted_at) throw new Error('unavailable');
      pack.related.push(bounded(post));
    } catch { pack.missing.push(`${ref}: unavailable`); }
  }
  return pack;
}
