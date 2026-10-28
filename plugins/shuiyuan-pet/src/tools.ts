import type { Config } from './config.js';
import type { ContextPack, Forum, Post, ThreadDirection } from './types.js';
import { readableTopics } from './payload.js';
import { renderPost, stamp } from './format.js';

/**
 * The shape the DSH tool registry accepts: a model-facing schema plus a canonical
 * value and its pure text projection. Declared structurally so this package keeps
 * no build-time dependency on the harness.
 */
export interface ToolDefinitionLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): {type: 'text'; text: string}[];
  };
  execute(args: unknown, exec: unknown): Promise<unknown>;
}

export const TEXT_RESULT = {
  type: 'object',
  properties: {text: {type: 'string'}},
  required: ['text'],
  additionalProperties: false,
} as const;

type PropertySpec = {type: string; description?: string; required?: true; enum?: string[]; items?: {type: string}};

/**
 * The registry sends `parameters` to the model verbatim and never compiles it, so the
 * spec form is turned into raw JSON Schema here: an object root, a property map, and the
 * required names hoisted into their own array.
 */
export function compileParameters(spec: Record<string, PropertySpec>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, {required: isRequired, ...node}] of Object.entries(spec)) {
    properties[name] = node;
    if (isRequired) required.push(name);
  }
  return {type: 'object', properties, ...(required.length ? {required} : {}), additionalProperties: false};
}

// The registry calls output.render(args, value): the canonical value is the second argument.
const text = (_args: unknown, value: unknown) => [{type: 'text' as const, text: (value as {text: string}).text}];

/**
 * The forum reads one task may make. Each tool costs exactly one MCP request, and the
 * whole turn shares one call budget and one character budget: the MCP child paces every
 * request globally, so an unbounded reader would starve the scanner and the reconciler.
 */
export class Reader {
  private calls = 0;
  private chars = 0;
  private readonly topics: Set<number>;
  constructor(readonly forum: Forum, readonly config: Config, pack: ContextPack) {
    this.topics = readableTopics(pack);
  }

  private charge(): void {
    if (this.calls >= this.config.readCalls) {
      throw new Error(`本轮已经读了 ${this.config.readCalls} 次，达到上限。请用手上已有的内容回答。`);
    }
    this.calls++;
  }

  /** Room left in the turn's character budget, never more than one result's cap. */
  private room(): number {
    const left = Math.min(this.config.readChars, this.config.readTotal - this.chars);
    if (left <= 0) throw new Error('本轮读取的正文总量已达上限。请用手上已有的内容回答。');
    return left;
  }

  private bound(body: string): string {
    const room = this.room();
    const out = body.length > room ? `${body.slice(0, room)}\n…（后续内容因预算截断）` : body;
    this.chars += out.length;
    return out;
  }

  private topic(id: unknown): number {
    if (!Number.isSafeInteger(id) || !this.topics.has(id as number)) {
      throw new Error(`只能读取与本次调用相关的主题：${[...this.topics].join('、')}。`);
    }
    return id as number;
  }

  private floors(topic: number, posts: Post[]): string {
    const wanted = posts.filter(post => post.topic_id === topic);
    if (!wanted.length) return `主题 ${topic} 没有读到对应的可见楼层。`;
    return this.bound(wanted.map(post => renderPost(post)).join('\n\n'));
  }

  definitions(): ToolDefinitionLike[] {
    return [this.around(), this.byIds(), this.thread(), this.search()];
  }

