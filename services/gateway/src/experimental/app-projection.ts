import type { AppAcknowledgement } from '@pocket/protocol';
import type { Store } from '../db/store.js';
import type { AppObservation } from './app-observation.js';
import { ProbeError } from './app-probe.js';
import { DomainError } from '../errors.js';

export const APP_WORKSPACE = '773ca670-e4ad-4ac6-8de4-fbb0196c1080';
export interface AppSource {
  conversationId: string;
  workspaceId?: string;
  projectId?: string;
  title?: string;
  initialOffset?: number;
  sendMode?: 'fixture-text' | 'ordinary-text';
  pairedReadOnly?: boolean;
  pairedSend?: boolean;
  readMode?: 'coding';
  read: (offset?: number) => Promise<AppObservation>;
  retire?: () => void;
  prepareSend?: () => Promise<(text: string) => Promise<AppAcknowledgement>>;
}
export class AppProjection {
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private work: Promise<void> = Promise.resolve();
  constructor(
    private store: Store,
    private source: AppSource,
  ) {}
  async start() {
    this.store.db
      .prepare('INSERT OR IGNORE INTO workspaces VALUES(?,NULL,?,NULL,NULL)')
      .run(
        this.source.workspaceId ?? APP_WORKSPACE,
        this.source.title ?? 'Experimental Antigravity fixture',
      );
    this.store.externalUnavailable(this.source.conversationId);
    await this.refresh();
    this.schedule();
  }
  private schedule() {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => this.schedule());
    }, 3000);
  }
  refresh() {
    return this.enqueue();
  }
  next(expectedEnd: number, authorize: () => void) {
    return this.enqueue(expectedEnd, authorize);
  }
  private enqueue(expectedEnd?: number, authorize?: () => void) {
    const operation = this.work.then(() =>
      this.observe(expectedEnd, authorize),
    );
    this.work = operation.catch(() => {}); // Error is returned to caller; keep the serialized queue usable.
    return operation;
  }
  private async observe(expectedEnd?: number, authorize?: () => void) {
    if (this.closed) throw new ProbeError('source_disabled');
    let offset: number | undefined;
    if (expectedEnd !== undefined) {
      authorize?.();
      const row = this.store.db
        .prepare(
          'SELECT session_id FROM external_sessions WHERE conversation_id=?',
        )
        .get(this.source.conversationId) as { session_id: string } | undefined;
      const external = row
        ? this.store.session(row.session_id).external
        : undefined;
      if (
        this.source.readMode !== 'coding' ||
        !external ||
        external.observation !== 'fresh'
      )
        throw new ProbeError('history_unavailable');
      if (external.windowEnd !== expectedEnd) return; // Duplicate/late taps never advance twice.
      if (
        external.laterHistory !== 'unobserved' ||
        expectedEnd < 20 ||
        expectedEnd >= 2000
      )
        throw new ProbeError('history_limit');
      offset = Math.min(expectedEnd - 4, 1980);
    }
    try {
      const observation = await this.source.read(offset);
      authorize?.();
      if (this.closed) return;
      if (observation.conversationId !== this.source.conversationId)
        throw new Error('identity');
      this.store.projectExternal(
        this.source.workspaceId ?? APP_WORKSPACE,
        observation,
        this.source.prepareSend
          ? (this.source.sendMode ?? 'fixture-text')
          : false,
        this.source,
      );
    } catch (error) {
      // A caller losing authority does not make the shared upstream observation stale.
      if (
        authorize &&
        error instanceof DomainError &&
        [401, 403, 404].includes(error.status)
      )
        throw error;
      const code =
        error instanceof ProbeError || error instanceof DomainError
          ? error.code
          : '';
      if (!this.closed)
        this.store.externalUnavailable(
          this.source.conversationId,
          /gap|identity|limit|unsupported_step|unsafe|wire/.test(code),
          /unsafe/.test(code)
            ? 'unsafe_content'
            : /unsupported_step/.test(code)
              ? 'unsupported_steps'
              : /limit/.test(code)
                ? 'history_limit'
                : /gap|identity/.test(code)
                  ? 'identity_or_gap'
                  : 'runtime_unavailable',
        );
      if (expectedEnd !== undefined) throw error;
    }
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.work;
  }
}
