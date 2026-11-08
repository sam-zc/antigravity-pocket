import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  appCommandSchema,
  bootstrapSchema,
  sessionPageSchema,
  snapshotSchema,
  type Grant,
} from '@pocket/protocol';
import { secureFixture, randomSecret } from './secure-helpers.js';
import { until } from './helpers.js';
import { appAccess } from '../services/gateway/src/experimental/app-access.js';
import type { AppSource } from '../services/gateway/src/experimental/app-projection.js';
import { Store } from '../services/gateway/src/db/store.js';
import { buildApp } from '../services/gateway/src/app.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
function source(coding = false) {
  const conversationId = randomUUID(),
    trajectoryId = randomUUID(),
    workspaceId = randomUUID();
  const ids = Array.from({ length: 36 }, () => randomUUID());
  const observation = (offset = 0) => ({
    conversationId,
    trajectoryId,
    ...(coding
      ? { view: 'coding' as const, laterHistory: 'unobserved' as const }
      : {}),
    steps: Array.from({ length: 20 }, (_, i) => ({
      index: offset + i,
      executionId: ids[offset + i]!,
      role: 'assistant' as const,
      ...(coding ? { appStepType: 15 } : {}),
      text: `Synthetic pilot ${offset + i}`,
      done: true,
    })),
  });
  const value: AppSource = {
    conversationId,
    workspaceId,
    pairedReadOnly: true,
    ...(coding ? { readMode: 'coding' as const } : {}),
    read: async (offset) => observation(offset),
  };
  return { value, observation };
}
const grant = (workspaceId: string, write = false): Grant[] => [
  {
    workspaceId,
    scopes: write ? ['session:read', 'session:write'] : ['session:read'],
  },
];

it('retains the local gate and requires both trusted paired mode and per-source opt-in', async () => {
  const env = {
    POCKET_EXPERIMENTAL_APP_PROJECTION: '1',
    POCKET_APP_ACCESS: 'paired-read-only',
  };
  expect(() => appAccess(env, { mode: 'development' })).toThrow();
  const profile = {
    mode: 'serve' as const,
    origin: 'https://fixture.ts.net',
    host: '127.0.0.1' as const,
  };
  expect(() =>
    appAccess({ POCKET_EXPERIMENTAL_APP_PROJECTION: '1' }, profile),
  ).toThrow('loopback');
  expect(() =>
    appAccess(
      { ...env, POCKET_APP_ENROLLMENTS_FILE: '/private/legacy.json' },
      profile,
    ),
  ).toThrow();
  expect(appAccess(env, profile)).toBe('paired-read-only');
  const store = new Store(':memory:');
  try {
    await expect(
      buildApp({ store, profile, external: source().value }),
    ).rejects.toThrow('explicit read-only');
  } finally {
    store.close();
  }
  let reads = 0;
  const unshared = source().value;
  const f = await secureFixture({
    ...unshared,
    pairedReadOnly: false,
    read: async () => {
      reads++;
      return source().observation();
    },
  });
  cleanup.push(f.close);
  const paired = await f.pair([]);
  expect(
    sessionPageSchema.parse(
      (await f.request('/v1/sessions', undefined, paired.pair.accessToken))
        .body,
    ).items,
  ).toEqual([]);
  expect(reads).toBe(0);
});