  /** A contiguous chunk of one topic, which is how a discussion is actually read. */
  private around(): ToolDefinitionLike {
    return {
      name: 'read_around',
      description: '读取某个主题中某一楼附近的连续楼层，用于了解一段讨论的前后文。一次读取返回一段连续楼层。',
      parameters: compileParameters({
        topic_id: {type: 'integer', required: true, description: '主题 ID'},
        post_number: {type: 'integer', required: true, description: '目标楼层号'},
        span: {type: 'integer', description: `最多取多少楼，默认 ${this.config.readSpan}，上限 50`},
      }),
      output: {schema: TEXT_RESULT, render: text},
      execute: async args => {
        const {topic_id, post_number, span} = args as {topic_id: number; post_number: number; span?: number};
        const topic = this.topic(topic_id);
        if (!Number.isSafeInteger(post_number) || post_number <= 0) throw new Error('楼层号必须是正整数。');
        const limit = Math.min(Math.max(1, span ?? this.config.readSpan), 50);
        this.charge();
        return {text: this.floors(topic, await this.forum.readAround(topic, post_number, limit))};
      },
    };
  }

  /** Exact floors the model already knows the id of, from a stub or an earlier result. */
  private byIds(): ToolDefinitionLike {
    return {
      name: 'read_posts',
      description: '按帖子 ID 精确读取若干楼层。ID 取自已有内容中标注的 id，一次最多 50 个。',
      parameters: compileParameters({
        topic_id: {type: 'integer', required: true, description: '主题 ID'},
        post_ids: {type: 'array', items: {type: 'integer'}, required: true, description: '帖子 ID 列表'},
      }),
      output: {schema: TEXT_RESULT, render: text},
      execute: async args => {
        const {topic_id, post_ids} = args as {topic_id: number; post_ids: number[]};
        const topic = this.topic(topic_id);
        const ids = [...new Set(post_ids.filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 50);
        if (!ids.length) throw new Error('需要至少一个有效的帖子 ID。');
        this.charge();
        return {text: this.floors(topic, await this.forum.readByIds(topic, ids))};
      },
    };
  }

  /** How the reply chain actually runs, which the pre-fetch only ever guesses one hop of. */
  private thread(): ToolDefinitionLike {
    return {
      name: 'read_thread',
      description: '读取某一楼的回复链：ancestors 取它回复的上层楼层，replies 取直接回复它的楼层。',
      parameters: compileParameters({
        post_id: {type: 'integer', required: true, description: '帖子 ID'},
        direction: {type: 'string', enum: ['ancestors', 'replies'], required: true, description: 'ancestors 向上，replies 向下'},
      }),
      output: {schema: TEXT_RESULT, render: text},
      execute: async args => {
        const {post_id, direction} = args as {post_id: number; direction: ThreadDirection};
        if (!Number.isSafeInteger(post_id) || post_id <= 0) throw new Error('帖子 ID 必须是正整数。');
        if (direction !== 'ancestors' && direction !== 'replies') throw new Error('direction 只能是 ancestors 或 replies。');
        this.charge();
        const posts = (await this.forum.thread(post_id, direction)).filter(post => this.topics.has(post.topic_id));
        if (!posts.length) return {text: '这一楼没有读到可用的回复链。'};
        return {text: this.bound(posts.map(post => renderPost(post)).join('\n\n'))};
      },
    };
  }

  /** Keyword search, kept inside the topics this task is already about. */
  private search(): ToolDefinitionLike {
    return {
      name: 'search',
      description: '在本次调用相关的主题范围内搜索帖子关键词，返回匹配楼层的楼层号、作者与摘要。',
      parameters: compileParameters({
        query: {type: 'string', required: true, description: '搜索关键词'},
      }),
      output: {schema: TEXT_RESULT, render: text},
      execute: async args => {
        const {query} = args as {query: string};
        const q = (query ?? '').trim();
        if (!q) throw new Error('搜索词不能为空。');
        this.charge();
        const hits = (await this.forum.searchPosts(q)).filter(post => this.topics.has(post.topic_id));
        if (!hits.length) return {text: '相关主题里没有搜到匹配的楼层。'};
        const lines = hits.slice(0, 20).map(post =>
          `#${post.post_number} ${post.username} ${stamp(post.created_at)} id=${post.id}\n${(post.raw ?? '').slice(0, 200)}`);
        return {text: this.bound(lines.join('\n\n'))};
      },
    };
  }
}
