import Fastify from 'fastify';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  unlinkSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z, grantsSchema, deviceNameSchema } from '@pocket/protocol';
import { Devices } from './devices.js';
import { Workspaces } from '../modules/workspaces.js';
import { verifyOrigin, type NetworkProfile } from './network.js';
import { appOwnerCommand, type AppOwner } from '../experimental/app-owner.js';
import { ProbeError } from '../experimental/app-probe.js';
export function ownerDirectory(path: string) {
  if (process.platform === 'win32' || !process.getuid)
    throw new Error(
      'Owner IPC currently supports macOS/Linux Unix sockets only',
    );
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = lstatSync(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid() ||
    (s.mode & 0o077) !== 0
  )
    throw new Error(
      'State directory must be an owner-only real directory (0700)',
    );
}
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('invite'), grants: grantsSchema }).strict(),
  z
    .object({
      action: z.literal('confirm'),
      claim: z.string().uuid(),
      name: deviceNameSchema,
      code: z.string().regex(/^\d{6}$/),
      grants: grantsSchema,
      approve: z.boolean(),
    })
    .strict(),
  z.object({ action: z.literal('revoke'), device: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal('reduce'),
      device: z.string().uuid(),
      grants: grantsSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('register'),
      path: z.string().min(1).max(4096),
      name: z.string().min(1).max(120),
    })
    .strict(),
]);
export async function startAdmin(
  state: string,
  devices: Devices,
  workspaces: Workspaces,
  profile: NetworkProfile,
  caPath?: string,
  appOwner?: AppOwner,
) {
  ownerDirectory(state);
  const socketPath = join(state, 'admin.sock');
  // Only after the database owner lock was acquired may a stale same-owner socket be removed.
  try {
    const st = lstatSync(socketPath);
    if (!st.isSocket() || st.uid !== process.getuid!())
      throw new Error('Unsafe admin socket path');
    unlinkSync(socketPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const app = Fastify({
    logger: false,
    bodyLimit: 8192,
    requestTimeout: 5000,
    connectionTimeout: 5000,
    maxRequestsPerSocket: 10,
  });
  app.server.maxConnections = 16;
  app.addHook('onRequest', async (req) => {
    if (
      req.headers.host !== 'localhost' ||
      req.headers.origin ||
      req.headers.authorization ||
      Object.keys(req.headers).some(
        (h) => h === 'forwarded' || h.startsWith('x-forwarded-'),
      )
    )
      throw new Error('Local IPC only');
  });
  app.setErrorHandler((error, _req, reply) =>
    reply.code(400).send({
      ...(error instanceof ProbeError ? { code: error.code } : {}),
      error:
        'Administrative operation refused; check exact IDs, grants, owner permissions and trusted TLS setup.',
    }),
  );
  app.post('/admin', async (req) => {
    const experimental = appOwnerCommand.safeParse(req.body);
    if (experimental.success) {
      if (!appOwner) throw new ProbeError('experimental_local_not_enabled');
      return appOwner.execute(experimental.data);
    }
    const body = command.parse(req.body);
    switch (body.action) {
      case 'status':
        return {
          gatewayId: devices.store.gatewayId,
          profile: profile.mode,
          devices: devices.list(),
          pending: devices.pending(),
          workspaces: workspaces.list(),
        };
      case 'register':
        return workspaces.register(body.path, body.name);
      case 'revoke':
        devices.revoke(body.device);
        return { ok: true };
      case 'reduce':
        devices.reduce(body.device, body.grants);
        return { ok: true };
      case 'confirm':
        if (body.approve) appOwner?.validatePilotGrants(body.grants);
        devices.confirm(
          body.claim,
          body.name,
          body.code,
          body.grants,
          body.approve,
        );
        return { ok: true };
      case 'invite':
        appOwner?.validatePilotGrants(body.grants);
        if (profile.mode === 'development')
          throw new Error('Pairing requires trusted TLS');
        await verifyOrigin(
          profile.origin,
          devices.store.gatewayId,
          caPath ? readFileSync(caPath) : undefined,
        );
        return devices.invite(profile.origin, body.grants);
    }
  });
  await app.listen({ path: socketPath });
  chmodSync(socketPath, 0o600);
  return app;
}
