import { createHash, randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Answer, ContextPack, Forum, Model } from './types.js';
import { renderPayload } from './payload.js';
import { Reader } from './tools.js';

// Structural boundary for the pinned DSH release. No DSH install is needed to test domain code.
export interface Event {
  type: string;
  data: {turn?: number; reason?: {kind: string}; interrupted?: boolean; id?: string; source?: {kind: string};
    message?: {content: {type: string; text?: string}[]}};
}
interface Session { id: string; snapshotEvents(): Event[]; }
interface Agent {
  session: Session; followup(message: unknown): void; whenIdle(): Promise<void>;
  cancel(cause: {kind: 'hook'; reason: string}): void;
}
interface AgentScope {
  tools: {
    restrict(filter: {allow: string[]}): unknown;
    guard(fn: (execution: {name: string}) => string | undefined): unknown;
    register(definition: unknown): () => void;
  };
}
export interface DshContext {
  agents: {create(options: {
    sessionId: string; meta: {cwd: string; agentPreset: string};
    agentOptions: {provider: string; model: string; maxTokens: number};
    signal: AbortSignal; setup(scope: AgentScope, agent: Agent): void;
  }): Promise<{agent: Agent; dispose(): Promise<void>}>};
  sessions: {flush(session: Session): Promise<boolean>};
  // The durable image store. `saveImage` validates the bytes against the declared media
  // type and returns the reference the provider adapter reads them back through.
  attachments: {
    saveImage(input: {data: Uint8Array; mediaType: string; name?: string}):
      Promise<{attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string}>;
  };
  sessionPersistence: {
    stat(id: string): Promise<unknown>;
    open(id: string, access: 'read'): Promise<{read(): Promise<{events: Event[]}>; close(): Promise<void>}>;
  };
  on(event: string, handler: () => unknown): () => void;
}
export function extractAnswer(events: readonly Event[], sessionId: string, inputId?: string): Answer | undefined {
  let turn: number | undefined, inputTurn: number | undefined;
  let system = '', message: Event | undefined, end: Event | undefined, inputs = 0;
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn;
    if (event.type === 'user/message' && event.data.source?.kind === 'user') {
      inputs++;
      if (!inputId || event.data.id === inputId) inputTurn = turn;
    }
    if (event.type === 'system/message') system = event.data.message?.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') ?? '';
    if (event.type === 'assistant/message' && event.data.turn === inputTurn) message = event;
    if (event.type === 'turn/end' && event.data.turn === inputTurn) end = event;
  }
  if (inputs !== 1 || inputTurn === undefined || !message || message.data.interrupted || end?.data.reason?.kind !== 'completed') return undefined;
  const blocks = message.data.message?.content ?? [];
  if (blocks.some(b => b.type === 'tool_use' || b.type === 'tool-call')) return undefined;
  const text = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n').trim();
  if (!text || !system) return undefined;
  return {text, sessionId, turn: inputTurn, soulHash: createHash('sha256').update(system).digest('hex')};
}
export class DshModel implements Model {
  constructor(readonly ctx: DshContext, readonly config: Config) {}
  async generate(input: ContextPack, sessionId: string, signal: AbortSignal, forum: Forum): Promise<Answer> {
    signal.throwIfAborted();
    // A reader per task: its budgets belong to this turn, not to the plugin's lifetime.
    const reader = new Reader(forum, this.config, input, {
      // The harness types images more narrowly than this package does; the store re-checks
      // the declared type against the decoded bytes, so the cast cannot widen what is stored.
      save: ({data, mediaType, name}) => this.ctx.attachments.saveImage(
        {data, mediaType: mediaType as 'image/png', name}),
    });
    const tools = reader.definitions();
    const names = tools.map(tool => tool.name);
    const handle = await this.ctx.agents.create({sessionId,
      meta: {cwd: this.config.workspace, agentPreset: 'pet'},
      agentOptions: {provider: this.config.provider, model: this.config.model, maxTokens: this.config.maxTokens}, signal,
      setup(scope) {
        // Scoped registrations are exempt from restrict(), so the harness's own tools stay
        // out while the forum readers this task was given stay in.
        for (const tool of tools) scope.tools.register(tool);
        scope.tools.restrict({allow: []});
        scope.tools.guard(execution => names.includes(execution.name) ? undefined
          : `Pet sessions run no tools other than ${names.join(', ')}`);
      },
    });
    const abort = () => handle.agent.cancel({kind: 'hook', reason: 'pet task cancelled or timed out'});
    signal.addEventListener('abort', abort, {once: true});
    try {
      signal.throwIfAborted();
      const inputId = randomUUID();
      handle.agent.followup({id: inputId, role: 'user', source: {kind: 'user'}, content: [{type: 'text', text: renderPayload(input, this.config)}]});
      await handle.agent.whenIdle();
      signal.throwIfAborted();
      const answer = extractAnswer(handle.agent.session.snapshotEvents(), sessionId, inputId);
      if (!answer) throw new Error('DSH did not complete the expected turn with final text');
      if (!await this.ctx.sessions.flush(handle.agent.session)) throw new Error('DSH session persistence missing');
      return answer;
    } finally {
      signal.removeEventListener('abort', abort);
      await handle.dispose();
    }
  }
  async recover(sessionId: string): Promise<Answer | undefined> {
    if (!await this.ctx.sessionPersistence.stat(sessionId)) return undefined;
    const handle = await this.ctx.sessionPersistence.open(sessionId, 'read');
    try { return extractAnswer((await handle.read()).events, sessionId); }
    finally { await handle.close(); }
  }
}
