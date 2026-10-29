import type { Config } from './config.js';
import type { ContextPack, Forum, ImageSaver, Post, StoredImage, ThreadDirection } from './types.js';
import { readableTopics } from './payload.js';
import { extractUploads, renderPostWithUploads, stamp } from './format.js';

/** One image block a tool result carries: the harness turns this into a model-visible image. */
export interface ImageBlockLike {
  type: 'image';
  attachment: {attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string};
}

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
    render(args: unknown, value: unknown): (ImageBlockLike | {type: 'text'; text: string})[];
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
 * Canonical value of an image read: a line for the model, plus the durable references its
 * blocks are built from. The refs are plain JSON so they survive the registry's snapshot.
 */
export const IMAGE_RESULT = {
  type: 'object',
  properties: {
    text: {type: 'string'},
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          attachmentId: {type: 'string'},
          mediaType: {type: 'string'},
          bytes: {type: 'integer'},
          width: {type: 'integer'},
          height: {type: 'integer'},
        },
        required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
      },
    },
  },
  required: ['text', 'images'],
  additionalProperties: false,
} as const;

/**
 * A text line followed by the images themselves, which is the whole point of the tool:
 * the model reads what it asked to see instead of being told an image exists.
 */
const textAndImages = (_args: unknown, value: unknown) => {
  const {text: line, images} = value as {text: string; images: StoredImage[]};
  return [
    {type: 'text' as const, text: line},
    ...images.map(image => ({type: 'image' as const, attachment: image})),
  ];
};

/**
 * The forum reads one task may make. Each tool costs exactly one MCP request, and the
 * whole turn shares one call budget and one character budget: the MCP child paces every
 * request globally, so an unbounded reader would starve the scanner and the reconciler.
 */
export class Reader {
  private calls = 0;
  private chars = 0;
  private readonly topics: Set<number>;
  // Upload refs that appeared in a post this task has actually been shown. An image is a
  // read like any other, so it stays inside the topics the task may read: a post cannot
  // name some other upload the owner's key happens to unlock and have it fetched.
  private readonly uploads = new Set<string>();
  constructor(readonly forum: Forum, readonly config: Config, pack: ContextPack,
    readonly images: ImageSaver = {save: async () => { throw new Error('图片存储不可用'); }}) {
    this.topics = readableTopics(pack);
    for (const post of [pack.source, ...pack.related]) this.saw(post);
  }

