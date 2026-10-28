import MarkdownIt from 'markdown-it';
import { randomBytes } from 'node:crypto';
import type { Post } from './types.js';
import type { Config } from './config.js';
const md = new MarkdownIt({ html: true });

/** Unclosed Discourse quotes stay quoted through EOF. */
function withoutDiscourseQuotes(raw: string): string {
  let depth = 0, cursor = 0, text = '';
  for (const match of raw.matchAll(/\[\/?quote(?:[^\]]*)\]/gi)) {
    if (!depth) text += raw.slice(cursor, match.index);
    depth = match[0].toLowerCase().startsWith('[/') ? Math.max(0, depth - 1) : depth + 1;
    cursor = match.index! + match[0].length;
  }
  return text + (depth ? '' : raw.slice(cursor));
}
export function activeText(raw: string): string {
  const tokens = md.parse(raw, {});
  let quoteDepth = 0;
  const text: string[] = [];
  for (const token of tokens) {
    if (token.type === 'blockquote_open') quoteDepth++;
    if (token.type === 'blockquote_close') quoteDepth--;
    if (token.type !== 'inline' || quoteDepth) continue;
    let autoLink = false, htmlDepth = 0;
    for (const child of token.children ?? []) {
      if (child.type === 'link_open' && child.markup === 'autolink') autoLink = true;
      if (child.type === 'link_close') autoLink = false;
      if (child.type === 'html_inline') {
        if (/^<\//.test(child.content)) htmlDepth = Math.max(0, htmlDepth - 1);
        // Inline HTML is ignored conservatively, including text inside elements.
        else if (/^<(?!br\b|img\b|hr\b)\w/i.test(child.content) && !/\/>$/.test(child.content)) htmlDepth++;
      }
      if (child.type === 'text' && !autoLink && !htmlDepth) text.push(child.content);
      else text.push(' ');
    }
    text.push('\n');
  }
  return withoutDiscourseQuotes(text.join(''));
}
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * `@owner 【pet】` in the post's own text, written by anyone including the owner (whose
 * self-mentions never reach the mentions stream, hence the separate owner stream).
 * A plain mention, or the marker alone, is not an invocation.
 */
export function hasInvocation(raw: string, config: Pick<Config, 'owner' | 'petName'>): boolean {
  return new RegExp(`(^|[^\\w@])@${escape(config.owner)}\\s*【${escape(config.petName)}】`, 'iu').test(activeText(raw));
}
export function isCall(post: Post, config: Pick<Config, 'owner' | 'petName'>): boolean {
  if (post.hidden || post.deleted_at || post.archetype === 'private_message' || (post.post_type !== undefined && post.post_type !== 1)) return false;
  return !isPetPost(post.raw) && hasInvocation(post.raw, config);
}
// Hidden in the rendered post. Marks the pet's own replies independently of their wording.
const PET_TAG = '<!-- shuiyuan-pet ';
export const AI_NOTE = '（内容由 AI 生成，仅供参考）';
export const isPetPost = (raw: string): boolean => raw.includes(PET_TAG);
// Characters Discourse rewrites to a plain space when it stores a post.
const DISCOURSE_SPACES = /[\u00A0\u1680\u180E\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/gu;
/**
 * The model's answer as forum text: the wake marker loses its brackets so a reply can never
 * invoke the pet again, and whitespace follows Discourse's storage rules.
 */
export function replyBody(text: string, petName: string): string {
  return text.replaceAll(`【${petName}】`, petName).replace(DISCOURSE_SPACES, ' ').trimEnd();
}
/**
 * The exact text the pet posts: the body, the AI note and the hidden tag. The random part of
 * the tag keeps two identical answers from being rejected as a duplicate post.
 */
export function replyText(body: string): string {
  return `${body}\n\n${AI_NOTE}\n\n${PET_TAG}${randomBytes(6).toString('hex')} -->`;
}
export function quoteTargets(raw: string, sourceTopic: number): {topic: number; floor: number}[] {
  const targets: {topic: number; floor: number}[] = [];
  // Code blocks cannot contribute forum references.
  const prose = md.parse(raw, {}).filter(t => t.type === 'inline').map(t =>
    (t.children ?? []).filter(c => c.type !== 'code_inline').map(c => c.content).join('')).join('\n');
  for (const match of prose.matchAll(/\[quote\s*=\s*"([^"\]]+)"[^\]]*\]/gi)) {
    const floor = /(?:^|,)\s*post:(\d+)/i.exec(match[1]!)?.[1];
    const topic = /(?:^|,)\s*topic:(\d+)/i.exec(match[1]!)?.[1];
    if (floor && Number(floor) > 0) targets.push({topic: topic ? Number(topic) : sourceTopic, floor: Number(floor)});
  }
  return targets;
}
