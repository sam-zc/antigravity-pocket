import { budgetActivityDetails } from '../experimental/app-detail-budget.js';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import {
  eventSchema,
  deviceEventSchema,
  messageSchema,
  runSchema,
  sessionSchema,
  snapshotSchema,
  toolSchema,
  WORKSPACE_ID,
  type DurableEvent,
  type Message,
  type Prompt,
  type Receipt,
  type Run,
  type Session,
  type Snapshot,
  type Tool,
} from '@pocket/protocol';
import { DomainError } from '../errors.js';
import { migrate } from './migrations.js';
import { metadata } from './schema.js';
import type { AppObservation } from '../experimental/app-observation.js';

export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function fingerprint(
  method: string,
  target: string,
  body: unknown,
): string {
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, value]) => [k, canonical(value)]),
      );
    return v;
  }
  return hash(JSON.stringify([method, target, canonical(body)]));
}
type Row = { data: string };
type EventInput = DurableEvent extends infer E
  ? E extends DurableEvent
    ? Pick<E, 'type' | 'payload'>
    : never
  : never;
export class Store {
  readonly db: Database.Database;
  readonly gatewayId: string;
  private owner?: Database.Database;
  constructor(path: string) {
    let database: Database.Database | undefined;
    try {
      if (path !== ':memory:') {
        // A separate SQLite exclusive transaction is the process ownership lock.
        // OS locks release on crash; no stale-PID deletion race or shared WAL writer.
        this.owner = new Database(`${path}.owner.sqlite`, { timeout: 0 });
        chmodSync(`${path}.owner.sqlite`, 0o600);
        this.owner.exec('BEGIN EXCLUSIVE');
      }
      this.db = database = new Database(path);
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 3000');
      if (
        path !== ':memory:' &&
        [1, 2, 3].includes(
          this.db.pragma('user_version', { simple: true }) as number,
        )
      ) {
        const backup = path + '.pre-v4-' + randomUUID() + '.sqlite';
        this.db.prepare('VACUUM INTO ?').run(backup);
        chmodSync(backup, 0o600);
      }
      migrate(this.db);
      const orm = drizzle(this.db);
      orm
        .insert(metadata)
        .values({ key: 'gatewayId', value: randomUUID() })
        .onConflictDoNothing()
        .run();
      this.gatewayId = orm
        .select()
        .from(metadata)
        .all()
        .find((v) => v.key === 'gatewayId')!.value;
    } catch (error) {
      database?.close();
      this.owner?.close();
      throw error;
    }
  }
  close() {
    this.db.close();
    this.owner?.close();
    this.owner = undefined;
  }
  private row(sql: string, ...args: (string | number)[]) {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private rows(sql: string, ...args: (string | number)[]) {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  session(id: string): Session {
    const row = this.row('SELECT data FROM sessions WHERE id=?', id);
    if (!row) throw new DomainError(404, 'not_found', 'Session unavailable');
    return sessionSchema.parse(JSON.parse(row.data));
  }
  run(id: string): Run {
    const row = this.row('SELECT data FROM runs WHERE id=?', id);
    if (!row) throw new DomainError(404, 'not_found', 'Run unavailable');
    return runSchema.parse(JSON.parse(row.data));
  }
  list(after = '', limit = 30, workspaces?: string[]) {
    const cursor = after ? this.session(after) : undefined;
    const items = this.rows(
      `SELECT data FROM sessions WHERE json_extract(data,'$.workspaceId') IN (SELECT value FROM json_each(?)) AND (
       json_extract(data,'$.createdAt') < ? OR
       (json_extract(data,'$.createdAt') = ? AND id < ?))
       ORDER BY json_extract(data,'$.createdAt') DESC, id DESC LIMIT ?`,
      JSON.stringify(workspaces ?? [WORKSPACE_ID]),
      cursor?.createdAt ?? '9999',
      cursor?.createdAt ?? '9999',
      cursor?.id ?? '',
      limit + 1,
    ).map((r) => sessionSchema.parse(JSON.parse(r.data)));
    return {
      items: items.slice(0, limit),
      nextCursor: items.length > limit ? items[limit - 1]!.id : null,
    };
  }
  command(
    kind: string,
    key: string,
    digest: string,
    execute: () => Receipt,
  ): Receipt {
    return this.db.transaction(() => {
      const prior = this.db
        .prepare('SELECT fingerprint,data FROM receipts WHERE kind=? AND key=?')
        .get(kind, key) as { fingerprint: string; data: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== digest)
          throw new DomainError(
            409,
            'idempotency_conflict',
            'This command key was used for another request',
          );
        return JSON.parse(prior.data) as Receipt;
      }
      const receipt = execute();
      this.db
        .prepare('INSERT INTO receipts VALUES(?,?,?,?)')
        .run(kind, key, digest, JSON.stringify(receipt));
      return receipt;
    })();
  }
  private emit(sessionId: string, input: EventInput) {
    this.db.prepare('UPDATE streams SET high=high+1 WHERE id=?').run(sessionId);
    const { high } = this.watermark(sessionId);
    const event = eventSchema.parse({
      protocolVersion: 1,
      eventId: randomUUID(),
      streamId: `session:${sessionId}`,
      sessionId,
      sequence: high,
      timestamp: new Date().toISOString(),
      ...input,
    });
    // A 64 KiB prompt can expand sixfold when JSON escapes control characters.
    if (Buffer.byteLength(JSON.stringify(event)) > 400000)
      throw new Error('Event exceeds bounded wire envelope');
    this.db
      .prepare('INSERT INTO events VALUES(?,?,?,?)')
      .run(sessionId, high, event.eventId, JSON.stringify(event));
    if (
      ['session.created', 'agent.status.changed', 'run.terminal'].includes(
        event.type,
      )
    ) {
      const workspace = this.session(sessionId).workspaceId;
      const devices = this.db
        .prepare(
          "SELECT d.id,d.revision FROM devices d JOIN grants g ON g.device=d.id WHERE d.status='active' AND g.workspace=? AND g.scope='session:read'",
        )
        .all(workspace) as { id: string; revision: number }[];
      for (const device of devices) {
        const { high } = this.db
          .prepare(
            'SELECT COALESCE(MAX(sequence),0) high FROM device_events WHERE device=? AND epoch=?',
          )
          .get(device.id, device.revision) as { high: number };
        const change = deviceEventSchema.parse({
          protocolVersion: 1,
          eventId: randomUUID(),
          streamId: `device:${device.id}:${device.revision}`,
          sequence: high + 1,
          timestamp: new Date().toISOString(),
          type: 'device.changed',
          payload: { deviceId: device.id, grantRevision: device.revision },
        });
        this.db
          .prepare('INSERT INTO device_events VALUES(?,?,?,?)')
          .run(device.id, device.revision, high + 1, JSON.stringify(change));
        this.db
          .prepare(
            'DELETE FROM device_events WHERE device=? AND epoch=? AND sequence<=?',
          )
          .run(device.id, device.revision, high + 1 - 10000);
      }
    }
  }
  create(title: string, workspaceId = WORKSPACE_ID): Receipt {
    const id = randomUUID();
    const now = new Date().toISOString();
    const session: Session = {
      id,
      title,
      workspaceId,
      adapterId: 'mock',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare('INSERT INTO sessions VALUES(?,?)')
      .run(id, JSON.stringify(session));
    this.db.prepare('INSERT INTO streams(id) VALUES(?)').run(id);
    this.emit(id, { type: 'session.created', payload: session });
    return { commandId: randomUUID(), sessionId: id, accepted: true };
  }
  prompt(sessionId: string, input: Prompt): Receipt {
    const session = this.session(sessionId);
    if (session.adapterId !== 'mock')
      throw new DomainError(
        409,
        'read_only',
        'Experimental App conversations are read-only',
      );
    const prior = this.db
      .prepare(
        'SELECT id,prompt_hash FROM runs WHERE session_id=? AND client_id=?',
      )
      .get(sessionId, input.clientMessageId) as
      { id: string; prompt_hash: string } | undefined;
    if (prior) {
      if (prior.prompt_hash !== hash(input.text))
        throw new DomainError(
          409,
          'message_conflict',
          'Message ID was used with different text',
        );
      return {
        commandId: input.clientMessageId,
        sessionId,
        runId: prior.id,
        accepted: true,
      };
    }
    if (
      this.db
        .prepare(
          "SELECT 1 FROM runs WHERE session_id=? AND state IN ('queued','running')",
        )
        .get(sessionId)
    )
      throw new DomainError(
        409,
        'run_active',
        'Wait for this session’s active run or stop it',
      );
    const count = this.db
      .prepare(
        "SELECT count(*) AS n FROM runs WHERE state IN ('queued','running')",
      )
      .get() as { n: number };
    if (count.n >= 32)
      throw new DomainError(429, 'capacity', 'Run queue is full');
    const run: Run = {
      id: randomUUID(),
      sessionId,
      clientMessageId: input.clientMessageId,
      state: 'queued',
      reason: null,
    };
    this.db
      .prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)')
      .run(
        run.id,
        sessionId,
        input.clientMessageId,
        hash(input.text),
        run.state,
        JSON.stringify(run),
      );
    const { n } = this.db
      .prepare(
        'SELECT COALESCE(MAX(ordinal),0) AS n FROM messages WHERE session_id=?',
      )
      .get(sessionId) as { n: number };
    const message: Message = {
      id: randomUUID(),
      sessionId,
      runId: run.id,
      ordinal: n + 1,
      role: 'user',
      status: 'completed',
      text: input.text,
      revision: 1,
    };
    this.putMessage(message);
    this.emit(sessionId, { type: 'message.started', payload: message });
    this.emit(sessionId, { type: 'agent.status.changed', payload: run });
    this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(
      JSON.stringify({
        ...session,
        updatedAt: new Date().toISOString(),
        revision: session.revision + 1,
      }),
      sessionId,
    );
    return {
      commandId: input.clientMessageId,
      sessionId,
      runId: run.id,
      accepted: true,
    };
  }
  queued() {
    return this.rows(
      "SELECT data FROM runs WHERE state='queued' ORDER BY rowid LIMIT 32",
    ).map((r) => runSchema.parse(JSON.parse(r.data)));
  }
  start(runId: string): Message | undefined {
    return this.db.transaction(() => {
      const run = this.run(runId);
      if (run.state !== 'queued') return;
      this.putRun({ ...run, state: 'running' });
      const user = this.messagesForRun(runId)[0]!;
      const assistant: Message = {
        ...user,
        id: randomUUID(),
        ordinal: user.ordinal + 1,
        role: 'assistant',
        status: 'streaming',
        text: '',
        revision: 0,
      };
      this.putMessage(assistant);
      this.emit(run.sessionId, { type: 'message.started', payload: assistant });
      return user;
    })();
  }
  private putRun(run: Run) {
    this.db
      .prepare('UPDATE runs SET state=?,data=? WHERE id=?')
      .run(run.state, JSON.stringify(run), run.id);
    this.emit(run.sessionId, {
      type: ['completed', 'failed', 'cancelled'].includes(run.state)
        ? 'run.terminal'
        : 'agent.status.changed',
      payload: run,
    });
  }
  private putMessage(message: Message) {
    messageSchema.parse(message);
    this.db
      .prepare(
        'INSERT INTO messages VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(
        message.id,
        message.sessionId,
        message.runId,
        message.ordinal,
        JSON.stringify(message),
      );
  }
  private messagesForRun(runId: string) {
    return this.rows(
      'SELECT data FROM messages WHERE run_id=? ORDER BY ordinal',
      runId,
    ).map((r) => messageSchema.parse(JSON.parse(r.data)));
  }
  delta(runId: string, text: string) {
    this.db.transaction(() => {
      const run = this.run(runId);
      if (run.state !== 'running') return;
      const msg = this.messagesForRun(runId).find(
        (m) => m.role === 'assistant',
      )!;
      const next = {
        ...msg,
        text: msg.text + text,
        revision: msg.revision + 1,
      };
      this.putMessage(next);
      this.emit(run.sessionId, {
        type: 'message.delta',
        payload: {
          messageId: msg.id,
          runId,
          expectedRevision: msg.revision,
          revision: next.revision,
          startOffset: msg.text.length,
          text,
        },
      });
    })();
  }
  tool(runId: string, status: 'running' | 'completed', summary: string) {
    this.db.transaction(() => {
      const run = this.run(runId);
      if (run.state !== 'running') return;
      const tool: Tool = {
        id: runId,
        runId,
        name: 'mock_fixture',
        status,
        summary,
      };
      this.db
        .prepare(
          'INSERT INTO tools VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        )
        .run(tool.id, runId, JSON.stringify(tool));
      this.emit(run.sessionId, { type: 'agent.tool.changed', payload: tool });
    })();
  }
  finish(
    runId: string,
    state: 'completed' | 'failed' | 'cancelled',
    reason: string | null = null,
  ) {
    this.db.transaction(() => {
      const run = this.run(runId);
      if (!['queued', 'running'].includes(run.state)) return;
      for (const row of this.rows(
        'SELECT data FROM tools WHERE run_id=?',
        runId,
      )) {
        const tool = toolSchema.parse(JSON.parse(row.data));
        if (tool.status === 'running') {
          const next: Tool = {
            ...tool,
            status: state,
            summary: reason ?? state,
          };
          this.db
            .prepare('UPDATE tools SET data=? WHERE id=?')
            .run(JSON.stringify(next), tool.id);
          this.emit(run.sessionId, {
            type: 'agent.tool.changed',
            payload: next,
          });
        }
      }
      const msg = this.messagesForRun(runId).find(
        (m) => m.role === 'assistant',
      );
      if (msg) {
        const next = { ...msg, status: state, revision: msg.revision + 1 };
        this.putMessage(next);
        this.emit(run.sessionId, {
          type: 'message.completed',
          payload: {
            messageId: msg.id,
            runId,
            revision: next.revision,
            length: next.text.length,
            hash: hash(next.text),
            status: state,
          },
        });
      }
      this.putRun({ ...run, state, reason });
    })();
  }
  recover() {
    for (const r of this.rows(
      "SELECT data FROM runs WHERE state IN ('queued','running')",
    ))
      this.finish(
        runSchema.parse(JSON.parse(r.data)).id,
        'failed',
        'process_restarted',
      );
  }
  watermark(sessionId: string) {
    this.session(sessionId);
    return this.db
      .prepare('SELECT high,minimum FROM streams WHERE id=?')
      .get(sessionId) as { high: number; minimum: number };
  }
  events(sessionId: string, after: number, through: number, limit = 200) {
    const { high, minimum } = this.watermark(sessionId);
    if (after < minimum - 1)
      throw new DomainError(410, 'pruned', 'Load a fresh snapshot');
    if (after > high)
      throw new DomainError(409, 'future_cursor', 'Load a fresh snapshot');
    return this.rows(
      'SELECT data FROM events WHERE session_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?',
      sessionId,
      after,
      Math.min(through, high),
      limit,
    ).map((r) => eventSchema.parse(JSON.parse(r.data)));
  }
  history(sessionId: string, before = Number.MAX_SAFE_INTEGER, limit = 50) {
    if (this.session(sessionId).adapterId !== 'mock') {
      const row = this.row(
        'SELECT data FROM external_sessions WHERE session_id=?',
        sessionId,
      );
      const messages = row ? (JSON.parse(row.data) as Message[]) : [];
      const eligible = messages.filter((m) => m.ordinal < before);
      const items = eligible.slice(-limit);
      return {
        items,
        nextBefore: eligible.length > limit ? items[0]!.ordinal : null,
      };
    }
    const items = this.rows(
      'SELECT data FROM messages WHERE session_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?',
      sessionId,
      before,
      limit + 1,
    ).map((r) => messageSchema.parse(JSON.parse(r.data)));
    return {
      items: items.slice(0, limit).reverse(),
      nextBefore: items.length > limit ? items[limit - 1]!.ordinal : null,
    };
  }
  snapshot(sessionId: string): Snapshot {
    return this.db.transaction(() => {
      const page = this.history(sessionId);
      const runs = this.rows(
        'SELECT data FROM runs WHERE session_id=? ORDER BY rowid DESC LIMIT 100',
        sessionId,
      ).map((r) => runSchema.parse(JSON.parse(r.data)));
      const tools = this.rows(
        'SELECT t.data FROM tools t JOIN runs r ON r.id=t.run_id WHERE r.session_id=? ORDER BY t.rowid DESC LIMIT 100',
        sessionId,
      ).map((r) => toolSchema.parse(JSON.parse(r.data)));
      return snapshotSchema.parse({
        session: this.session(sessionId),
        streamId: `session:${sessionId}`,
        through: this.watermark(sessionId).high,
        messages: page.items,
        historyBefore: page.nextBefore,
        runs,
        tools,
      });
    })();
  }
  prune(sessionId: string, keep = 10000) {
    this.db.transaction(() => {
      const { high, minimum } = this.watermark(sessionId);
      const next = Math.max(minimum, high - keep + 1);
      this.db
        .prepare('DELETE FROM events WHERE session_id=? AND sequence<?')
        .run(sessionId, next);
      this.db
        .prepare('UPDATE streams SET minimum=? WHERE id=?')
        .run(next, sessionId);
    })();
  }

  projectExternal(
    workspaceId: string,
    observation: AppObservation,
    canSend: boolean | 'fixture-text' | 'ordinary-text' = false,
    source: { projectId?: string; title?: string; initialOffset?: number } = {},
  ) {
    if (observation.view === 'coding' && canSend)
      throw new DomainError(
        409,
        'coding_read_only',
        'Coding windows are read-only',
      );
    return this.db.transaction(() => {
      const prior = this.db
        .prepare(
          'SELECT session_id,data FROM external_sessions WHERE conversation_id=?',
        )
        .get(observation.conversationId) as
        { session_id: string; data: string } | undefined;
      const now = new Date().toISOString();
      let session: Session;
      if (prior) {
        session = this.session(prior.session_id);
        if (
          session.workspaceId !== workspaceId ||
          session.external?.trajectoryId !== observation.trajectoryId ||
          (session.external.projectId &&
            session.external.projectId !== source.projectId)
        )
          throw new DomainError(
            409,
            'external_identity_changed',
            'Upstream identity changed',
          );
      } else {
        session = {
          id: randomUUID(),
          workspaceId,
          title: source.title ?? 'Antigravity · disposable fixture',
          adapterId: 'antigravity-experimental',
          revision: 0,
          createdAt: now,
          updatedAt: now,
        };
        this.db
          .prepare('INSERT INTO sessions VALUES(?,?)')
          .run(session.id, JSON.stringify(session));
        this.db.prepare('INSERT INTO streams(id) VALUES(?)').run(session.id);
      }
      const previous: Message[] = prior
        ? (JSON.parse(prior.data) as Message[])
        : [];
      const first = observation.steps[0]?.index;
      const last = observation.steps.at(-1)?.index;
      const oldLast = previous.at(-1)?.ordinal;
      if (
        first === undefined ||
        last === undefined ||
        observation.steps.length > 20 ||
        (oldLast !== undefined &&
          (last + 1 < oldLast || first + 1 > oldLast)) ||
        (!prior && first !== (source.initialOffset ?? 0))
      )
        throw new DomainError(
          409,
          'external_gap',
          'Upstream window does not overlap',
        );
      const incoming: Message[] = observation.steps.map((step, index) => {
        if (step.index !== first + index)
          throw new DomainError(409, 'external_gap', 'Missing upstream step');
        const old = previous.find((m) => m.ordinal === step.index + 1);
        if (
          old &&
          (old.runId !== step.executionId ||
            (old.role !== step.role &&
              !(
                observation.view === 'coding' &&
                old.appStepType === step.appStepType
              )) ||
            old.appStepType !== step.appStepType)
        )
          throw new DomainError(
            409,
            'external_gap',
            'Upstream step identity changed',
          );
        return messageSchema.parse({
          id: old?.id ?? randomUUID(),
          sessionId: session.id,
          runId: step.executionId,
          ordinal: step.index + 1,
          role: step.role,
          text: step.text,
          activity: step.activity,
          appStepType: step.appStepType,
          contentOmitted: step.contentOmitted,
          status: step.done ? 'completed' : 'streaming',
          revision: old
            ? old.revision +
              (old.text !== step.text ||
              old.role !== step.role ||
              JSON.stringify(old.activity) !== JSON.stringify(step.activity) ||
              old.contentOmitted !== step.contentOmitted ||
              old.status !== (step.done ? 'completed' : 'streaming')
                ? 1
                : 0)
            : 1,
        });
      });
      const merged = [
        ...previous.filter((m) => m.ordinal <= first),
        ...incoming,
      ].slice(-20);
      const messages = budgetActivityDetails(merged).map((message) => {
        const old = previous.find((row) => row.id === message.id);
        if (!old) return message;
        const changed =
          old.text !== message.text ||
          old.role !== message.role ||
          old.status !== message.status ||
          old.contentOmitted !== message.contentOmitted ||
          JSON.stringify(old.activity) !== JSON.stringify(message.activity);
        return { ...message, revision: old.revision + (changed ? 1 : 0) };
      });
      if (Buffer.byteLength(JSON.stringify(messages)) > 24000)
        throw new DomainError(
          409,
          'projection_limit',
          'Bounded window exceeds byte budget',
        );
      if (
        prior &&
        prior.data === JSON.stringify(messages) &&
        session.external?.observation === 'fresh' &&
        session.external.view === observation.view &&
        session.external.laterHistory === observation.laterHistory &&
        session.external.readOnly === !canSend &&
        session.external.send ===
          (canSend === true ? 'fixture-text' : canSend || undefined)
      )
        return session.id;
      session = sessionSchema.parse({
        ...session,
        revision: session.revision + 1,
        updatedAt: now,
        external: {
          conversationId: observation.conversationId,
          trajectoryId: observation.trajectoryId,
          stepCount: last + 1,
          windowStart: messages[0]!.ordinal - 1,
          windowEnd: last + 1,
          ...(source.projectId ? { projectId: source.projectId } : {}),
          observation: 'fresh',
          observedAt: now,
          historyComplete: false,
          view: observation.view,
          laterHistory: observation.laterHistory,
          turnState: 'unknown',
          readOnly: !canSend,
          ...(canSend
            ? { send: canSend === true ? 'fixture-text' : canSend }
            : {}),
        },
      });
      this.db
        .prepare('UPDATE sessions SET data=? WHERE id=?')
        .run(JSON.stringify(session), session.id);
      this.db
        .prepare(
          'INSERT INTO external_sessions VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data',
        )
        .run(session.id, observation.conversationId, JSON.stringify(messages));
      if (!prior)
        this.emit(session.id, { type: 'session.created', payload: session });
      this.emit(session.id, {
        type: 'external.snapshot',
        payload: { session, messages },
      });
      this.prune(session.id, 200);
      return session.id;
    })();
  }

  externalUnavailable(
    conversationId: string,
    gap = false,
    issue?:
      | 'unsafe_content'
      | 'unsupported_steps'
      | 'history_limit'
      | 'identity_or_gap'
      | 'runtime_unavailable',
  ) {
    this.db.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT session_id,data FROM external_sessions WHERE conversation_id=?',
        )
        .get(conversationId) as
        { session_id: string; data: string } | undefined;
      if (!row) return;
      const current = this.session(row.session_id),
        observation = gap ? 'gap' : 'unavailable';
      if (
        !current.external ||
        (current.external.observation === observation &&
          current.external.issue === issue)
      )
        return;
      const session: Session = {
        ...current,
        revision: current.revision + 1,
        external: { ...current.external, observation, issue },
      };
      this.db
        .prepare('UPDATE sessions SET data=? WHERE id=?')
        .run(JSON.stringify(session), session.id);
      this.emit(session.id, {
        type: 'external.snapshot',
        payload: { session, messages: JSON.parse(row.data) as Message[] },
      });
      this.prune(session.id, 200);
    })();
  }
}