  private saw(post: Post): Post {
    for (const upload of extractUploads(post.raw)) this.uploads.add(upload.ref);
    return post;
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

  /** `reserve` keeps room for a suffix the caller appends after bounding the body. */
  private bound(body: string, reserve = 0): string {
    const room = this.room() - reserve;
    const out = body.length > room ? `${body.slice(0, Math.max(0, room))}\n…（后续内容因预算截断）` : body;
    this.chars += out.length;
    return out;
  }

  private topic(id: unknown): number {
    if (!Number.isSafeInteger(id) || !this.topics.has(id as number)) {
      throw new Error(`只能读取与本次调用相关的主题：${[...this.topics].join('、')}。`);
    }
    return id as number;
  }

  /**
   * Rendered floors, or a note that says why there were none. An empty result previously
   * read as "this floor does not exist", so a model would probe 20, then 1, then give up,
   * spending its call budget on floors that were simply outside the topic.
   */
  private floors(topic: number, posts: Post[], asked?: {floors?: number[]; ids?: number[]}): string {
    const wanted = posts.filter(post => post.topic_id === topic);
    if (!wanted.length) {
      const what = asked?.ids ? `帖子 ${asked.ids.join('、')}` : '这些楼层';
      return `主题 ${topic} 里没有读到 ${what}。可能是楼层号超出范围、已被删除，或你用的是帖子 ID 而不是楼层号`
        + `（每帖开头形如 #楼层号 (id 帖子ID)，read_around 取楼层号，read_posts 取帖子 ID）。`;
    }
    const numbers = wanted.map(post => post.post_number);
    const range = `\n\n（本次读到 #${Math.min(...numbers)}–#${Math.max(...numbers)}，共 ${wanted.length} 楼）`;
    // The range is charged too, so a bounded read cannot exceed the turn's budget.
    return this.bound(wanted.map(post => renderPostWithUploads(this.saw(post))).join('\n\n'), range.length) + range;
  }

  definitions(): ToolDefinitionLike[] {
    return [this.around(), this.byIds(), this.thread(), this.search(), this.topicInfo(), this.readImages()];
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
        return {text: this.floors(topic, await this.forum.readAround(topic, post_number, limit), {floors: [post_number]})};
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
        return {text: this.floors(topic, await this.forum.readByIds(topic, ids), {ids})};
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
        return {text: this.bound(posts.map(post => renderPostWithUploads(this.saw(post))).join('\n\n'))};
      },
    };
  }

  /**
   * What the thread is about. Floors alone say nothing about the subject, and the post
   * endpoints report topic_title as null, so this is the only way the model can learn it.
   */
  private topicInfo(): ToolDefinitionLike {
    return {
      name: 'read_topic',
      description: '读取主题的标题、分类、标签和总楼层数，用来判断这段讨论在讲什么、有多大。',
      parameters: compileParameters({
        topic_id: {type: 'integer', required: true, description: '主题 ID'},
      }),
      output: {schema: TEXT_RESULT, render: text},
      execute: async args => {
        const {topic_id} = args as {topic_id: number};
        const id = this.topic(topic_id);
        this.charge();
        const info = await this.forum.topicInfo(id);
        const lines = [
          `主题 ${info.id}：${info.title}`,
          `共 ${info.postsCount} 楼${info.highestPostNumber ? `，最高楼层 #${info.highestPostNumber}` : ''}`,
        ];
        if (info.tags.length) lines.push(`标签：${info.tags.join('、')}`);
        return {text: this.bound(lines.join('\n'))};
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

  /**
   * The images a post references, as images. Model-initiated because most floors have none:
   * fetching every upload on every call would spend vision tokens on pictures nobody asked
   * about. Only refs from posts this task has already been shown are fetched.
   */
  private readImages(): ToolDefinitionLike {
    return {
      name: 'read_images',
      description: '查看楼层里的图片。帖子正文下方的「[附图 N 张]」列出了这一楼的 upload:// 引用，原样传进来即可。'
        + '图片和对方的问题有关、或者光看文字说不清它在讲什么时再看；纯文字就能聊的不必看。一次最多 4 张。',
      parameters: compileParameters({
        refs: {
          type: 'array', items: {type: 'string'}, required: true,
          description: '要看的 upload:// 引用，取自「[附图]」一行，最多 4 个',
        },
      }),
      output: {schema: IMAGE_RESULT, render: textAndImages},
      execute: async args => {
        const {refs} = args as {refs: string[]};
        const asked = [...new Set((Array.isArray(refs) ? refs : [])
          .filter((ref): ref is string => typeof ref === 'string').map(ref => ref.trim()))];
        if (!asked.some(ref => ref.startsWith('upload://'))) {
          throw new Error('需要至少一个 upload:// 引用，照「[附图]」一行里的原样给。');
        }
        const unknown = asked.filter(ref => !this.uploads.has(ref));
        const wanted = asked.filter(ref => this.uploads.has(ref)).slice(0, 4);
        if (!wanted.length) {
          throw new Error('这些引用不在已读到的楼层里。只能看调用帖和已读楼层「[附图]」里列出的图片。');
        }
        this.charge();
        const images: StoredImage[] = [];
        const failed: string[] = [];
        for (const ref of wanted) {
          try {
            const upload = await this.forum.readUpload(ref, this.config.imageBytes);
            // The name is display-only; the store verifies the bytes against the declared type.
            images.push(await this.images.save({
              data: upload.data, mediaType: upload.mediaType,
              name: ref.slice('upload://'.length),
            }));
          } catch (error) {
            failed.push(`${ref}（${error instanceof Error ? error.message : String(error)}）`);
          }
        }
        const notes = [
          ...(failed.length ? [`没读到：${failed.join('；')}`] : []),
          ...(unknown.length ? [`不在已读楼层里、没有去取：${unknown.join('、')}`] : []),
        ];
        if (!images.length) return {text: `一张图也没读到。${notes.join('。')}。`, images: []};
        const listing = images.map(image => `${image.name ?? '图片'}（${image.width}×${image.height}）`);
        return {text: [`下面是 ${listing.join('、')}。`, ...notes].join('\n'), images};
      },
    };
  }
}
