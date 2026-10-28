import type { Post } from './types.js';

/**
 * Signature blocks repeat on every post of the same author and are rendered noise,
 * so the model never sees them. They are still part of the hashed source body.
 */
const SIGNATURE = /<div\s+data-signature>[\s\S]*?<\/div>/gi;

export function stripSignature(raw: string): string {
  return raw.replace(SIGNATURE, '').trim();
}

/** `2026-10-27T17:02:48.043Z` as `2026-10-27 17:02Z`: the precision a discussion needs. */
export function stamp(created: string): string {
  const at = Date.parse(created);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : created;
}

/** The author as the model must cite it back: a display name can change, the id cannot. */
export function author(post: Pick<Post, 'username' | 'user_id'>): string {
  return `${post.username}(u${post.user_id})`;
}

/**
 * One post as compact text: an addressable header the model can name in a tool call,
 * then the body. JSON was costing more in key names and escaping than in content.
 */
export function renderPost(post: Post, bodyLimit = Number.POSITIVE_INFINITY): string {
  const reply = post.reply_to_post_number ? ` →#${post.reply_to_post_number}` : '';
  const raw = stripSignature(post.raw);
  const body = raw.length > bodyLimit ? `${raw.slice(0, bodyLimit)}…` : raw;
  return `#${post.post_number} ${author(post)} ${stamp(post.created_at)}${reply}\n${body}`;
}

/** A referenced floor the model has not read: enough to decide whether it is worth a call. */
export function renderStub(topic: number, floor: number, preview?: string): string {
  const head = `#${floor}`;
  return preview ? `${head} ${preview}` : `${head}（主题 ${topic}）`;
}
