/** A forum call that failed. `status` is the upstream HTTP status when the server answered. */
export class ForumError extends Error {
  constructor(message: string, readonly status?: number, readonly details: string[] = []) { super(message); }
}
/** A failure the same input cannot recover from by retrying. */
export class PermanentError extends ForumError {}
export interface Post {
  id: number; topic_id: number; post_number: number; user_id: number; username: string;
  raw: string; created_at: string; updated_at?: string; reply_to_post_number?: number | null;
  hidden?: boolean; deleted_at?: string | null; post_type?: number; archetype?: string;
}
/** What the server reports for the post it just created. */
export interface CreatedPost { id: number; topic_id: number; post_number: number; reply_to_post_number: number | null; username: string | null; }
/** Where a post is now and its current body, from one request. */
export interface PostHead { id: number; topic_id: number; post_number: number; raw: string; }
export interface Activity {
  post_id: number | null; topic_id?: number | null; post_number?: number | null;
  created_at: string; action_type?: string;
}
export interface Forum {
  locate(id: number): Promise<PostHead>;
  /** Up to `limit` posts centred on one floor of a regular topic, from one request. */
  readAround(topic: number, floor: number, limit: number): Promise<Post[]>;
  /** The owner's own topics and replies plus posts mentioning the owner, newest first. */
  actions(limit: number): Promise<Activity[]>;
  recentOwnPosts(topic: number): Promise<Post[]>;
  send(topic: number, parent: number, raw: string): Promise<CreatedPost>;
  close(): Promise<void>;
}
export interface ContextPack {
  source: Post; related: Post[]; missing: string[]; truncated: number[];
  sourceHash: string;
}
/** `notice` marks the fixed failure notice that replaces an answer that could not be produced or posted. */
export interface Answer { text: string; sessionId: string; turn: number; soulHash: string; notice?: boolean; }
export interface Model {
  generate(input: ContextPack, sessionId: string, signal: AbortSignal): Promise<Answer>;
  recover(sessionId: string): Promise<Answer | undefined>;
}
export type State = 'queued' | 'generating' | 'draft_ready' | 'sending' | 'sent' | 'delivery_unknown' | 'failed' | 'skipped';
export interface Task {
  id: number; source_id: number; state: State; mode: 'draft' | 'reply'; origin: string;
  attempts: number; available_at: number; session_id: string | null;
  context: ContextPack | null; answer: Answer | null; error: string | null;
  sent_id: number | null; send_started: number | null; created_at: number;
}
