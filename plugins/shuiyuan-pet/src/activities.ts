import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Answer, CreatedPost, Forum, Model, Post, PostHead, Task } from './types.js';
import { ForumError, PermanentError } from './types.js';
import { prepare, sourceHash } from './context.js';
import { replyBody, replyText } from './trigger.js';
import { Store } from './store.js';

/** True when the server answered and certainly did not create the post. */
function rejected(error: unknown): error is ForumError {
  return error instanceof PermanentError
    || (error instanceof ForumError && error.status !== undefined && error.status >= 400 && error.status < 500);
}
export class Activities {
  busy = false;
  private reconciling = false;
  constructor(readonly store: Store, readonly forum: Forum, readonly model: Model, readonly config: Config) {}
  async recover(): Promise<void> {
    for (const task of this.store.list('sending')) this.store.update(task.id, {state: 'delivery_unknown', error: 'Interrupted send; reconcile before any retry'});
    for (const task of this.store.list('generating')) {
      const answer = task.session_id ? await this.model.recover(task.session_id) : undefined;
      this.store.update(task.id, answer ? {state: 'draft_ready', answer: this.forumAnswer(answer)}
        : {state: 'queued', error: 'Interrupted generation; no completed result'});
    }
    await this.reconcile();
  }
  /** The stored answer is exactly what will be posted. */
  forumAnswer(answer: Answer): Answer {
    return {...answer, text: replyText(replyBody(answer.text, this.config.petName))};
  }
  /**
   * A reply-mode invocation that cannot be answered gets one short notice through the normal
   * send path instead of silence. If the notice cannot be posted either, the task fails.
   */
  fail(task: Task, error: string): void {
    const context = this.store.task(task.id).context;
    const notify = !!context && !task.answer?.notice && task.mode === 'reply' && this.config.mode === 'reply';
    this.store.update(task.id, notify
      ? {state: 'draft_ready', attempts: 0, available_at: 0, error, answer: {notice: true, sessionId: '', turn: 0, soulHash: '',
          text: replyText(`抱歉，${this.config.petName}这次没能回复，请稍后再试。`)}}
      : {state: 'failed', error});
  }
  /**
   * Looks for unknown sends among the newest posts of their topics, one read per topic.
   * Automatic runs only cover recent sends, which are still near the tail; `all` is for
   * an explicit manual reconcile.
   */
  async reconcile(all = false): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const deadline = all ? 0 : Date.now() - this.config.reconcileWindowMs;
      const topics = new Map<number, Task[]>();
      for (const task of this.store.list('delivery_unknown')) {
        if (!task.context || !task.answer || !task.send_started || task.send_started < deadline) continue;
        const topic = task.context.source.topic_id;
        topics.set(topic, [...(topics.get(topic) ?? []), task]);
      }
      for (const [topic, tasks] of topics) {
        let posts: Post[];
        try { posts = await this.forum.recentOwnPosts(topic); }
        catch { continue; /* An unavailable read cannot prove that a write failed. */ }
        for (const task of tasks) {
          const matches = posts.filter(post => this.matchesDelivery(task, post));
          if (matches.length === 1) this.markSent(task, matches[0]!.id);
        }
      }
    } finally { this.reconciling = false; }
  }
  matchesDelivery(task: Task, post: Post): boolean {
    const source = task.context?.source;
    const created = Date.parse(post.created_at);
    return !!source && !!task.answer && post.topic_id === source.topic_id && post.user_id === this.config.ownerId
      && post.reply_to_post_number === source.post_number && post.raw === task.answer.text
      && created >= task.send_started! - 5000 && created <= task.send_started! + 10 * 60_000;
  }
  /** The create response comes from the server for this request, so it is enough to confirm the target. */
  confirmsDelivery(source: Post, created: CreatedPost): boolean {
    return Number.isSafeInteger(created.id) && created.id > 0 && created.topic_id === source.topic_id
      && created.reply_to_post_number === source.post_number && created.username?.toLowerCase() === this.config.owner.toLowerCase();
  }
  markSent(task: Task, postId: number): void {
    this.store.transaction(() => {
      const notice = !!task.answer?.notice;
      this.store.update(task.id, {state: 'sent', sent_id: postId, error: notice ? 'Could not answer; posted the failure notice instead' : null});
      this.store.record(task.id, 'published', {postId, notice});
    });
  }
  async tick(signal: AbortSignal): Promise<void> {
    if (this.busy || signal.aborted) return;
    this.busy = true;
    try {
      const task = this.store.next(Date.now(), this.config.mode === 'reply');
      if (!task) return;
      if (task.state === 'draft_ready') await this.deliver(task, signal);
      else await this.generate(task, signal);
    } finally { this.busy = false; }
  }
  async generate(task: Task, signal: AbortSignal): Promise<void> {
    try {
      // The listener stores the context it read; only manual drafts are read here. Retries reuse it.
      let context = task.context;
      if (!context) {
        context = await prepare(this.forum, this.config, {id: task.source_id}, task.origin === 'manual') ?? null;
        if (!context) { this.store.update(task.id, {state: 'skipped', error: 'Source is not an active invocation'}); return; }
        this.store.update(task.id, {context});
      }
      const source = context.source;
      this.store.update(task.id, {state: 'generating', attempts: task.attempts + 1});
      const recovered = task.session_id ? await this.model.recover(task.session_id) : undefined;
      const sessionId = recovered?.sessionId ?? randomUUID();
      this.store.update(task.id, {session_id: sessionId});
      const raw = recovered ?? await this.model.generate(context, sessionId, AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]), this.forum);
      const answer = this.forumAnswer(raw);
      // discourse_create_post rejects longer bodies before any request, which would read as an unknown send.
      if (!answer.text.trim() || answer.text.length > 30_000) throw new Error('Invalid final response');
      this.store.transaction(() => {
        this.store.update(task.id, {state: 'draft_ready', answer, error: null});
        this.store.record(task.id, 'draft', {context, answer});
      });
    } catch (error) {
      if (error instanceof PermanentError) {
        this.store.update(task.id, {state: 'skipped', error: error.message}); return;
      }
      const attempts = task.attempts + 1;
      const reason = signal.aborted ? 'Generation cancelled' : 'Read or generation failed; inspect session diagnostics';
      if (attempts >= this.config.maxAttempts) this.fail(task, reason);
      else this.store.update(task.id, {state: 'queued', available_at: Date.now() + 10_000 * 2 ** attempts, error: reason});
    }
  }
  async deliver(task: Task, signal: AbortSignal): Promise<void> {
    if (!task.context || !task.answer || task.mode !== 'reply' || this.config.mode !== 'reply') return;
    const retryLater = (error: string) => {
      const attempts = task.attempts + 1;
      if (attempts >= this.config.maxAttempts) this.fail(task, error);
      else this.store.update(task.id, {attempts, available_at: Date.now() + 10_000 * 2 ** attempts, state: 'draft_ready', error});
    };
    const source = task.context.source;
    // One fresh read: the invocation must still exist, in the same place, with the same body.
    let head: PostHead;
    try { head = await this.forum.locate(task.source_id); }
    catch (error) {
      if (error instanceof PermanentError) this.store.update(task.id, {state: 'skipped', error: error.message});
      else retryLater('Send preflight read failed; nothing sent');
      return;
    }
    if (head.topic_id !== source.topic_id
      || head.post_number !== source.post_number || sourceHash(head.raw) !== task.context.sourceHash) {
      this.store.update(task.id, {state: 'skipped', error: 'Source changed, invocation removed, or topic not allowed'}); return;
    }
    if (signal.aborted) return;
    const sendStarted = Date.now();
    this.store.transaction(() => {
      this.store.update(task.id, {state: 'sending', send_started: sendStarted});
      this.store.record(task.id, 'send_intent', {topic: source.topic_id, parent: source.post_number, text: task.answer!.text});
    });
    let created: CreatedPost;
    try { created = await this.forum.send(source.topic_id, source.post_number, task.answer.text); }
    catch (error) {
      if (error instanceof ForumError && error.status === 429) retryLater('Rate limited by the forum; nothing sent');
      else if (rejected(error)) this.fail(task, `Forum rejected the reply: ${[error.message, ...error.details].join('; ')}`);
      else this.store.update(task.id, {state: 'delivery_unknown', error: 'Send outcome unknown; automatic resend prohibited'});
      return;
    }
    if (this.confirmsDelivery(source, created)) this.markSent(task, created.id);
    else this.store.update(task.id, {state: 'delivery_unknown', error: 'Send response could not be verified; automatic resend prohibited'});
  }
}