it('pairs through HTTPS, isolates sources/devices and denies every App mutation despite a local send opt-in and write grant', async () => {
  const a = source(),
    b = source();
  let sends = 0;
  a.value.prepareSend = async () => async () => {
    sends++;
    return {};
  };
  a.value.sendMode = 'ordinary-text';
  const f = await secureFixture([a.value, b.value]);
  cleanup.push(f.close);
  const sid = f.store.list('', 30, [a.value.workspaceId!]).items[0]!.id;
  const otherSid = f.store.list('', 30, [b.value.workspaceId!]).items[0]!.id;
  const reader = await f.pair(grant(a.value.workspaceId!, true));
  const other = await f.pair(grant(b.value.workspaceId!));
  const token = reader.pair.accessToken;
  expect(
    (await f.request('/v1/bootstrap', undefined, f.auth.token)).status,
  ).toBe(401);
  expect(
    (await f.request('/v1/bootstrap', undefined, randomSecret())).status,
  ).toBe(401);
  const initial = snapshotSchema.parse(
    (await f.request(`/v1/sessions/${sid}/snapshot`, undefined, token)).body,
  );
  expect(initial.session.external).toMatchObject({ readOnly: true });
  expect(initial.session.external?.send).toBeUndefined();
  for (const suffix of ['snapshot', 'messages', 'events?after=0'])
    expect(
      (await f.request(`/v1/sessions/${otherSid}/${suffix}`, undefined, token))
        .status,
    ).toBe(404);
  const key = randomUUID(),
    body = {
      protocolVersion: 1,
      clientMessageId: key,
      text: 'Synthetic denied input',
    };
  for (const [route, payload] of [
    [`/v1/sessions/${sid}/app-commands`, body],
    [
      `/v1/sessions/${sid}/app-commands/${key}/resolve`,
      { ...body, decision: 'reviewed_no_resend' },
    ],
    [`/v1/sessions/${sid}/messages`, body],
    [
      '/v1/sessions',
      {
        protocolVersion: 1,
        adapterId: 'mock',
        workspaceId: a.value.workspaceId,
        title: 'Denied clone',
      },
    ],
  ] as const)
    expect(
      (await f.request(route, payload, token, { 'Idempotency-Key': key }))
        .status,
    ).toBe(403);
  for (const route of [
    `/v1/runs/${a.value.conversationId}/cancel`,
    `/v1/sessions/${sid}/approve`,
    `/v1/sessions/${sid}/permissions`,
  ])
    expect((await f.request(route, { protocolVersion: 1 }, token)).status).toBe(
      404,
    );
  expect(sends).toBe(0);
  expect(
    f.store.db.prepare('SELECT count(*) n FROM external_commands').get(),
  ).toEqual({ n: 0 });
  // A synthetic prior receipt is actor-bound; neither other readers nor local-owner receipts leak.
  const receipt = appCommandSchema.parse({
    commandId: key,
    sessionId: sid,
    conversationId: a.value.conversationId,
    trajectoryId: initial.session.external!.trajectoryId,
    receivedAt: new Date().toISOString(),
    delivery: 'uncertain',
    observedResult: 'not_correlated',
    reason: 'restart',
  });
  f.store.db
    .prepare('INSERT INTO external_commands VALUES(?,?,?,?,?,?)')
    .run(
      key,
      sid,
      reader.pair.deviceId,
      'fixture',
      'Synthetic prior receipt',
      JSON.stringify(receipt),
    );
  expect(
    (
      await f.request(
        `/v1/sessions/${sid}/app-commands/${key}`,
        undefined,
        token,
      )
    ).status,
  ).toBe(200);
  const sameSource = await f.pair(grant(a.value.workspaceId!));
  expect(
    (
      await f.request(
        `/v1/sessions/${sid}/app-commands/${key}`,
        undefined,
        sameSource.pair.accessToken,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await f.request(
        `/v1/sessions/${sid}/app-commands/${key}`,
        undefined,
        other.pair.accessToken,
      )
    ).status,
  ).toBe(404);
  // Older durable send capability is masked consistently in HTTP and outgoing replay.
  f.store.projectExternal(
    a.value.workspaceId!,
    a.observation(),
    'ordinary-text',
    a.value,
  );
  const socket = await f.socket(token);
  socket.subscribe(`session:${sid}`);
  await until(() => socket.frames.some((x) => x.type === 'subscription.ready'));
  const history = (
    await f.request(`/v1/sessions/${sid}/events?after=0`, undefined, token)
  ).body;
  expect(JSON.stringify(history)).not.toContain('"send":');
  expect(JSON.stringify(socket.frames)).not.toContain('"send":');
  await f.replaceExternal(a.value.conversationId);
  await until(() => socket.ws.readyState === WebSocket.CLOSED);
  expect(
    (await f.request(`/v1/sessions/${sid}/snapshot`, undefined, token)).status,
  ).toBe(404);
  const boot = bootstrapSchema.parse(
    (await f.request('/v1/bootstrap', undefined, token)).body,
  );
  expect(boot.device!.sessions).toEqual([]);
  expect(boot.workspaces).toEqual([]);
  expect(
    (
      await f.request(
        `/v1/sessions/${sid}/app-commands/${key}`,
        undefined,
        token,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await f.request(
        `/v1/sessions/${otherSid}/snapshot`,
        undefined,
        other.pair.accessToken,
      )
    ).status,
  ).toBe(200);
});

for (const loss of ['grant', 'device', 'source'] as const)
  it(`denies late history results after ${loss} withdrawal without changing identity or restoring content`, async () => {
    const a = source(true);
    let release: (() => void) | undefined;
    a.value.read = async (offset) => {
      if (offset !== undefined)
        await new Promise<void>((r) => {
          release = r;
        });
      return a.observation(offset);
    };
    const f = await secureFixture(a.value);
    cleanup.push(f.close);
    const sid = f.store.list('', 30, [a.value.workspaceId!]).items[0]!.id;
    const paired = await f.pair(grant(a.value.workspaceId!));
    const token = paired.pair.accessToken;
    const before = f.store.snapshot(sid),
      socket = await f.socket(token);
    socket.subscribe(`session:${sid}`, before.through);
    await until(() =>
      socket.frames.some((x) => x.type === 'subscription.ready'),
    );
    const pending = f.request(
      `/v1/sessions/${sid}/app-history/next`,
      { protocolVersion: 1, expectedEnd: 20 },
      token,
    );
    await until(() => !!release);
    let removal: Promise<void> | undefined;
    if (loss === 'grant') f.devices.reduce(paired.pair.deviceId, []);
    else if (loss === 'device') f.devices.revoke(paired.pair.deviceId);
    else removal = f.replaceExternal(a.value.conversationId);
    release!();
    await removal;
    expect([401, 403, 404]).toContain((await pending).status);
    await until(() => socket.ws.readyState === WebSocket.CLOSED);
    expect(f.store.snapshot(sid).messages).toEqual(before.messages);
    expect([401, 403, 404]).toContain(
      (await f.request(`/v1/sessions/${sid}/events?after=0`, undefined, token))
        .status,
    );
  });

it('consumes WSS tickets once, expires credentials, and resumes authorized read-only replay', async () => {
  const a = source();
  const f = await secureFixture(a.value);
  cleanup.push(f.close);
  const sid = f.store.list('', 30, [a.value.workspaceId!]).items[0]!.id;
  const paired = await f.pair(grant(a.value.workspaceId!));
  const token = paired.pair.accessToken;
  const response = await f.request('/v1/auth/ws-ticket', {}, token),
    ticket = (response.body as { ticket: string }).ticket;
  const url =
    f.profile.origin.replace('https:', 'wss:') + '/v1/events?ticket=' + ticket;
  const first = new WebSocket(url, { ca: f.tls.ca, origin: f.profile.origin });
  await new Promise<void>((resolve, reject) => {
    first.once('open', resolve);
    first.once('error', reject);
  });
  first.close();
  await expect(
    new Promise<void>((resolve, reject) => {
      const reused = new WebSocket(url, {
        ca: f.tls.ca,
        origin: f.profile.origin,
      });
      reused.once('open', () => {
        reused.close();
        resolve();
      });
      reused.once('error', reject);
    }),
  ).rejects.toThrow();
  const resumed = await f.socket(token);
  resumed.subscribe(`session:${sid}`, f.store.snapshot(sid).through);
  await until(() =>
    resumed.frames.some((x) => x.type === 'subscription.ready'),
  );
  f.advance(300001);
  expect(
    (await f.request(`/v1/sessions/${sid}/snapshot`, undefined, token)).status,
  ).toBe(401);
  await until(() => resumed.ws.readyState === WebSocket.CLOSED);
});
