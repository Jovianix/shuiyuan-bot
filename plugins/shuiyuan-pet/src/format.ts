import type { Post } from './types.js';

/**
 * Signature blocks repeat on every post of the same author and are rendered noise,
 * so the model never sees them. They are still part of the hashed source body.
 */
const SIGNATURE = /<div\s+data-signature>[\s\S]*?<\/div>/gi;

/**
 * Discourse stores an inserted image as `upload://<name>.<ext>` and swaps in a real path
 * when it cooks the post. The short form is what a post body carries, and it is the
 * handle the image reader takes.
 */
const UPLOAD = /!\[([^\]]*)\]\(upload:\/\/([\w.-]+?)\)/gi;

/** The uploads a post references, in body order, each with the model's own alt text. */
export function extractUploads(raw: string): {ref: string; alt: string}[] {
  return [...raw.matchAll(UPLOAD)].map(match => ({
    ref: `upload://${match[2]}`,
    // Alt text is `name|WxH, scale%`; only the name means anything to a reader. Discourse
    // also escapes some punctuation in it (`IMG\_1216`), which is undone here.
    alt: match[1]!.split('|')[0]!.replace(/\\(.)/g, '$1').trim(),
  }));
}

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
 *
 * The header carries both numbers because the model needs both: the floor is how people
 * refer to a post in the discussion (and what read_around takes), while the post id is what
 * read_posts and read_thread require. Without the id the model had to guess floors.
 */
export function renderPost(post: Post, bodyLimit = Number.POSITIVE_INFINITY): string {
  const reply = post.reply_to_post_number ? ` →#${post.reply_to_post_number}` : '';
  const raw = stripSignature(post.raw);
  const body = raw.length > bodyLimit ? `${raw.slice(0, bodyLimit)}…` : raw;
  return `#${post.post_number} (id ${post.id}) ${author(post)} ${stamp(post.created_at)}${reply}\n${body}`;
}

/**
 * The images a post holds, stated once below its body. Buried in markdown, an
 * `upload://…` target is easy to miss and its alt text is escaped; this line is the
 * fact, and the image reader's description says what can be done with it.
 */
export function describeUploads(raw: string): string {
  const uploads = extractUploads(raw);
  if (!uploads.length) return '';
  const lines = uploads.map(upload => `${upload.ref}${upload.alt ? `（${upload.alt}）` : ''}`);
  return `[附图 ${uploads.length} 张] ${lines.join('；')}`;
}

/** A post as the model reads it: the compact header and body, then its images if any. */
export function renderPostWithUploads(post: Post): string {
  const uploads = describeUploads(post.raw);
  return uploads ? `${renderPost(post)}\n${uploads}` : renderPost(post);
}

/** A referenced floor the model has not read: enough to decide whether it is worth a call. */
export function renderStub(topic: number, floor: number, preview?: string): string {
  const head = `#${floor}`;
  return preview ? `${head} ${preview}` : `${head}（主题 ${topic}）`;
}
