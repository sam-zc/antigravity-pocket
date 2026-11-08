import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { request as ipcRequest } from 'node:http';
import { statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { WORKSPACE_ID } from '@pocket/protocol';
import {
  secureFixture,
  grants,
  randomSecret,
  certificates,
} from './secure-helpers';
import { until } from './helpers';
import {
  verifyOrigin,
  verifyServe,
  networkProfile,
} from '../services/gateway/src/security/network';
import { startAdmin } from '../services/gateway/src/security/admin';
import { Store } from '../services/gateway/src/db/store';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});
async function setup() {
  const f = await secureFixture();
  cleanup.push(f.close);
  return f;
}
it('requires a trusted chain, matching hostname and unexpired TLS; development bearer never authorizes remote', async () => {
  const f = await setup();
  await verifyOrigin(f.profile.origin, f.store.gatewayId, f.tls.ca);
  await expect(
    verifyOrigin(f.profile.origin, f.store.gatewayId),
  ).rejects.toThrow('TLS');
  await expect(
    new Promise((resolve, reject) => {
      const r = request(
        f.profile.origin,
        { ca: f.tls.ca, servername: 'wrong.example' },
        resolve,
      );
      r.on('error', reject);
      r.end();
    }),
  ).rejects.toThrow();
  expect(
    (await f.request('/v1/bootstrap', undefined, f.auth.token)).status,
  ).toBe(401);
  const dir = mkdtempSync(join(tmpdir(), 'pocket-expired-'));
  try {
    const tls = certificates(dir, '-1');
    const { createServer } = await import('node:https');
    const server = createServer(tls, (_q, r) => r.end('{}'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address() as { port: number };
    try {
      await expect(
        verifyOrigin(
          `https://127.0.0.1:${address.port}`,
          f.store.gatewayId,
          tls.ca,
        ),
      ).rejects.toThrow('TLS');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('atomically permits one claim, exact owner confirmation, rejection, expiry and no exchange replay after lost response', async () => {
  const f = await setup(),
    invitation = f.devices.invite(f.profile.origin, grants);
  const body = {
    invitationId: invitation.invitationId,
    secret: invitation.secret,
    nonce: randomSecret(),
    name: 'Phone',
  };
  const race = await Promise.all([
    f.request('/v1/pairing/claims', body),
    f.request('/v1/pairing/claims', body),
  ]);
  expect(race.map((x) => x.status).sort()).toEqual([200, 409]);
  const claim = race.find((r) => r.status === 200)!.body as {
    claimId: string;
    receipt: string;
    code: string;
  };
  expect(() =>
    f.devices.confirm(claim.claimId, 'Wrong', claim.code, grants, true),
  ).toThrow('exact');
  expect(() =>
    f.devices.confirm(claim.claimId, 'Phone', claim.code, [], true),
  ).toThrow('exact');
  f.devices.confirm(claim.claimId, 'Phone', claim.code, grants, true);
  expect(
    (
      await f.request(`/v1/pairing/claims/${claim.claimId}/exchange`, {
        receipt: claim.receipt,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.request(`/v1/pairing/claims/${claim.claimId}/exchange`, {
        receipt: claim.receipt,
      })
    ).status,
  ).toBe(409);
  const expired = f.devices.invite(f.profile.origin, grants),
    c = f.devices.claim({
      ...body,
      invitationId: expired.invitationId,
      secret: expired.secret,
    });
  f.advance(120001);
  expect(() =>
    f.devices.confirm(c.claimId, 'Phone', c.code, grants, true),
  ).toThrow();
  expect(
    (
      await f.request(`/v1/pairing/claims/${c.claimId}/status`, {
        receipt: c.receipt,
      })
    ).status,
  ).toBe(401);
  const reject = f.devices.invite(f.profile.origin, grants),
    r = f.devices.claim({
      ...body,
      invitationId: reject.invitationId,
      secret: reject.secret,
    });
  f.devices.confirm(r.claimId, 'Phone', r.code, grants, false);
  expect(() => f.devices.exchange(r.claimId, r.receipt)).toThrow();
});
it('rotates refresh families atomically, revokes reused families after commit and preserves independent devices', async () => {
  const f = await setup(),
    a = await f.pair(),
    b = await f.pair();
  const socket = await f.socket(a.pair.accessToken);
  const rotated = await f.request('/v1/auth/refresh', {
    refreshToken: a.pair.refreshToken,
  });
  expect(rotated.status).toBe(200);
  const current = rotated.body as { accessToken: string; refreshToken: string };
  expect(
    (await f.request('/v1/auth/refresh', { refreshToken: a.pair.refreshToken }))
      .status,
  ).toBe(401);
  await until(() => socket.ws.readyState === WebSocket.CLOSED);
  expect(
    (await f.request('/v1/bootstrap', undefined, current.accessToken)).status,
  ).toBe(401);
  expect(
    (
      await f.request('/v1/auth/refresh', {
        refreshToken: current.refreshToken,
      })
    ).status,
  ).toBe(401);
  expect(
    (await f.request('/v1/bootstrap', undefined, b.pair.accessToken)).status,
  ).toBe(200);
  // An ambiguous successful refresh is deliberately not recoverable by replaying its parent.
  const raced = await Promise.all([
    f.request('/v1/auth/refresh', { refreshToken: b.pair.refreshToken }),
    f.request('/v1/auth/refresh', { refreshToken: b.pair.refreshToken }),
  ]);
  expect(raced.map((r) => r.status).sort()).toEqual([200, 401]);
});
it('authorizes snapshots, replay, subscriptions, commands and active delivery against current workspace grants', async () => {
  const f = await setup(),
    a = await f.pair(),
    b = await f.pair([]);
  const c = await f.request(
    '/v1/sessions',
    {
      protocolVersion: 1,
      title: 'Private Mock',
      workspaceId: WORKSPACE_ID,
      adapterId: 'mock',
    },
    a.pair.accessToken,
  );
  const sid = (c.body as { sessionId: string }).sessionId;
  for (const suffix of ['snapshot', 'messages', 'events?after=0'])
    expect(
      (
        await f.request(
          `/v1/sessions/${sid}/${suffix}`,
          undefined,
          b.pair.accessToken,
        )
      ).status,
    ).toBe(404);
  expect(
    (await f.request('/v1/sessions', undefined, b.pair.accessToken)).body,
  ).toEqual({ items: [], nextCursor: null });
  const denied = await f.socket(b.pair.accessToken);
  denied.subscribe('session:' + sid);
  await until(() => denied.ws.readyState === WebSocket.CLOSED);
  expect(denied.frames.some((e) => 'sequence' in e)).toBe(false);
  const live = await f.socket(a.pair.accessToken);
  live.subscribe('session:' + sid);
  await until(() => live.frames.some((e) => e.type === 'subscription.ready'));
  f.devices.reduce(a.pair.deviceId, []);
  await until(() => live.ws.readyState === WebSocket.CLOSED);
  expect(
    (
      await f.request(
        `/v1/sessions/${sid}/snapshot`,
        undefined,
        a.pair.accessToken,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await f.request(
        '/v1/device/events?after=0&epoch=1',
        undefined,
        a.pair.accessToken,
      )
    ).status,
  ).toBe(409);
  expect(
    (await f.request('/v1/device/snapshot', undefined, a.pair.accessToken))
      .body,
  ).toMatchObject({ grantRevision: 2, grants: [] });
  expect(() => f.devices.reduce(a.pair.deviceId, grants)).toThrow('expanded');
  const active = await f.socket(b.pair.accessToken);
  f.devices.revoke(b.pair.deviceId);
  await until(() => active.ws.readyState === WebSocket.CLOSED);
  expect(
    (await f.request('/v1/bootstrap', undefined, b.pair.accessToken)).status,
  ).toBe(401);
});
it('bounds tickets to access expiry, consumes once and invalidates outstanding tickets on logout', async () => {
  const f = await setup(),
    a = await f.pair(),
    s = await f.socket(a.pair.accessToken);
  const t = await f.request('/v1/auth/ws-ticket', {}, a.pair.accessToken),
    ticket = (t.body as { ticket: string }).ticket;
  f.devices.consume(ticket);
  expect(() => f.devices.consume(ticket)).toThrow();
  f.advance(300001);
  await until(() => s.ws.readyState === WebSocket.CLOSED);
  expect(
    (await f.request('/v1/bootstrap', undefined, a.pair.accessToken)).status,
  ).toBe(401);
  const b = await f.pair(),
    pending = await f.request('/v1/auth/ws-ticket', {}, b.pair.accessToken);
  expect(
    (await f.request('/v1/auth/logout', {}, b.pair.accessToken)).status,
  ).toBe(200);
  expect(() =>
    f.devices.consume((pending.body as { ticket: string }).ticket),
  ).toThrow();
});
it('rejects proxy/Origin/Host spoofing without reflecting secrets and keeps owner IPC separate', async () => {
  const f = await setup(),
    a = await f.pair();
  for (const headers of [
    { 'X-Forwarded-For': '127.0.0.1' },
    { Forwarded: 'for=127.0.0.1' },
    { Host: 'evil.example' },
    { Origin: f.profile.origin },
  ]) {
    const r = await f.request(
      '/v1/bootstrap',
      undefined,
      a.pair.accessToken,
      headers,
    );
    expect(r.status).toBe(403);
    expect(JSON.stringify(r.body).includes(a.pair.accessToken)).toBe(false);
  }
  const admin = await startAdmin(
    f.directory,
    f.devices,
    f.workspaces,
    f.profile,
    join(f.directory, 'ca.pem'),
  );
  try {
    expect(statSync(join(f.directory, 'admin.sock')).mode & 0o777).toBe(0o600);
    const cli = await new Promise<string>((resolve, reject) =>
      execFile(
        'pnpm',
        ['admin', 'status'],
        {
          env: { ...process.env, POCKET_STATE_DIR: f.directory },
          encoding: 'utf8',
          timeout: 10000,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    );
    expect(cli.includes('"profile": "lan"')).toBe(true);

    const status = await new Promise<number>((resolve, reject) => {
      const r = ipcRequest(
        {
          socketPath: join(f.directory, 'admin.sock'),
          path: '/admin',
          method: 'POST',
          headers: {
            Host: 'localhost',
            Origin: 'https://evil.example',
            'Content-Type': 'application/json',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      r.on('error', reject);
      r.end(JSON.stringify({ action: 'status' }));
    });
    expect(status).toBe(400);
    expect(
      (await f.request('/admin', { action: 'status' }, a.pair.accessToken))
        .status,
    ).toBe(404);
  } finally {
    await admin.close();
  }
  for (const env of [
    { HOST: '0.0.0.0' },
    {
      POCKET_PROFILE: 'lan',
      HOST: '8.8.8.8',
      POCKET_ORIGIN: 'https://example.com',
    },
    { POCKET_PROFILE: 'serve', POCKET_ORIGIN: 'https://public.example' },
  ])
    expect(() => networkProfile(env)).toThrow();
});
it('persists hashed credentials and devices across SQLite restart without storing bearer plaintext', async () => {
  const f = await setup(),
    a = await f.pair();
  const rows = f.store.db.prepare('SELECT * FROM credentials').all();
  expect(JSON.stringify(rows).includes(a.pair.accessToken)).toBe(false);
  expect(JSON.stringify(rows).includes(a.pair.refreshToken)).toBe(false);
  const dir = mkdtempSync(join(tmpdir(), 'pocket-backup-'));
  const path = join(dir, 'copy.sqlite');
  await f.store.db.backup(path);
  try {
    const copy = new Store(path);
    try {
      expect(
        copy.db
          .prepare('SELECT id FROM devices WHERE id=?')
          .get(a.pair.deviceId),
      ).toBeTruthy();
    } finally {
      copy.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('scopes durable command receipts per device, and refuses replays after scope loss', async () => {
  const f = await setup(),
    a = await f.pair(),
    b = await f.pair(),
    key = randomUUID();
  const body = {
    protocolVersion: 1,
    title: 'Receipt',
    workspaceId: WORKSPACE_ID,
    adapterId: 'mock',
  };
  const one = await f.request('/v1/sessions', body, a.pair.accessToken, {
    'Idempotency-Key': key,
  });
  const two = await f.request('/v1/sessions', body, b.pair.accessToken, {
    'Idempotency-Key': key,
  });
  expect(
    (one.body as { sessionId: string }).sessionId ===
      (two.body as { sessionId: string }).sessionId,
  ).toBe(false);
  f.devices.reduce(a.pair.deviceId, []);
  expect(
    (
      await f.request('/v1/sessions', body, a.pair.accessToken, {
        'Idempotency-Key': key,
      })
    ).status,
  ).toBe(404);
});

it('delivers device invalidations contiguously, snapshots authorized summaries and rejects cross-device streams', async () => {
  const f = await setup(),
    a = await f.pair(),
    b = await f.pair([]),
    viewer = await f.socket(a.pair.accessToken);
  viewer.subscribe(`device:${a.pair.deviceId}:1`);
  await until(() => viewer.frames.some((e) => e.type === 'subscription.ready'));
  const created = await f.request(
    '/v1/sessions',
    {
      protocolVersion: 1,
      title: 'Visible summary',
      workspaceId: WORKSPACE_ID,
      adapterId: 'mock',
    },
    a.pair.accessToken,
  );
  await until(
    () => viewer.frames.filter((e) => e.type === 'device.changed').length === 2,
  );
  expect(
    viewer.frames
      .filter((e) => e.type === 'device.changed')
      .map((e) => e.sequence),
  ).toEqual([1, 2]);
  const snapshot = await f.request(
    '/v1/device/snapshot',
    undefined,
    a.pair.accessToken,
  );
  expect(snapshot.body).toMatchObject({
    through: 2,
    sessions: [{ title: 'Visible summary' }],
  });
  expect(
    (await f.request('/v1/device/snapshot', undefined, b.pair.accessToken))
      .body,
  ).toMatchObject({ through: 1, sessions: [] });
  const other = await f.socket(b.pair.accessToken);
  other.subscribe(`device:${a.pair.deviceId}:1`);
  await until(() => other.ws.readyState === WebSocket.CLOSED);
  expect(other.frames.some((e) => 'sequence' in e)).toBe(false);
  const sid = (created.body as { sessionId: string }).sessionId,
    live = await f.socket(a.pair.accessToken);
  live.subscribe('session:' + sid);
  await f.request(
    `/v1/sessions/${sid}/messages`,
    {
      protocolVersion: 1,
      clientMessageId: randomUUID(),
      text: 'Active revocation',
    },
    a.pair.accessToken,
  );
  await until(() => live.frames.some((e) => e.type === 'message.delta'));
  f.devices.revoke(a.pair.deviceId);
  const cutoff = live.frames.length;
  await until(() => live.ws.readyState === WebSocket.CLOSED);
  expect(
    live.frames.slice(cutoff).some((e) => e.type === 'message.delta'),
  ).toBe(false);
});
it('rate limits pairing globally and rejects invalid-chain and wrong-host WSS before upgrade', async () => {
  const f = await setup();
  for (const opts of [{}, { ca: f.tls.ca, servername: 'wrong.example' }]) {
    const ws = new WebSocket(
      f.profile.origin.replace('https:', 'wss:') + '/v1/events',
      opts,
    );
    await expect(
      new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      }),
    ).rejects.toThrow();
  }
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++)
    statuses.push(
      (
        await f.request('/v1/pairing/claims', {
          invitationId: randomUUID(),
          secret: randomSecret(),
          nonce: randomSecret(),
          name: 'Unknown',
        })
      ).status,
    );
  expect(statuses.at(-1)).toBe(429);
});

it('accepts only exact HTTPS private Serve configuration and refuses Funnel or alternate backends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-serve-'));
  const binary = join(dir, 'tailscale-fixture');
  const config = {
    TCP: { '443': { HTTPS: true } },
    Web: {
      'desktop.example.ts.net:443': {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:4317' } },
      },
    },
    AllowFunnel: { 'desktop.example.ts.net:443': false },
  };
  const save = () =>
    writeFileSync(
      binary,
      '#!' +
        process.execPath +
        '\nconsole.log(' +
        JSON.stringify(JSON.stringify(config)) +
        ');\n',
      { mode: 0o700 },
    );
  try {
    save();
    await verifyServe(binary, 'https://desktop.example.ts.net', 4317);
    config.AllowFunnel['desktop.example.ts.net:443'] = true;
    save();
    await expect(
      verifyServe(binary, 'https://desktop.example.ts.net', 4317),
    ).rejects.toThrow('Funnel');
    config.AllowFunnel['desktop.example.ts.net:443'] = false;
    config.TCP['443'].HTTPS = false;
    save();
    await expect(
      verifyServe(binary, 'https://desktop.example.ts.net', 4317),
    ).rejects.toThrow('exact origin');
    config.TCP['443'].HTTPS = true;
    config.Web['desktop.example.ts.net:443'].Handlers['/'].Proxy =
      'http://192.168.1.2:4317';
    save();
    await expect(
      verifyServe(binary, 'https://desktop.example.ts.net', 4317),
    ).rejects.toThrow('loopback');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
