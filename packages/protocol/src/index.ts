import { z } from 'zod';

export const secretSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const httpsOriginSchema = z
  .string()
  .max(240)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === 'https:' &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname === '/' &&
        u.origin === value
      );
    } catch {
      return false;
    }
  }, 'An exact HTTPS origin is required');
export const scopeSchema = z.enum([
  'session:read',
  'session:write',
  'workspace:read',
]);
export const grantSchema = z
  .object({
    workspaceId: z.string().uuid(),
    scopes: z.array(scopeSchema).min(1).max(3),
  })
  .strict();
export const grantsSchema = z
  .array(grantSchema)
  .max(32)
  .refine((g) => new Set(g.map((x) => x.workspaceId)).size === g.length);
export const deviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\p{L}\p{N} ._-]+$/u);
export const invitationSchema = z
  .object({
    protocolVersion: z.literal(1),
    gatewayId: z.string().uuid(),
    origin: httpsOriginSchema,
    invitationId: z.string().uuid(),
    secret: secretSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict();
export const claimSchema = z
  .object({
    invitationId: z.string().uuid(),
    secret: secretSchema,
    name: deviceNameSchema,
    nonce: secretSchema,
  })
  .strict();
export const claimReceiptSchema = z
  .object({
    claimId: z.string().uuid(),
    receipt: secretSchema,
    code: z.string().regex(/^\d{6}$/),
    expiresAt: z.number(),
  })
  .strict();
export const claimStatusSchema = z
  .object({
    state: z.enum(['claimed', 'approved', 'consumed', 'rejected', 'expired']),
    deviceId: z.string().uuid().nullable(),
    grants: grantsSchema,
  })
  .strict();
export const tokenPairSchema = z
  .object({
    deviceId: z.string().uuid(),
    accessToken: secretSchema,
    refreshToken: secretSchema,
    accessExpiresAt: z.number(),
    refreshExpiresAt: z.number(),
    grantRevision: z.number().int().positive(),
  })
  .strict();
export const deviceEventSchema = z
  .object({
    protocolVersion: z.literal(1),
    eventId: z.string().uuid(),
    streamId: z.string().regex(/^device:[0-9a-f-]{36}:\d+$/),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime(),
    type: z.literal('device.changed'),
    payload: z
      .object({
        deviceId: z.string().uuid(),
        grantRevision: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export const deviceSnapshotSchema = z
  .object({
    deviceId: z.string().uuid(),
    grantRevision: z.number().int().positive(),
    streamId: deviceEventSchema.shape.streamId,
    through: z.number().int().nonnegative(),
    grants: grantsSchema,
    sessions: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            workspaceId: z.string().uuid(),
            title: z.string().max(120),
            revision: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(100),
    nextCursor: z.string().uuid().nullable(),
  })
  .strict();
export const workspaceSchema = z
  .object({ id: z.string().uuid(), name: z.string().max(120) })
  .strict();
export type Grant = z.infer<typeof grantSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type TokenPair = z.infer<typeof tokenPairSchema>;
export type Invitation = z.infer<typeof invitationSchema>;

export const VERSION = 1 as const;
export const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
export const id = z.string().uuid();
export const sequence = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export function utf8Bytes(text: string): number {
  // Works in Hermes without TextEncoder or Node Buffer.
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return bytes;
}
const boundedText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((v) => utf8Bytes(v) <= max, 'Text exceeds byte limit');
export const runStateSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
// Experimental fixture sends are independent of unavailable cancellation.
export const appOrdinaryTextSchema = boundedText(2048).refine(
  (text) =>
    text.trim().length > 0 &&
    ![...text].some((char) => {
      const n = char.charCodeAt(0);
      return n === 127 || (n < 32 && n !== 9 && n !== 10 && n !== 13);
    }),
  'Expected nonempty ordinary text, at most 2048 UTF-8 bytes',
);
export const appSendTextSchema = appOrdinaryTextSchema.refine(
  (text) =>
    /^Reply with exactly POCKET-APP-[A-Z0-9-]{1,64}\. Text only\. Do not use tools, files, commands, or network\.$/.test(
      text,
    ),
  'Only the disposable text-only marker prompt is enabled',
);
export const appSendSchema = z
  .object({
    protocolVersion: z.literal(VERSION),
    clientMessageId: id,
    text: appOrdinaryTextSchema,
  })
  .strict();
export const appAcknowledgementSchema = z
  .object({
    cascadeId: id.optional(),
    executionStatus: z
      .union([z.string().max(100), z.number().int()])
      .optional(),
  })
  .strict();
export const appCommandSchema = z
  .object({
    commandId: id,
    sessionId: id,
    conversationId: id,
    trajectoryId: id,
    receivedAt: z.string().datetime(),
    delivery: z.enum([
      'received',
      'dispatching',
      'acknowledged',
      'uncertain',
      'not_sent',
    ]),
    dispatchAt: z.string().datetime().optional(),
    acknowledgedAt: z.string().datetime().optional(),
    acknowledgement: appAcknowledgementSchema.optional(),
    observedResult: z.literal('not_correlated'),
    reason: z
      .enum([
        'restart',
        'transport_or_response',
        'preflight_or_authority',
        'explicit_resolution',
      ])
      .optional(),
    resolvedAt: z.string().datetime().optional(),
  })
  .strict();
export type AppCommand = z.infer<typeof appCommandSchema>;
export type AppAcknowledgement = z.infer<typeof appAcknowledgementSchema>;
export const appActivityDetailSchema = z
  .object({
    kind: z.literal('command'),
    source: z.literal('app-2.29.0/runCommand'),
    command: boundedText(256).optional(),
    output: boundedText(1024).optional(),
    exitCode: z.number().int().min(-2147483648).max(2147483647).optional(),
    clipped: z.boolean(),
  })
  .strict()
  .refine(
    (value) => utf8Bytes(JSON.stringify(value)) <= 4096,
    'Detail exceeds byte budget',
  );
export type AppActivityDetail = z.infer<typeof appActivityDetailSchema>;
export const appActivitySchema = z
  .object({
    schemaVersion: z.literal('app-2.29.0'),
    kind: z.enum(['tool', 'omitted', 'unknown']),
    label: z.string().min(1).max(80),
    upstreamType: z.number().int().min(0).max(2147483647),
    state: z.enum([
      'pending',
      'running',
      'waiting',
      'done',
      'failed',
      'cancelled',
      'unknown',
    ]),
    detailsOmitted: z.literal(true),
    detail: appActivityDetailSchema.optional(),
    detailOmission: z.literal('window_budget').optional(),
  })
  .strict();
export type AppActivity = z.infer<typeof appActivitySchema>;
export const sessionSchema = z
  .object({
    id,
    title: z.string().min(1).max(120),
    workspaceId: id,
    adapterId: z.enum(['mock', 'antigravity-experimental']),
    external: z
      .object({
        conversationId: id,
        trajectoryId: id,
        stepCount: sequence,
        observation: z.enum(['fresh', 'unavailable', 'gap']),
        issue: z
          .enum([
            'unsupported_steps',
            'history_limit',
            'identity_or_gap',
            'runtime_unavailable',
            'unsafe_content',
          ])
          .optional(),
        observedAt: z.string().datetime(),
        historyComplete: z.literal(false),
        turnState: z.literal('unknown'),
        readOnly: z.boolean(),
        send: z.enum(['fixture-text', 'ordinary-text']).optional(),
        projectId: id.optional(),
        windowStart: sequence.optional(),
        windowEnd: sequence.optional(),
        view: z.literal('coding').optional(),
        laterHistory: z.enum(['unobserved', 'observed_end']).optional(),
      })
      .strict()
      .refine((value) => {
        const { windowStart: start, windowEnd: end } = value;
        return (
          value.readOnly === !value.send &&
          (value.view
            ? value.readOnly && !!value.laterHistory && start !== undefined
            : value.laterHistory === undefined) &&
          ((start === undefined && end === undefined) ||
            (start !== undefined &&
              end !== undefined &&
              start < end &&
              end <= 2000 &&
              end - start <= 20 &&
              value.stepCount === end))
        );
      }, 'Invalid App capability or history window')
      .optional(),
    revision: sequence,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const messageSchema = z
  .object({
    id,
    sessionId: id,
    runId: id,
    ordinal: sequence,
    role: z.enum(['user', 'assistant', 'activity']),
    status: z.enum(['streaming', 'completed', 'failed', 'cancelled']),
    text: boundedText(65536),
    revision: sequence,
    activity: appActivitySchema.optional(),
    appStepType: z.number().int().min(0).max(2147483647).optional(),
    contentOmitted: z.boolean().optional(),
  })
  .strict()
  .refine(
    (m) =>
      m.role === 'activity'
        ? !!m.activity &&
          m.text === '' &&
          m.appStepType === m.activity.upstreamType &&
          (!m.activity.detail ||
            (m.appStepType === 21 &&
              m.activity.kind === 'tool' &&
              !m.activity.detailOmission))
        : !m.activity,
    'Invalid activity row',
  );
export const runSchema = z
  .object({
    id,
    sessionId: id,
    clientMessageId: id,
    state: runStateSchema,
    reason: z.string().max(80).nullable(),
  })
  .strict();
export const toolSchema = z
  .object({
    id,
    runId: id,
    name: z.literal('mock_fixture'),
    status: z.enum(['running', 'completed', 'failed', 'cancelled']),
    summary: z.string().max(1000),
  })
  .strict();
export const createSessionSchema = z
  .object({
    protocolVersion: z.literal(VERSION),
    title: z.string().trim().min(1).max(120),
    workspaceId: id,
    adapterId: z.literal('mock'),
  })
  .strict();
export const promptSchema = z
  .object({
    protocolVersion: z.literal(VERSION),
    clientMessageId: id,
    text: boundedText(65536).refine((v) => v.trim().length > 0, 'Empty prompt'),
  })
  .strict();
export const cancelSchema = z
  .object({ protocolVersion: z.literal(VERSION) })
  .strict();
export const receiptSchema = z
  .object({
    commandId: id,
    sessionId: id,
    runId: id.optional(),
    accepted: z.literal(true),
  })
  .strict();
const envelope = {
  protocolVersion: z.literal(VERSION),
  eventId: id,
  streamId: z.string().regex(/^session:[0-9a-f-]{36}$/),
  sessionId: id,
  sequence: sequence.refine((v) => v > 0),
  timestamp: z.string().datetime(),
};
export const eventSchema = z
  .discriminatedUnion('type', [
    z
      .object({
        ...envelope,
        type: z.literal('external.snapshot'),
        payload: z
          .object({
            session: sessionSchema,
            messages: z.array(messageSchema).max(20),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...envelope,
        type: z.literal('session.created'),
        payload: sessionSchema,
      })
      .strict(),
    z
      .object({
        ...envelope,
        type: z.literal('message.started'),
        payload: messageSchema,
      })
      .strict(),
    z
      .object({
        ...envelope,
        type: z.literal('message.delta'),
        payload: z
          .object({
            messageId: id,
            runId: id,
            expectedRevision: sequence,
            revision: sequence,
            startOffset: sequence,
            text: boundedText(4096),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...envelope,
        type: z.literal('message.completed'),
        payload: z
          .object({
            messageId: id,
            runId: id,
            revision: sequence,
            length: sequence,
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            status: messageSchema.shape.status,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        ...envelope,
        type: z.literal('agent.status.changed'),
        payload: runSchema,
      })
      .strict(),
    z
      .object({
        ...envelope,
        type: z.literal('agent.tool.changed'),
        payload: toolSchema,
      })
      .strict(),
    z
      .object({
        ...envelope,
        type: z.literal('run.terminal'),
        payload: runSchema,
      })
      .strict(),
  ])
  .superRefine((event, context) => {
    if (
      event.type === 'external.snapshot' &&
      (event.payload.session.id !== event.sessionId ||
        event.payload.session.adapterId !== 'antigravity-experimental' ||
        !event.payload.session.external ||
        !validAppWindow(event.payload.session, event.payload.messages) ||
        event.payload.messages.some(
          (message) => message.sessionId !== event.sessionId,
        ))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'External projection identity mismatch',
      });
    if (
      event.type === 'message.started' &&
      (event.payload.activity ||
        event.payload.appStepType !== undefined ||
        event.payload.contentOmitted !== undefined)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'App activity requires an external projection',
      });
    if (event.streamId !== `session:${event.sessionId}`)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Stream/session mismatch',
      });
    if (
      event.type === 'message.delta' &&
      event.payload.revision !== event.payload.expectedRevision + 1
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid delta revision',
      });
    if (
      event.type === 'run.terminal' &&
      !['completed', 'failed', 'cancelled'].includes(event.payload.state)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Nonterminal run',
      });
    if (
      event.type === 'agent.status.changed' &&
      !['queued', 'running'].includes(event.payload.state)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid active state',
      });
  });
function validAppWindow(
  session: z.infer<typeof sessionSchema>,
  messages: z.infer<typeof messageSchema>[],
) {
  const external = session.external;
  if (
    !external ||
    messages.length > 20 ||
    messages.some(
      (message) =>
        (message.activity ||
          message.appStepType !== undefined ||
          message.contentOmitted !== undefined) &&
        external.view !== 'coding',
    ) ||
    (external.view === 'coding' &&
      messages.some(
        (message) =>
          message.appStepType === undefined ||
          utf8Bytes(message.text) > 768 ||
          (message.role === 'user' && message.appStepType !== 14) ||
          (message.role === 'assistant' && message.appStepType !== 15),
      )) ||
    messages.reduce(
      (sum, message) =>
        sum +
        (message.activity?.detail
          ? utf8Bytes(JSON.stringify(message.activity.detail))
          : 0),
      0,
    ) > 4096 ||
    utf8Bytes(JSON.stringify(messages)) > 24000
  )
    return false;
  return (
    external.windowStart === undefined ||
    (external.windowEnd === external.windowStart + messages.length &&
      messages.every(
        (message, i) =>
          message.sessionId === session.id &&
          message.ordinal === external.windowStart! + i + 1,
      ))
  );
}
export const snapshotSchema = z
  .object({
    session: sessionSchema,
    streamId: envelope.streamId,
    through: sequence,
    messages: z.array(messageSchema).max(100),
    runs: z.array(runSchema).max(100),
    tools: z.array(toolSchema).max(100),
    historyBefore: sequence.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.session.adapterId !== 'antigravity-experimental'
        ? value.messages.every(
            (message) =>
              !message.activity &&
              message.appStepType === undefined &&
              message.contentOmitted === undefined,
          )
        : value.runs.length === 0 &&
          value.tools.length === 0 &&
          validAppWindow(value.session, value.messages),
    'Invalid App snapshot',
  );
export const sessionPageSchema = z
  .object({ items: z.array(sessionSchema).max(100), nextCursor: id.nullable() })
  .strict();
export const messagePageSchema = z
  .object({
    items: z.array(messageSchema).max(100),
    nextBefore: sequence.nullable(),
  })
  .strict();
export const eventPageSchema = z
  .object({ events: z.array(eventSchema).max(500), through: sequence })
  .strict();
export const clientFrameSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('subscribe'),
      protocolVersion: z.literal(VERSION),
      streamId: z.union([envelope.streamId, deviceEventSchema.shape.streamId]),
      after: sequence,
    })
    .strict(),
  z
    .object({
      type: z.literal('unsubscribe'),
      streamId: z.union([envelope.streamId, deviceEventSchema.shape.streamId]),
    })
    .strict(),
  z
    .object({
      type: z.literal('ack'),
      streamId: z.union([envelope.streamId, deviceEventSchema.shape.streamId]),
      through: sequence,
    })
    .strict(),
  z.object({ type: z.literal('pong') }).strict(),
]);
export const serverFrameSchema = z.union([
  eventSchema,
  deviceEventSchema,
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('connection.ready'),
        protocolVersion: z.literal(VERSION),
        connectionId: id,
      })
      .strict(),
    z.object({ type: z.literal('connection.ping') }).strict(),
    z
      .object({
        type: z.literal('subscription.ready'),
        streamId: z.union([
          envelope.streamId,
          deviceEventSchema.shape.streamId,
        ]),
        through: sequence,
      })
      .strict(),
    z
      .object({
        type: z.literal('resync.required'),
        streamId: envelope.streamId,
        reason: z.enum(['pruned', 'future_cursor', 'slow_consumer']),
      })
      .strict(),
  ]),
]);
export const errorSchema = z
  .object({
    code: z.string().max(60),
    message: z.string().max(240),
    requestId: z.string().max(100),
    retryable: z.boolean(),
  })
  .strict();
export const bootstrapSchema = z
  .object({
    protocolVersion: z.literal(VERSION),
    gatewayId: id,
    mode: z.enum(['loopback-development', 'paired']),
    capabilities: z
      .object({
        adapter: z.literal('mock'),
        streaming: z.literal(true),
        cancellation: z.literal('local-stop'),
        tools: z.tuple([z.literal('mock_fixture')]),
        remoteAccess: z.boolean(),
      })
      .strict(),
    device: deviceSnapshotSchema.optional(),
    workspaces: z.array(workspaceSchema).max(32).optional(),
    workspace: z
      .object({
        id: z.literal(WORKSPACE_ID),
        name: z.literal('Synthetic sandbox'),
      })
      .strict(),
  })
  .strict();
export const ticketSchema = z
  .object({ ticket: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number() })
  .strict();
export type Session = z.infer<typeof sessionSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Run = z.infer<typeof runSchema>;
export type Tool = z.infer<typeof toolSchema>;
export type DurableEvent = z.infer<typeof eventSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type ServerFrame = z.infer<typeof serverFrameSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type Prompt = z.infer<typeof promptSchema>;
export { z };
