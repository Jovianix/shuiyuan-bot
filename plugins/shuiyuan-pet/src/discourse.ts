import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Config } from './config.js';
import type { Activity, CreatedPost, Forum, Post, PostHead, ThreadDirection, TopicInfo, UploadedImage } from './types.js';
import { ForumError, PermanentError } from './types.js';

export class Discourse implements Forum {
  private session?: Promise<Client>;
  private closed = false;
  constructor(readonly config: Config) {
    const profile = JSON.parse(readFileSync(config.profilePath, 'utf8')) as {site?: string};
    if (profile.site !== config.site) throw new Error('MCP profile site mismatch');
  }
  /**
   * The MCP child is started on first use and again whenever it has exited, so a forum
   * outage at startup or a crashed child only fails the calls made while it lasts.
   */
  connect(): Promise<Client> {
    if (this.closed) return Promise.reject(new ForumError('Forum connection closed'));
    return this.session ??= this.open().catch(error => { this.session = undefined; throw error; });
  }
  private async open(): Promise<Client> {
    const writes = this.config.mode === 'reply';
    const transport = new StdioClientTransport({command: process.execPath,
      args: ['--import', fileURLToPath(new URL('../../../scripts/pet-http.mjs', import.meta.url)),
        this.config.mcpScript, '--profile', this.config.profilePath, '--tools_mode', 'discourse_api_only',
        '--toolsets', 'topics,users,activity',
        '--allow_writes', String(writes), '--read_only', String(!writes)],
      env: {PATH: process.env.PATH ?? '/usr/bin:/bin', PET_SITE: this.config.site,
        PET_HTTP_GAP_MS: String(this.config.httpGapMs), PET_ALLOW_WRITES: String(writes)},
      // MCP logs go to the container log; credentials travel in headers, which it does not log.
      stderr: 'inherit',
    });
    const client = new Client({name: 'shuiyuan-pet', version: '0.1.0'});
    client.onclose = () => { this.session = undefined; };
    await client.connect(transport);
    const user = await this.invoke<{id: number; username: string}>(client, 'discourse_get_user', {});
    if (user.id !== this.config.ownerId || user.username.toLowerCase() !== this.config.owner.toLowerCase()) {
      await client.close();
      throw new Error('Configured owner does not match authenticated forum account');
    }
    return client;
  }
  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return this.invoke<T>(await this.connect(), name, args);
  }
  private async invoke<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({name, arguments: args}, undefined, {timeout: 180_000});
    const content = result.content as {type: string; text?: string}[];
    const text = content.filter(x => x.type === 'text').map(x => x.text ?? '').join('\n');
    let data: T & {error?: unknown; status?: unknown; errors?: unknown};
    try { data = JSON.parse(text) as typeof data; } catch { throw new ForumError(`Invalid MCP response: ${name}`); }
    if (result.isError || data.error) {
      const status = typeof data.status === 'number' ? data.status : undefined;
      const details = Array.isArray(data.errors) ? data.errors.filter((e): e is string => typeof e === 'string') : [];
      // Gone or forbidden content stays that way; retrying only repeats the request.
      const Failure = status === 403 || status === 404 ? PermanentError : ForumError;
      throw new Failure(`${name} failed${status ? ` (HTTP ${status})` : ''}`, status, details);
    }
    return data;
  }
  /** Posts missing identity, author or body are left out rather than failing the whole read. */
  complete(posts: Post[], archetype: string | null): Post[] {
    return posts.filter(p => Number.isSafeInteger(p.id) && Number.isSafeInteger(p.user_id) && typeof p.raw === 'string' && p.created_at)
      .map(p => ({...p, archetype: archetype ?? undefined}));
  }
  async locate(id: number): Promise<PostHead> {
    const head = await this.call<Partial<PostHead>>('discourse_read_post', {post_id: id});
    if (!Number.isSafeInteger(head.topic_id) || !Number.isSafeInteger(head.post_number) || typeof head.raw !== 'string') throw new ForumError('Incomplete post locator');
    return {id, topic_id: head.topic_id!, post_number: head.post_number!, raw: head.raw};
  }
  async readAround(topic: number, floor: number, limit: number): Promise<Post[]> {
    // Discourse returns the 5 floors before the target with it, so up to 11 floors cost one request.
    const data = await this.call<{posts: Post[]; archetype: string | null}>('discourse_read_topic_posts', {
      topic_id: topic, selection_mode: 'around_post', post_number: floor, limit,
    });
    if (data.archetype !== 'regular') throw new PermanentError('Only regular forum topics are supported');
    return this.complete(data.posts.filter(p => p.topic_id === topic), data.archetype);
  }
  async actions(limit: number): Promise<Activity[]> {
    // Both sources share user_id = owner in user_actions, so one request covers them.
    const data = await this.call<{actions: Activity[]}>('discourse_list_user_actions', {
      username: this.config.owner, action_types: ['topics', 'replies', 'mentions'], offset: 0, limit,
    });
    if (!Array.isArray(data.actions)) throw new Error('Activity list missing');
    return data.actions;
  }
  async recentOwnPosts(topic: number): Promise<Post[]> {
    // `latest` walks back from the tail, which is where a just-sent reply lands.
    // `usernames` filters from the head of the topic and would miss recent posts entirely.
    const data = await this.call<{posts: Post[]; archetype: string | null}>('discourse_read_topic_posts', {
      topic_id: topic, selection_mode: 'latest', limit: 50,
    });
    return this.complete(data.posts.filter(p => p.user_id === this.config.ownerId), data.archetype);
  }
  /** Exact floors by post ID: one request for up to 50 ids, which is what a model asks for. */
  async readByIds(topic: number, ids: number[]): Promise<Post[]> {
    const data = await this.call<{posts: Post[]; archetype: string | null}>('discourse_read_topic_posts', {
      topic_id: topic, selection_mode: 'post_ids', post_ids: ids,
    });
    // post_ids reports archetype=null (it never reads the topic head), so only a
    // known-private topic is refused here; the pre-send read still checks the topic.
    if (data.archetype === 'private_message') throw new PermanentError('Only regular forum topics are supported');
    return this.complete(data.posts.filter(p => p.topic_id === topic), data.archetype);
  }
  /**
   * Topic title and size. The post endpoints never report the title (post_ids returns
   * topic_title: null), so a model that only reads floors cannot tell what the thread is
   * about. `post_limit: 1` keeps this to one request and one extra post we discard.
   */
  async topicInfo(topic: number): Promise<TopicInfo> {
    const data = await this.call<{id: number; title: string; slug: string; category_id: number | null;
      tags?: (string | {name?: string})[]; posts_count?: number; highest_post_number?: number | null;
      archetype?: string | null}>(
      'discourse_read_topic', {topic_id: topic, post_limit: 1});
    if (data.archetype === 'private_message') throw new PermanentError('Only regular forum topics are supported');
    // This endpoint reports tags as objects ({id, name, slug}), not strings.
    const tags = Array.isArray(data.tags)
      ? data.tags.map(tag => typeof tag === 'string' ? tag : tag?.name)
        .filter((tag): tag is string => typeof tag === 'string' && !!tag)
      : [];
    return {
      id: data.id, title: typeof data.title === 'string' ? data.title : `主题 ${topic}`,
      slug: typeof data.slug === 'string' ? data.slug : '', categoryId: data.category_id ?? null,
      tags,
      postsCount: Number.isSafeInteger(data.posts_count) ? data.posts_count! : 0,
      highestPostNumber: Number.isSafeInteger(data.highest_post_number) ? data.highest_post_number! : null,
    };
  }
  /** `reply_history` walks up the ancestors; `direct_replies` returns the floors answering this one. */
  async thread(postId: number, direction: ThreadDirection): Promise<Post[]> {
    const data = await this.call<{posts: Post[]}>('discourse_get_post_replies', {
      post_id: postId,
      mode: direction === 'ancestors' ? 'reply_history' : 'direct_replies',
      include_raw: true,
    });
    if (!Array.isArray(data.posts)) return [];
    // Neither reply endpoint reports the topic archetype; callers filter by topic.
    return this.complete(data.posts, null);
  }
  async searchPosts(query: string): Promise<Post[]> {
    const data = await this.call<{posts: (Partial<Post> & {excerpt?: string | null; blurb?: string | null})[]}>(
      'discourse_search_posts', {query, page: 1});
    if (!Array.isArray(data.posts)) return [];
    // Search returns a highlighted excerpt, not the raw body. Hits are previews identified by
    // their post id; the model reads a chosen floor through read_posts. A hit without an id
    // could not be followed up, so it is dropped.
    return data.posts
      .filter(p => Number.isSafeInteger(p.id) && Number.isSafeInteger(p.topic_id))
      .map(p => ({
        id: p.id!, topic_id: p.topic_id!, post_number: Number.isSafeInteger(p.post_number) ? p.post_number! : 0,
        user_id: Number.isSafeInteger(p.user_id) ? p.user_id! : 0,
        username: typeof p.username === 'string' ? p.username : '',
        created_at: typeof p.created_at === 'string' ? p.created_at : '',
        raw: p.raw ?? p.excerpt ?? p.blurb ?? '',
      }));
  }
  /**
   * One upload's bytes. The MCP child owns the credential and the two-hop policy: it
   * follows only the redirect the forum itself returned, and only to a host that redirect
   * named. Nothing about the size or type is trusted from the caller's request.
   */
  async readUpload(url: string, maxBytes: number): Promise<UploadedImage> {
    const data = await this.call<{media_type?: unknown; data?: unknown; bytes?: unknown}>(
      'discourse_read_upload', {upload_url: url, max_bytes: maxBytes});
    if (typeof data.media_type !== 'string' || !data.media_type.startsWith('image/') || typeof data.data !== 'string') {
      throw new PermanentError('Upload is not a readable image');
    }
    const bytes = Buffer.from(data.data, 'base64');
    // The declared length is only a claim; the decoded bytes are what gets handed on.
    if (!bytes.byteLength || bytes.byteLength > maxBytes) throw new PermanentError('Upload is empty or too large');
    return {mediaType: data.media_type, data: new Uint8Array(bytes)};
  }
  /** One create request. The server's own response is the verification; no read-back. */
  async send(topic: number, parent: number, raw: string): Promise<CreatedPost> {
    if (this.config.mode !== 'reply') throw new PermanentError('Posting is not enabled');
    return this.call<CreatedPost>('discourse_create_post', {topic_id: topic, reply_to_post_number: parent, raw});
  }
  async close(): Promise<void> {
    this.closed = true;
    const client = await this.session?.catch(() => undefined);
    this.session = undefined;
    await client?.close();
  }
}
