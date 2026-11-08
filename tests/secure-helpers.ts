import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from 'node:https';
import { randomUUID, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { WORKSPACE_ID, tokenPairSchema, type Grant } from '@pocket/protocol';
import { Store } from '../services/gateway/src/db/store.js';
import { Devices } from '../services/gateway/src/security/devices.js';
import { buildApp } from '../services/gateway/src/app.js';
import { MockAdapter } from '../services/gateway/src/adapters/mock.js';
import type { AppAccess } from '../services/gateway/src/experimental/app-access.js';
import type { AppSource } from '../services/gateway/src/experimental/app-projection.js';
export const grants: Grant[] = [
  { workspaceId: WORKSPACE_ID, scopes: ['session:read', 'session:write'] },
];
export const randomSecret = () => randomBytes(32).toString('hex');
export function certificates(dir: string, days = '2') {
  const run = (args: string[]) =>
    execFileSync('/usr/bin/openssl', args, { cwd: dir, stdio: 'ignore' });
  run([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '2',
    '-subj',
    '/CN=Pocket test CA',
  ]);
  run([
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'server.key',
    '-out',
    'server.csr',
    '-subj',
    '/CN=localhost',
  ]);
  writeFileSync(
    join(dir, 'extensions'),
    'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n',
  );
  if (days === '-1') {
    writeFileSync(join(dir, 'index'), '');
    writeFileSync(join(dir, 'serial'), '01');
    writeFileSync(
      join(dir, 'ca.conf'),
      '[ca]\ndefault_ca=local\n[local]\ndatabase=index\nserial=serial\nnew_certs_dir=.\ncertificate=ca.pem\nprivate_key=ca.key\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n[server]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n',
    );
    run([
      'ca',
      '-batch',
      '-config',
      'ca.conf',
      '-extensions',
      'server',
      '-in',
      'server.csr',
      '-out',
      'server.pem',
      '-startdate',
      '20200101000000Z',
      '-enddate',
      '20200102000000Z',
    ]);
  } else
    run([
      'x509',
      '-req',
      '-in',
      'server.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'server.pem',
      '-days',
      days,
      '-extfile',
      'extensions',
    ]);
  return {
    ca: readFileSync(join(dir, 'ca.pem')),
    cert: readFileSync(join(dir, 'server.pem')),
    key: readFileSync(join(dir, 'server.key')),
  };
}
export async function secureFixture(
  external?: AppSource | AppSource[],
  access: AppAccess = 'paired-read-only',
) {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-secure-')),
    tls = certificates(directory);
  const store = new Store(join(directory, 'db.sqlite'));
  let clock = Date.now();
  const devices = new Devices(store, () => clock);
  const profile = {
    mode: 'lan' as const,
    host: '127.0.0.1',
    origin: 'https://127.0.0.1',
    cert: tls.cert,
    key: tls.key,
  };
  const runtime = await buildApp({
    external: external
      ? (Array.isArray(external) ? external : [external]).map((s) => ({
          pairedReadOnly: true,
          ...s,
        }))
      : undefined,
    appAccess: external ? access : undefined,
    store,
    devices,
    profile,
    adapter: new MockAdapter(5),
  });
  profile.origin = await runtime.app.listen({ host: '127.0.0.1', port: 0 });
  const requestJson = (
    path: string,
    body?: unknown,
    token?: string,
    headers: Record<string, string> = {},
    ca: Buffer | undefined = tls.ca,
  ) =>
    new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request(
        profile.origin + path,
        {
          ca,
          servername: 'localhost',
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(body === undefined
              ? {}
              : {
                  'Content-Type': 'application/json',
                  'Idempotency-Key': randomUUID(),
                }),
            ...headers,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => (data += c.toString()));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode!, body: JSON.parse(data) });
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  async function pair(selected = grants, name = 'Test phone') {
    const invitation = devices.invite(profile.origin, selected);
    const response = await requestJson('/v1/pairing/claims', {
      invitationId: invitation.invitationId,
      secret: invitation.secret,
      nonce: randomSecret(),
      name,
    });
    const claim = response.body as {
      claimId: string;
      receipt: string;
      code: string;
    };
    devices.confirm(claim.claimId, name, claim.code, selected, true);
    const exchange = await requestJson(
      `/v1/pairing/claims/${claim.claimId}/exchange`,
      { receipt: claim.receipt },
    );
    return { pair: tokenPairSchema.parse(exchange.body), claim, invitation };
  }
  async function socket(token: string) {
    const ticketResponse = await requestJson('/v1/auth/ws-ticket', {}, token);
    const { ticket } = ticketResponse.body as { ticket: string };
    const ws = new WebSocket(
      profile.origin.replace('https:', 'wss:') + '/v1/events?ticket=' + ticket,
      { ca: tls.ca, origin: profile.origin },
    );
    const frames: Record<string, unknown>[] = [];
    ws.on('message', (raw) =>
      frames.push(JSON.parse(raw.toString()) as Record<string, unknown>),
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return {
      ws,
      frames,
      subscribe: (stream: string, after = 0) =>
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            protocolVersion: 1,
            streamId: stream,
            after,
          }),
        ),
    };
  }
  return {
    ...runtime,
    store,
    directory,
    tls,
    profile,
    request: requestJson,
    pair,
    socket,
    advance: (ms: number) => {
      clock += ms;
    },
    close: async () => {
      await runtime.app.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
