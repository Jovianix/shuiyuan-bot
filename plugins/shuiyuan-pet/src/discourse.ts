import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Config } from './config.js';
import type { Activity, CreatedPost, Forum, Post, PostHead } from './types.js';
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
