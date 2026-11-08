import { randomUUID } from 'node:crypto';
import type { AppAccess } from './app-access.js';
import { z, type Grant } from '@pocket/protocol';
import type { Store } from '../db/store.js';
import type { AppSource } from './app-projection.js';
import {
  createEnrolledSources,
  enrollmentSchema,
  persistEnrollment,
  type Enrollment,
} from './app-enrollment.js';
import {
  readAppObservation,
  readCodingObservation,
  verifyAppRuntime,
} from './app-runtime.js';
import { ProbeError } from './app-probe.js';

const setupSchema = z
  .object({
    version: z.literal('2.29.0'),
    pid: z.number().int().positive(),
    port: z.number().int().min(1).max(65535),
    ca: z.string().min(1).max(4096),
    pin: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const appOwnerCommand = z.discriminatedUnion('action', [
  z.object({ action: z.literal('app-status') }).strict(),
  z.object({ action: z.literal('app-setup'), ...setupSchema.shape }).strict(),
  z
    .object({
      action: z.literal('app-enroll'),
      url: z.string().max(250),
      title: z.string().min(1).max(80),
      offset: z.number().int().min(0).max(1999).default(0),
      disposable: z.boolean().default(false),
      coding: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.literal('app-disable'),
      conversation: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal('app-enable'),
      conversation: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal('app-pilot'),
      conversation: z.string().uuid(),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal('app-paired-send'),
      conversation: z.string().uuid(),
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal('app-send'),
      conversation: z.string().uuid(),
      enabled: z.boolean(),
    })
    .strict(),
]);
type Command = z.infer<typeof appOwnerCommand>;
const recordSchema = z
  .object({
    source: enrollmentSchema.shape.sources.element,
    enabled: z.boolean(),
  })
  .strict();
type Record = z.infer<typeof recordSchema>;

/** Only exposed through the same-owner Unix socket. Never accepts runtime credentials. */
export class AppOwner {
  private busy = false;
  private failures = new Map<string, string>();
  constructor(
    private store: Store,
    private replace: (id: string, source?: AppSource) => Promise<void>,
    private dependencies = {
      read: readAppObservation,
      verify: verifyAppRuntime,
      sources: createEnrolledSources,
    },
    private access: AppAccess = 'local',
  ) {}
  private get(key: string): unknown {
    const row = this.store.db
      .prepare('SELECT value FROM metadata WHERE key=?')
      .get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  private put(key: string, value: unknown) {
    this.store.db
      .prepare(
        'INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  private records(): Record[] {
    return (
      this.store.db
        .prepare(
          "SELECT value FROM metadata WHERE key LIKE 'app-owner-source:%'",
        )
        .all() as { value: string }[]
    ).map((r) => recordSchema.parse(JSON.parse(r.value)));
  }
  private runtime() {
    const config = setupSchema.parse(this.get('app-owner-runtime'));
    return {
      POCKET_EXPERIMENTAL_APP_PROBE: '1',
      POCKET_APP_VERSION: config.version,
      POCKET_APP_PID: String(config.pid),
      POCKET_APP_PORT: String(config.port),
      POCKET_APP_CA_FILE: config.ca,
      POCKET_APP_CERT_SHA256: config.pin,
    };
  }
  private save(record: Record) {
    this.put(`app-owner-source:${record.source.conversationId}`, record);
  }
  private async activate(record: Record) {
    if (this.access !== 'local' && !record.source.pairedReadOnly) {
      await this.replace(record.source.conversationId);
      return;
    }
    const effective = { ...record.source };
    if (this.access !== 'local') {
      delete effective.sendMode;
      if (
        this.access === 'paired-send' &&
        effective.pairedSend &&
        !effective.readMode
      )
        effective.sendMode = 'ordinary-text';
    }
    const source = (
      await this.dependencies.sources(this.store, this.runtime(), [effective])
    )[0]!;
    await this.replace(record.source.conversationId, source);
    this.failures.delete(record.source.conversationId);
  }
  async restore() {
    for (const record of this.records().filter((r) => r.enabled)) {
      try {
        await this.activate(record);
      } catch (error) {
        this.failures.set(
          record.source.conversationId,
          error instanceof ProbeError ? error.code : 'setup_required',
        );
      }
    }
  }
  status() {
    return {
      mode:
        this.access === 'local'
          ? 'EXPERIMENTAL LOCAL'
          : this.access === 'paired-send'
            ? 'EXPERIMENTAL PAIRED SEND'
            : 'EXPERIMENTAL PAIRED READ-ONLY',
      configured: !!this.get('app-owner-runtime'),
      runtime: this.get('app-owner-runtime'),
      limits: {
        active: 2,
        retained: 8,
        steps: 20,
        responseBytes: 65536,
        codingResponseBytes: 2097152,
        codingStepBytes: 262144,
        codingMaxOffset: 1980,
        maxOffset: 1999,
        commandsPerConversation: 100,
      },
      projectAssociation: 'owner-attested',
      history: 'incomplete; no verified automatic recent-count lookup',
      sources: this.records().map((r) => {
        const row = this.store.db
          .prepare(
            'SELECT session_id FROM external_sessions WHERE conversation_id=?',
          )
          .get(r.source.conversationId) as { session_id: string } | undefined;
        const external = row
          ? this.store.session(row.session_id).external
          : undefined;
        return {
          ...r.source,
          enabled: r.enabled,
          readOnly:
            this.access === 'paired-read-only' ||
            (this.access === 'paired-send'
              ? !r.source.pairedSend ||
                !r.source.pairedReadOnly ||
                !!r.source.readMode
              : !r.source.sendMode),
          pairedSendOptIn: !!r.source.pairedSend,
          pilotShared: !!r.source.pairedReadOnly,
          localSendOptIn: !!r.source.sendMode,
          issue: this.failures.get(r.source.conversationId) ?? external?.issue,
          observation: external?.observation,
          windowStart: external?.windowStart,
          windowEnd: external?.windowEnd,
        };
      }),
    };
  }
  validatePilotGrants(grants: Grant[]) {
    if (this.access === 'local') return;
    for (const grant of grants) {
      const record = this.records().find(
        (r) => r.source.workspaceId === grant.workspaceId,
      );
      if (
        record &&
        (!record.enabled ||
          !record.source.pairedReadOnly ||
          !grant.scopes.includes('session:read') ||
          grant.scopes.some(
            (scope) =>
              scope !== 'session:read' &&
              !(
                scope === 'session:write' &&
                this.access === 'paired-send' &&
                record.source.pairedSend &&
                !record.source.readMode
              ),
          ))
      )
        throw new ProbeError('pilot_read_only_grant_required');
    }
  }
  async execute(input: unknown) {
    const command: Command = appOwnerCommand.parse(input);
    if (command.action === 'app-status') return this.status();
    if (command.action === 'app-send' && this.access !== 'local')
      throw new ProbeError('pilot_read_only');
    if (command.action === 'app-paired-send' && this.access !== 'paired-send')
      throw new ProbeError('paired_send_mode_required');
    if (this.busy) throw new ProbeError('owner_operation_in_progress');
    this.busy = true;
    try {
      if (command.action === 'app-setup') {
        const config = setupSchema.parse({
          version: command.version,
          pid: command.pid,
          port: command.port,
          ca: command.ca,
          pin: command.pin,
        });
        const env = {
          POCKET_EXPERIMENTAL_APP_PROBE: '1',
          POCKET_APP_VERSION: config.version,
          POCKET_APP_PID: String(config.pid),
          POCKET_APP_PORT: String(config.port),
          POCKET_APP_CA_FILE: config.ca,
          POCKET_APP_CERT_SHA256: config.pin,
        };
        await this.dependencies.verify(env);
        // Fail closed while changing a runtime binding. No receipt/mapping is reset.
        for (const r of this.records())
          await this.replace(r.source.conversationId);
        this.put('app-owner-runtime', config);
        await this.restore();
      } else if (command.action === 'app-enroll') {
        const url = new URL(command.url);
        const conversationId = z.string().uuid().parse(url.pathname.slice(3));
        const projectId = z
          .string()
          .uuid()
          .parse(url.searchParams.get('project'));
        if (
          url.protocol !== 'http:' ||
          url.hostname !== '127.0.0.1' ||
          !url.port ||
          url.username ||
          url.password ||
          url.hash ||
          url.pathname !== `/c/${conversationId}` ||
          url.search !== `?project=${projectId}`
        )
          throw new ProbeError('enrollment_identity_rejected');
        const records = this.records();
        if (records.some((r) => r.source.conversationId === conversationId))
          throw new ProbeError('already_enrolled_use_enable');
        if (records.filter((r) => r.enabled).length >= 2)
          throw new ProbeError('active_source_limit');
        if (command.coding && command.offset > 1980)
          throw new ProbeError('invalid_offset');
        const observation = await (
          command.coding ? readCodingObservation : this.dependencies.read
        )(
          { ...this.runtime(), POCKET_APP_FIXTURE_ID: conversationId },
          command.offset,
        );
        const pin = this.get(`app-enrollment:${conversationId}`) as
          Pick<Enrollment, 'workspaceId' | 'marker'> | undefined;
        const source: Enrollment = {
          workspaceId: pin?.workspaceId ?? randomUUID(),
          ...(pin?.marker ? { marker: pin.marker } : {}),
          conversationId,
          projectId,
          trajectoryId: observation.trajectoryId,
          title: command.title,
          observedAppUrl: command.url,
          disposable: command.disposable,
          initialOffset: command.offset,
          ...(command.coding ? { readMode: 'coding' as const } : {}),
        };
        // The fixed reader verifies every step's conversation, trajectory and absolute index.
        persistEnrollment(this.store, source);
        const record = { source, enabled: true };
        this.save(record);
        try {
          await this.activate(record);
        } catch (error) {
          record.enabled = false;
          this.save(record);
          throw error;
        }
      } else {
        const record = this.records().find(
          (r) => r.source.conversationId === command.conversation,
        );
        if (!record) throw new ProbeError('unknown_enrollment');
        if (command.action === 'app-pilot') {
          if (!record.enabled) throw new ProbeError('source_disabled');
          record.source.pairedReadOnly = command.enabled;
          if (!command.enabled) delete record.source.pairedSend;
          this.save(record); // Durable sharing withdrawal before awaiting retirement.
          await this.replace(command.conversation);
          await this.activate(record);
        } else if (command.action === 'app-disable') {
          record.enabled = false;
          delete record.source.sendMode;
          delete record.source.pairedReadOnly;
          delete record.source.pairedSend;
          this.save(record); // Durable deny before asynchronous projection shutdown.
          await this.replace(command.conversation);
        } else {
          if (command.action === 'app-enable') {
            if (
              !record.enabled &&
              this.records().filter((r) => r.enabled).length >= 2
            )
              throw new ProbeError('active_source_limit');
            delete record.source.sendMode; // Re-enabling never restores old write authority.
            delete record.source.pairedSend;
            record.enabled = true;
          } else {
            if (!record.enabled) throw new ProbeError('source_disabled');
            if (command.enabled && record.source.readMode)
              throw new ProbeError('coding_read_only');
            if (command.action === 'app-paired-send') {
              if (command.enabled && !record.source.pairedReadOnly)
                throw new ProbeError('pilot_sharing_required');
              record.source.pairedSend = command.enabled;
            } else if (command.enabled)
              record.source.sendMode = 'ordinary-text';
            else delete record.source.sendMode;
          }
          // Commit the fail-closed generation/consent before asynchronous retirement.
          // A crash while an old read drains must not resurrect prior send consent.
          record.enabled = false;
          this.save(record);
          await this.replace(command.conversation);
          await this.activate(record);
          record.enabled = true;
          this.save(record);
        }
      }
      return this.status();
    } finally {
      this.busy = false;
    }
  }
}
