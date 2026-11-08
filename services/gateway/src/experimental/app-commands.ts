import {
  appCommandSchema,
  appSendTextSchema,
  appOrdinaryTextSchema,
  type AppCommand,
} from '@pocket/protocol';
import type { Store } from '../db/store.js';
import { fingerprint } from '../db/store.js';
import { DomainError } from '../errors.js';
import type { AppSource } from './app-projection.js';

type Row = {
  id: string;
  session_id: string;
  actor: string;
  fingerprint: string;
  text: string;
  data: string;
};
/** One-shot intent journal. Recovery never dispatches, and observations never match text to commands. */
export class AppCommands {
  private closed = false;
  private work = new Set<Promise<void>>();
  constructor(
    private store: Store,
    private sources?: AppSource | AppSource[],
  ) {
    store.db.transaction(() => {
      for (const row of store.db
        .prepare('SELECT * FROM external_commands')
        .all() as Row[]) {
        const command = appCommandSchema.parse(JSON.parse(row.data));
        if (
          command.delivery === 'received' ||
          command.delivery === 'dispatching'
        )
          this.write({
            ...command,
            delivery:
              command.delivery === 'received' ? 'not_sent' : 'uncertain',
            reason: 'restart',
          });
      }
    })();
  }
  private source(sessionId: string) {
    const conversation = this.store.session(sessionId).external?.conversationId;
    const sources = this.sources
      ? Array.isArray(this.sources)
        ? this.sources
        : [this.sources]
      : [];
    return sources.find((s) => s.conversationId === conversation);
  }
  private row(id: string) {
    return this.store.db
      .prepare('SELECT * FROM external_commands WHERE id=?')
      .get(id) as Row | undefined;
  }
  private write(command: AppCommand) {
    this.store.db
      .prepare('UPDATE external_commands SET data=? WHERE id=?')
      .run(JSON.stringify(appCommandSchema.parse(command)), command.commandId);
  }
  get(sessionId: string, id: string, actor: string): AppCommand {
    const row = this.row(id);
    if (!row || row.session_id !== sessionId || row.actor !== actor)
      throw new DomainError(404, 'not_found', 'Command unavailable');
    return appCommandSchema.parse(JSON.parse(row.data));
  }
  private intent(
    sessionId: string,
    id: string,
    actor: string,
    text: string,
    resolution = false,
  ): { command: AppCommand; created: boolean } {
    return this.store.db.transaction(() => {
      const fp = fingerprint('app.send', sessionId, { text });
      const old = this.row(id);
      if (old) {
        if (
          old.session_id !== sessionId ||
          old.actor !== actor ||
          old.fingerprint !== fp
        )
          throw new DomainError(
            409,
            'idempotency_conflict',
            'Command identity is already bound',
          );
        return {
          command: appCommandSchema.parse(JSON.parse(old.data)),
          created: false,
        };
      }
      const session = this.store.session(sessionId),
        external = session.external;
      if (
        !external ||
        external.conversationId !== this.source(sessionId)?.conversationId
      )
        throw new DomainError(404, 'not_found', 'Conversation unavailable');
      const rows = this.store.db
        .prepare('SELECT * FROM external_commands WHERE session_id=?')
        .all(sessionId) as Row[];
      if (rows.length >= 100)
        throw new DomainError(
          409,
          'experiment_limit',
          'Disposable command limit reached',
        );
      if (
        !resolution &&
        rows.some((row) => {
          const c = appCommandSchema.parse(JSON.parse(row.data));
          return (
            !c.resolvedAt &&
            ['received', 'dispatching', 'uncertain'].includes(c.delivery)
          );
        })
      )
        throw new DomainError(
          409,
          'command_unresolved',
          'Resolve the previous send before submitting another',
        );
      const command: AppCommand = {
        commandId: id,
        sessionId,
        conversationId: external.conversationId,
        trajectoryId: external.trajectoryId,
        receivedAt: new Date().toISOString(),
        delivery: resolution ? 'uncertain' : 'received',
        observedResult: 'not_correlated',
      };
      this.store.db
        .prepare('INSERT INTO external_commands VALUES(?,?,?,?,?,?)')
        .run(id, sessionId, actor, fp, text, JSON.stringify(command));
      return { command, created: true };
    })();
  }
  submit(
    sessionId: string,
    id: string,
    actor: string,
    text: string,
    authorize: () => void,
  ) {
    if (this.closed || !this.source(sessionId)?.prepareSend)
      throw new DomainError(
        409,
        'send_unavailable',
        'App sending is unavailable',
      );
    (this.source(sessionId)?.sendMode === 'ordinary-text'
      ? appOrdinaryTextSchema
      : appSendTextSchema
    ).parse(text);
    authorize();
    const result = this.intent(sessionId, id, actor, text);
    if (result.created) {
      // The transaction has committed before preparation or any mutation can start.
      const work = this.dispatch(result.command, text, authorize);
      this.work.add(work);
      void work.finally(() => this.work.delete(work));
    }
    return result.command;
  }
  private async dispatch(
    initial: AppCommand,
    text: string,
    authorize: () => void,
  ) {
    let dispatched = false;
    try {
      const source = this.source(initial.sessionId);
      const send = await source!.prepareSend!();
      const current = appCommandSchema.parse(
        JSON.parse(this.row(initial.commandId)!.data),
      );
      if (current.delivery !== 'received' || current.resolvedAt) return;
      if (this.closed || this.source(initial.sessionId) !== source)
        throw new Error('source_changed');
      authorize(); // Current authority, after asynchronous preflight, immediately before dispatch.
      this.write({
        ...current,
        delivery: 'dispatching',
        dispatchAt: new Date().toISOString(),
      });
      dispatched = true;
      const acknowledgement = await send(text); // Exactly one invocation; never retry.
      const latest = appCommandSchema.parse(
        JSON.parse(this.row(initial.commandId)!.data),
      );
      this.write({
        ...latest,
        delivery: 'acknowledged',
        acknowledgedAt: new Date().toISOString(),
        acknowledgement,
      });
    } catch {
      const latest = appCommandSchema.parse(
        JSON.parse(this.row(initial.commandId)!.data),
      );
      if (latest.delivery !== 'received' && latest.delivery !== 'dispatching')
        return;
      this.write({
        ...latest,
        delivery: dispatched ? 'uncertain' : 'not_sent',
        reason: dispatched ? 'transport_or_response' : 'preflight_or_authority',
      });
    }
  }
  resolve(sessionId: string, id: string, actor: string, text: string) {
    // A tombstone also prevents a delayed POST from dispatching after explicit local resolution.
    const { command } = this.intent(sessionId, id, actor, text, true);
    if (command.delivery === 'dispatching')
      throw new DomainError(
        409,
        'dispatch_in_progress',
        'Wait for dispatch to settle before resolving',
      );
    const resolved: AppCommand = {
      ...command,
      delivery: command.delivery === 'received' ? 'not_sent' : command.delivery,
      resolvedAt: command.resolvedAt ?? new Date().toISOString(),
      reason: 'explicit_resolution',
    };
    this.write(resolved);
    return resolved;
  }
  async close() {
    this.closed = true;
    await Promise.all(this.work);
  }
}
