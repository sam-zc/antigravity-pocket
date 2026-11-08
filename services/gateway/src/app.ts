import {
  readOnlySource,
  readOnlySession,
  readOnlyEvent,
  type AppAccess,
} from './experimental/app-access.js';
import { AppCommands } from './experimental/app-commands.js';
import Fastify, { type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import {
  z,
  appSendSchema,
  appCommandSchema,
  id,
  bootstrapSchema,
  cancelSchema,
  createSessionSchema,
  eventPageSchema,
  messagePageSchema,
  promptSchema,
  receiptSchema,
  sequence,
  sessionPageSchema,
  ticketSchema,
  WORKSPACE_ID,
  secretSchema,
  claimReceiptSchema,
  claimStatusSchema,
  tokenPairSchema,
  deviceSnapshotSchema,
  deviceEventSchema,
} from '@pocket/protocol';
import { Store, fingerprint } from './db/store.js';
import { MockAdapter } from './adapters/mock.js';
import { Coordinator } from './modules/coordinator.js';
import { Realtime } from './modules/realtime.js';
import { DevelopmentAuth } from './security/development-auth.js';
import { Devices, type Principal } from './security/devices.js';
import { remoteBoundary, type NetworkProfile } from './security/network.js';
import { Workspaces } from './modules/workspaces.js';
import { DomainError } from './errors.js';
import type { AgentAdapter } from '@pocket/adapter-sdk';
import {
  AppProjection,
  APP_WORKSPACE,
  type AppSource,
} from './experimental/app-projection.js';

export async function buildApp(options: {
  store: Store;
  auth?: DevelopmentAuth;
  profile?: NetworkProfile;
  devices?: Devices;
  adapter?: AgentAdapter;
  realtime?: ConstructorParameters<typeof Realtime>[2];
  external?: AppSource | AppSource[];
  appAccess?: AppAccess;
}) {
  const { store } = options;
  const auth = options.auth ?? new DevelopmentAuth();
  const profile = options.profile ?? { mode: 'development' };
  const pilot = options.appAccess === 'paired-read-only';
  const paired = pilot || options.appAccess === 'paired-send';
  const eligibleSend = (s: AppSource) =>
    options.appAccess === 'paired-send' &&
    !!s.pairedReadOnly &&
    !!s.pairedSend &&
    !s.readMode &&
    s.sendMode === 'ordinary-text' &&
    !!s.prepareSend;
  if (paired && profile.mode === 'development')
    throw new Error('Paired App mode requires a trusted paired profile');
  if (options.external && profile.mode !== 'development' && !paired)
    throw new Error('Paired App access requires explicit read-only mode');
  let sourceEpoch = 0;
  const requestEpoch = new WeakMap<FastifyRequest, number>();
  const devices = options.devices ?? new Devices(store);
  const workspaces = new Workspaces(store);
  const principals = new WeakMap<FastifyRequest, Principal>();
  const app = Fastify({
    ...(profile.mode === 'lan'
      ? {
          https: {
            key: profile.key,
            cert: profile.cert,
            minVersion: 'TLSv1.2' as const,
          },
        }
      : {}),
    maxRequestsPerSocket: 1000,
    logger: false,
    bodyLimit: 400000,
    requestTimeout: 15000,
    connectionTimeout: 15000,
    trustProxy: false,
    genReqId: () => randomUUID(),
  });
  app.server.maxConnections = 128;
  await app.register(rateLimit, { max: 240, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 131072 } });
  const coordinator = new Coordinator(
    store,
    options.adapter ?? new MockAdapter(),
  );
  const enrolled = options.external
    ? Array.isArray(options.external)
      ? options.external
      : [options.external]
    : [];
  const sources = enrolled
    .filter((s) => !paired || s.pairedReadOnly)
    .map((s) => (paired && !eligibleSend(s) ? readOnlySource(s) : s));
  if (
    enrolled.length > 2 ||
    new Set(sources.map((s) => s.conversationId)).size !== sources.length ||
    new Set(sources.map((s) => s.workspaceId ?? APP_WORKSPACE)).size !==
      sources.length
  )
    throw new Error('Invalid experimental enrollment set');
  const externalAllowed = (sid: string) =>
    sources.some(
      (s) =>
        store.session(sid).external?.conversationId === s.conversationId &&
        store.session(sid).workspaceId === (s.workspaceId ?? APP_WORKSPACE),
    );
  const appWorkspace = (workspace: string) =>
    workspace !== WORKSPACE_ID &&
    !!store.db
      .prepare('SELECT 1 FROM workspaces WHERE id=? AND root IS NULL')
      .get(workspace);
  const visibleWorkspace = (workspace: string) =>
    !appWorkspace(workspace) ||
    sources.some((s) => (s.workspaceId ?? APP_WORKSPACE) === workspace);
  devices.visibleWorkspace = visibleWorkspace;
  const canSend = (value: import('@pocket/protocol').Session, p?: Principal) =>
    !paired ||
    (!!p &&
      sources.some(
        (s) =>
          s.conversationId === value.external?.conversationId &&
          (s.workspaceId ?? APP_WORKSPACE) === value.workspaceId &&
          eligibleSend(s),
      ) &&
      devices.allowed(p, value.workspaceId, 'session:read') &&
      devices.allowed(p, value.workspaceId, 'session:write'));
  const presentSession = (
    value: import('@pocket/protocol').Session,
    p?: Principal,
  ) => (canSend(value, p) ? value : readOnlySession(value));
  const presentEvent = (
    value: import('@pocket/protocol').DurableEvent,
    p?: Principal,
  ) =>
    canSend(store.session(value.sessionId), p) ? value : readOnlyEvent(value);
  const realtime = new Realtime(
    store,
    auth,
    options.realtime,
    devices,
    externalAllowed,
    presentEvent,
  );
  store.recover();
  const projections = sources.map((s) => new AppProjection(store, s));
  for (const projection of projections) await projection.start();
  const appCommands = new AppCommands(store, sources);
  // The array is shared with authorization and command dispatch. Removing a source
  // takes effect before waiting for its in-flight read, including command preflight.
  const replaceExternal = async (conversationId: string, next?: AppSource) => {
    if (next && profile.mode !== 'development' && !paired)
      throw new Error('Paired App access requires explicit read-only mode');
    if (next && paired)
      next = next.pairedReadOnly
        ? eligibleSend(next)
          ? next
          : readOnlySource(next)
        : undefined;
    sourceEpoch++; // Retire all already-authorized HTTP responses before an awaited source change.
    const index = sources.findIndex((s) => s.conversationId === conversationId);
    const prior = index < 0 ? undefined : projections[index];
    if (
      next &&
      (next.conversationId !== conversationId ||
        (index < 0 && sources.length >= 2) ||
        sources.some(
          (s, i) =>
            i !== index &&
            (s.workspaceId ?? APP_WORKSPACE) ===
              (next.workspaceId ?? APP_WORKSPACE),
        ))
    )
      throw new Error('Invalid experimental enrollment set');
    if (index >= 0) {
      sources[index]!.retire?.();
      sources.splice(index, 1);
      projections.splice(index, 1);
    }
    realtime.reauthorize();
    await prior?.close();
    if (next) {
      const projection = new AppProjection(store, next);
      sources.push(next);
      projections.push(projection);
      await projection.start();
    }
  };
  devices.onInvalidate = (device, code) => realtime.invalidate(device, code);
  const publicRoutes = new Set([
    '/v1/pairing/claims',
    '/v1/pairing/claims/:id/status',
    '/v1/pairing/claims/:id/exchange',
    '/v1/auth/refresh',
  ]);
  app.addHook('onRequest', async (request, reply) => {
    requestEpoch.set(request, sourceEpoch);
    reply.header('Cache-Control', 'no-store');
    if (profile.mode === 'development') auth.boundary(request);
    else remoteBoundary(request, profile);
    if (request.url === '/health/live') return;
    if (
      profile.mode !== 'development' &&
      publicRoutes.has(request.routeOptions.url ?? '')
    )
      return;
    if (request.routeOptions.url === '/v1/events') {
      if (request.headers.upgrade?.toLowerCase() !== 'websocket')
        throw new DomainError(
          400,
          'upgrade_required',
          'WebSocket upgrade required',
        );
      const { ticket } = z
        .object({ ticket: secretSchema })
        .strict()
        .parse(request.query);
      if (profile.mode === 'development') auth.consume(ticket);
      else principals.set(request, devices.consume(ticket));
    } else if (profile.mode === 'development') auth.authorize(request);
    else {
      const bearer = z
        .string()
        .regex(/^Bearer [a-f0-9]{64}$/)
        .safeParse(request.headers.authorization);
      if (!bearer.success)
        throw new DomainError(
          401,
          'session_expired',
          'Pair with the desktop owner',
        );
      principals.set(request, devices.authenticate(bearer.data.slice(7)));
    }
  });
  const principal = (req: FastifyRequest) => {
    const p = principals.get(req);
    if (!p)
      throw new DomainError(
        403,
        'paired_only',
        'This operation requires a paired device',
      );
    return p;
  };
  const allow = (
    req: FastifyRequest,
    workspace: string,
    scope: 'session:read' | 'session:write' | 'workspace:read',
  ) => {
    if (!visibleWorkspace(workspace))
      throw new DomainError(404, 'not_found', 'Resource unavailable');
    const p = principals.get(req);
    if (p) devices.require(p, workspace, scope);
    else if (
      (workspace !== WORKSPACE_ID &&
        !sources.some(
          (s) =>
            workspace === (s.workspaceId ?? APP_WORKSPACE) &&
            (scope === 'session:read' ||
              (scope === 'session:write' && !!s.prepareSend)),
        )) ||
      scope === 'workspace:read'
    )
      throw new DomainError(404, 'not_found', 'Resource unavailable');
    if (pilot && appWorkspace(workspace) && scope !== 'session:read')
      throw new DomainError(
        403,
        'pilot_read_only',
        'Paired App access is read-only',
      );
  };
  const session = (
    req: FastifyRequest,
    sid: string,
    scope: 'session:read' | 'session:write' = 'session:read',
  ) => {
    const value = store.session(sid);
    if (value.adapterId !== 'mock' && !externalAllowed(sid))
      throw new DomainError(404, 'not_found', 'Resource unavailable');
    allow(req, value.workspaceId, scope);
    return value;
  };
  const kind = (req: FastifyRequest, value: string) =>
    principals.has(req) ? principal(req).device + ':' + value : value;
  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    const status =
      error instanceof DomainError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : statusCode < 500
            ? statusCode
            : 500;
    reply.status(status).send({
      code:
        error instanceof DomainError
          ? error.code
          : status === 400
            ? 'validation'
            : status === 429
              ? 'rate_limit'
              : 'request_failed',
      message:
        error instanceof DomainError
          ? error.message
          : status === 400
            ? 'Request does not match protocol v1'
            : 'Request could not be completed',
      requestId: request.id,
      retryable: status === 429 || status >= 500,
    });
  });
  app.addHook('onSend', async (req, reply, payload) => {
    // Logout intentionally revokes its own principal and returns only a fixed acknowledgement.
    if (
      reply.statusCode < 400 &&
      principals.has(req) &&
      req.routeOptions.url !== '/v1/auth/logout'
    ) {
      devices.current(principal(req));
      if (requestEpoch.get(req) !== sourceEpoch)
        throw new DomainError(
          403,
          'source_changed',
          'Source authority changed; reconnect',
        );
    }
    return payload;
  });
  app.get('/health/live', async () => ({
    ok: true,
    gatewayId: store.gatewayId,
  }));
  app.get('/v1/bootstrap', async (req) =>
    bootstrapSchema.parse({
      protocolVersion: 1,
      gatewayId: store.gatewayId,
      mode: profile.mode === 'development' ? 'loopback-development' : 'paired',
      ...(principals.has(req)
        ? {
            device: devices.snapshot(principal(req)),
            workspaces: workspaces
              .list()
              .filter(
                (w) =>
                  visibleWorkspace(w.id) &&
                  devices
                    .grants(principal(req).device)
                    .some((g) => g.workspaceId === w.id),
              ),
          }
        : {}),
      capabilities: {
        adapter: 'mock',
        streaming: true,
        cancellation: 'local-stop',
        tools: ['mock_fixture'],
        remoteAccess: profile.mode !== 'development',
      },
      workspace: { id: WORKSPACE_ID, name: 'Synthetic sandbox' },
    }),
  );
  app.post('/v1/auth/ws-ticket', async (req) =>
    ticketSchema.parse(
      principals.has(req) ? devices.ticket(principal(req)) : auth.ticket(),
    ),
  );
  app.get('/v1/events', { websocket: true }, (socket, req) =>
    realtime.attach(socket, principals.get(req)),
  );
  const keyOf = (headers: Record<string, unknown>) =>
    z.string().uuid().parse(headers['idempotency-key']);
  app.get('/v1/sessions', async (req) => {
    const q = z
      .object({
        cursor: id.optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .strict()
      .parse(req.query);
    if (q.cursor) session(req, q.cursor);
    const permitted = principals.has(req)
      ? devices
          .grants(principal(req).device)
          .filter(
            (g) =>
              g.scopes.includes('session:read') &&
              visibleWorkspace(g.workspaceId),
          )
          .map((g) => g.workspaceId)
      : [WORKSPACE_ID, ...sources.map((s) => s.workspaceId ?? APP_WORKSPACE)];
    const page = store.list(q.cursor, q.limit, permitted);
    page.items = page.items
      .filter((s) => s.adapterId === 'mock' || externalAllowed(s.id))
      .map((value) => presentSession(value, principals.get(req)));
    return sessionPageSchema.parse(page);
  });
  app.post('/v1/sessions', async (req, reply) => {
    const body = createSessionSchema.parse(req.body);
    if (
      appWorkspace(body.workspaceId) ||
      body.workspaceId === APP_WORKSPACE ||
      sources.some((s) => s.workspaceId === body.workspaceId)
    )
      throw new DomainError(
        403,
        'unsupported_operation',
        'App conversation creation is unavailable',
      );
    allow(req, body.workspaceId, 'session:write');
    allow(req, body.workspaceId, 'session:read');
    const key = keyOf(req.headers);
    const receipt = store.command(
      kind(req, 'session.create'),
      key,
      fingerprint('POST', '/v1/sessions', body),
      () => store.create(body.title, body.workspaceId),
    );
    return reply.code(202).send(receiptSchema.parse(receipt));
  });
  const target = (params: unknown) =>
    z.object({ id }).strict().parse(params).id;
  app.get('/v1/sessions/:id/snapshot', async (req) => {
    const sid = target(req.params);
    session(req, sid);
    const snapshot = store.snapshot(sid);
    return {
      ...snapshot,
      session: presentSession(snapshot.session, principals.get(req)),
    };
  });
  // Advances a bounded local projection only; the upstream operation remains read-only.
  app.post('/v1/sessions/:id/app-history/next', async (req) => {
    const sid = target(req.params);
    const authorize = () => {
      if (profile.mode === 'development') auth.authorize(req);
      session(req, sid);
    };
    authorize();
    const body = z
      .object({
        protocolVersion: z.literal(1),
        expectedEnd: z.number().int().min(20).max(2000),
      })
      .strict()
      .parse(req.body);
    const sourceIndex = sources.findIndex(
      (source) =>
        source.conversationId === store.session(sid).external?.conversationId,
    );
    const projection = projections[sourceIndex];
    if (!projection)
      throw new DomainError(403, 'source_disabled', 'Source is not enabled');
    await projection.next(body.expectedEnd, authorize);
    authorize();
    const snapshot = store.snapshot(sid);
    return {
      ...snapshot,
      session: presentSession(snapshot.session, principals.get(req)),
    };
  });
  app.get('/v1/sessions/:id/messages', async (req) => {
    session(req, target(req.params));
    const q = z
      .object({
        before: z.coerce.number().pipe(sequence).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .strict()
      .parse(req.query);
    return messagePageSchema.parse(
      store.history(target(req.params), q.before, q.limit),
    );
  });
  app.get('/v1/sessions/:id/events', async (req) => {
    const sid = target(req.params);
    session(req, sid);
    const q = z
      .object({
        after: z.coerce.number().pipe(sequence),
        through: z.coerce.number().pipe(sequence).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .strict()
      .parse(req.query);
    const through = Math.min(
      q.through ?? Number.MAX_SAFE_INTEGER,
      store.watermark(sid).high,
    );
    return eventPageSchema.parse({
      events: store
        .events(sid, q.after, through, q.limit)
        .map((value) => presentEvent(value, principals.get(req))),
      through,
    });
  });
  const appActor = (req: FastifyRequest) =>
    principals.has(req) ? principal(req).device : 'development-owner';
  const appAuthority = (req: FastifyRequest, sid: string) => {
    if (profile.mode === 'development') auth.authorize(req);
    session(req, sid, 'session:read');
    if (pilot)
      throw new DomainError(
        403,
        'pilot_read_only',
        'Paired App sending and resolution are unavailable',
      );
    const value = session(req, sid, 'session:write');
    if (!canSend(value, principals.get(req)))
      throw new DomainError(
        403,
        'paired_send_denied',
        'Paired sending requires current source and device consent',
      );
  };
  app.post('/v1/sessions/:id/app-commands', async (req, reply) => {
    const sid = target(req.params);
    appAuthority(req, sid);
    const body = appSendSchema.parse(req.body);
    if (keyOf(req.headers) !== body.clientMessageId)
      throw new DomainError(400, 'command_identity', 'Command IDs must agree');
    const result = appCommands.submit(
      sid,
      body.clientMessageId,
      appActor(req),
      body.text,
      () => appAuthority(req, sid),
    );
    return reply.code(202).send(appCommandSchema.parse(result));
  });
  const appCommandTarget = (params: unknown) =>
    z.object({ id, commandId: id }).strict().parse(params);
  app.get('/v1/sessions/:id/app-commands/:commandId', async (req) => {
    const target = appCommandTarget(req.params);
    session(req, target.id);
    return appCommands.get(target.id, target.commandId, appActor(req));
  });
  app.post('/v1/sessions/:id/app-commands/:commandId/resolve', async (req) => {
    const target = appCommandTarget(req.params);
    appAuthority(req, target.id);
    const body = appSendSchema
      .extend({ decision: z.literal('reviewed_no_resend') })
      .parse(req.body);
    if (body.clientMessageId !== target.commandId)
      throw new DomainError(400, 'command_identity', 'Command IDs must agree');
    return appCommands.resolve(
      target.id,
      target.commandId,
      appActor(req),
      body.text,
    );
  });
  app.post('/v1/sessions/:id/messages', async (req, reply) => {
    const sid = target(req.params);
    session(req, sid, 'session:write');
    if (store.session(sid).adapterId !== 'mock')
      throw new DomainError(
        409,
        'read_only',
        'Use the separate experimental send capability',
      );
    const body = promptSchema.parse(req.body);
    const receipt = store.command(
      kind(req, 'message.submit'),
      keyOf(req.headers),
      fingerprint('POST', `/v1/sessions/${sid}/messages`, body),
      () => store.prompt(sid, body),
    );
    coordinator.kick();
    return reply.code(202).send(receiptSchema.parse(receipt));
  });
  app.post('/v1/runs/:id/cancel', async (req, reply) => {
    const rid = target(req.params);
    const run = store.run(rid);
    session(req, run.sessionId, 'session:write');
    const body = cancelSchema.parse(req.body);
    const receipt = store.command(
      kind(req, 'run.cancel'),
      keyOf(req.headers),
      fingerprint('POST', `/v1/runs/${rid}/cancel`, body),
      () => {
        store.finish(rid, 'cancelled', 'user_cancelled');
        return {
          commandId: randomUUID(),
          sessionId: run.sessionId,
          runId: rid,
          accepted: true,
        };
      },
    );
    coordinator.cancel(rid);
    return reply.code(202).send(receiptSchema.parse(receipt));
  });
  if (profile.mode !== 'development') {
    const tight = {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
          keyGenerator: () => 'pairing-global',
        },
      },
    };
    const receipt = (body: unknown) =>
      z.object({ receipt: secretSchema }).strict().parse(body).receipt;
    app.post('/v1/pairing/claims', tight, async (req) =>
      claimReceiptSchema.parse(devices.claim(req.body)),
    );
    app.post('/v1/pairing/claims/:id/status', tight, async (req) =>
      claimStatusSchema.parse(
        devices.status(target(req.params), receipt(req.body)),
      ),
    );
    app.post('/v1/pairing/claims/:id/exchange', tight, async (req) =>
      tokenPairSchema.parse(
        devices.exchange(target(req.params), receipt(req.body)),
      ),
    );
    app.post('/v1/auth/refresh', tight, async (req) =>
      tokenPairSchema.parse(
        devices.refresh(
          z.object({ refreshToken: secretSchema }).strict().parse(req.body)
            .refreshToken,
        ),
      ),
    );
    app.post('/v1/auth/logout', async (req) => {
      devices.revoke(principal(req).device);
      return { ok: true };
    });
    app.get('/v1/device/snapshot', async (req) =>
      deviceSnapshotSchema.parse(devices.snapshot(principal(req))),
    );
    app.get('/v1/device/events', async (req) => {
      const q = z
        .object({
          after: z.coerce.number().pipe(sequence),
          epoch: z.coerce.number().int().positive(),
          through: z.coerce.number().pipe(sequence).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        })
        .strict()
        .parse(req.query);
      const p = principal(req),
        stream = `device:${p.device}:${q.epoch}`;
      const high = devices.watermark(p);
      const events = devices
        .deviceEvents(p, stream, q.after)
        .filter((e) => e.sequence <= (q.through ?? high))
        .slice(0, q.limit);
      return {
        events: z.array(deviceEventSchema).parse(events),
        through: Math.min(q.through ?? high, high),
      };
    });
    app.get('/v1/workspaces', async (req) => ({
      items: workspaces
        .list()
        .filter(
          (w) =>
            visibleWorkspace(w.id) &&
            devices.allowed(principal(req), w.id, 'workspace:read'),
        ),
    }));
    app.get('/v1/workspaces/:id/files', async (req) => {
      const wid = target(req.params);
      allow(req, wid, 'workspace:read');
      const q = z
        .object({ path: z.string().max(1024).default('') })
        .strict()
        .parse(req.query);
      return workspaces.files(wid, q.path);
    });
    app.post('/v1/workspaces/:id/read', async (req) => {
      const wid = target(req.params);
      allow(req, wid, 'workspace:read');
      const body = z
        .object({ path: z.string().max(1024) })
        .strict()
        .parse(req.body);
      return workspaces.read(wid, body.path);
    });
    app.post('/v1/workspaces/:id/git', async (req) => {
      const wid = target(req.params);
      allow(req, wid, 'workspace:read');
      const body = z
        .object({
          operation: z.enum(['status', 'diff']),
          path: z.string().max(1024).optional(),
        })
        .strict()
        .parse(req.body);
      const result = await workspaces.runGit(wid, body.operation, body.path);
      allow(req, wid, 'workspace:read');
      return result;
    });
  }
  app.addHook('onClose', async () => {
    await appCommands.close();
    for (const projection of projections) await projection.close();
    realtime.close();
    await coordinator.close();
  });
  // Terminate sockets before Fastify waits for upgraded connections.
  app.addHook('preClose', async () => realtime.close());
  return {
    app,
    auth,
    coordinator,
    realtime,
    devices,
    workspaces,
    replaceExternal,
  };
}
