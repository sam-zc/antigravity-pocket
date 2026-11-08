import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  appCommandSchema,
  sessionPageSchema,
  snapshotSchema,
  type Grant,
} from '@pocket/protocol';
import { secureFixture } from './secure-helpers.js';
import { until } from './helpers.js';
import type { AppSource } from '../services/gateway/src/experimental/app-projection.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const grant = (workspaceId: string, write = false): Grant[] => [
  {
    workspaceId,
    scopes: write ? ['session:read', 'session:write'] : ['session:read'],
  },
];
function source() {
  const conversationId = randomUUID(),
    trajectoryId = randomUUID(),
    workspaceId = randomUUID();
  let sends = 0;
  const value: AppSource = {
    conversationId,
    workspaceId,
    pairedReadOnly: true,
    pairedSend: true,
    sendMode: 'ordinary-text',
    read: async () => ({
      conversationId,
      trajectoryId,
      steps: [
        {
          index: 0,
          executionId: trajectoryId,
          role: 'assistant',
          text: 'Synthetic ordinary fixture',
          done: true,
        },
      ],
    }),
    prepareSend: async () => async () => {
      sends++;
      return {};
    },
  };
  return { value, sends: () => sends };
}

it('uses current exact device/source authority for one-shot HTTPS sends and per-device HTTP/WSS capabilities', async () => {
  const a = source(),
    b = source();
  const f = await secureFixture([a.value, b.value], 'paired-send');
  cleanup.push(f.close);
  const writer = await f.pair(grant(a.value.workspaceId!, true)),
    reader = await f.pair(grant(a.value.workspaceId!));
  const token = writer.pair.accessToken,
    readToken = reader.pair.accessToken;
  expect(
    (await f.request('/v1/bootstrap', undefined, f.auth.token)).status,
  ).toBe(401);
  const list = async (t: string) =>
    sessionPageSchema.parse(
      (await f.request('/v1/sessions', undefined, t)).body,
    ).items;
  const [session] = await list(token);
  const sid = session!.id;
  expect(session!.external?.send).toBe('ordinary-text');
  expect((await list(readToken))[0]!.external?.send).toBeUndefined();
  expect(await list(token)).toHaveLength(1);
  const other = await f.pair(grant(b.value.workspaceId!));
  const otherSid = (await list(other.pair.accessToken))[0]!.id;
  const key = randomUUID(),
    body = {
      protocolVersion: 1,
      clientMessageId: key,
      text: 'Harmless fixture greeting',
    },
    headers = { 'Idempotency-Key': key };
  expect(
    (
      await f.request(
        `/v1/sessions/${sid}/app-commands`,
        body,
        readToken,
        headers,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await f.request(
        `/v1/sessions/${otherSid}/app-commands`,
        body,
        token,
        headers,
      )
    ).status,
  ).toBe(404);
  const send = () =>
    f.request(`/v1/sessions/${sid}/app-commands`, body, token, headers);
  expect((await send()).status).toBe(202);
  expect((await send()).status).toBe(202);
  await until(() => a.sends() === 1);
  const receipt = appCommandSchema.parse(
    (
      await f.request(
        `/v1/sessions/${sid}/app-commands/${key}`,
        undefined,
        token,
      )
    ).body,
  );
  expect(receipt).toMatchObject({
    delivery: 'acknowledged',
    observedResult: 'not_correlated',
    conversationId: a.value.conversationId,
  });
  expect(
    (
      await f.request(
        `/v1/sessions/${sid}/app-commands/${key}`,
        undefined,
        readToken,
      )
    ).status,
  ).toBe(404);
  const socket = await f.socket(readToken);
  socket.subscribe(`session:${sid}`);
  await until(() => socket.frames.some((x) => x.type === 'subscription.ready'));
  expect(JSON.stringify(socket.frames)).not.toContain('"send":');
  expect(
    JSON.stringify(
      (
        await f.request(
          `/v1/sessions/${sid}/events?after=0`,
          undefined,
          readToken,
        )
      ).body,
    ),
  ).not.toContain('"send":');
  expect(
    snapshotSchema.parse(
      (await f.request(`/v1/sessions/${sid}/snapshot`, undefined, readToken))
        .body,
    ).session.external?.readOnly,
  ).toBe(true);
  expect(a.sends()).toBe(1);
  expect(b.sends()).toBe(0);
});

for (const missing of ['mode', 'share', 'source', 'coding'] as const)
  it(`denies paired sends despite stale wider grants when ${missing} consent is missing`, async () => {
    const a = source();
    if (missing === 'source') a.value.pairedSend = false;
    if (missing === 'coding') a.value.readMode = 'coding';
    const f = await secureFixture(
      a.value,
      missing === 'mode' ? 'paired-read-only' : 'paired-send',
    );
    cleanup.push(f.close);
    const writer = await f.pair(grant(a.value.workspaceId!, true)),
      token = writer.pair.accessToken;
    if (missing === 'share')
      await f.replaceExternal(a.value.conversationId, {
        ...a.value,
        pairedReadOnly: false,
      });
    const list = sessionPageSchema.parse(
      (await f.request('/v1/sessions', undefined, token)).body,
    );
    if (missing === 'share') {
      expect(list.items).toEqual([]);
      return;
    }
    const sid = list.items[0]!.id,
      key = randomUUID();
    expect(list.items[0]!.external?.send).toBeUndefined();
    expect(
      (
        await f.request(
          `/v1/sessions/${sid}/app-commands`,
          { protocolVersion: 1, clientMessageId: key, text: 'Not authorized' },
          token,
          { 'Idempotency-Key': key },
        )
      ).status,
    ).toBe(403);
    expect(a.sends()).toBe(0);
  });

for (const loss of ['source-send', 'source', 'grant', 'revoke'] as const)
  it(`records not-sent when ${loss} authority is withdrawn during preparation`, async () => {
    const a = source();
    let release!: () => void,
      calls = 0;
    a.value.prepareSend = async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return async () => {
        calls++;
        return {};
      };
    };
    const f = await secureFixture(a.value, 'paired-send');
    cleanup.push(f.close);
    const writer = await f.pair(grant(a.value.workspaceId!, true)),
      token = writer.pair.accessToken;
    const sid = sessionPageSchema.parse(
      (await f.request('/v1/sessions', undefined, token)).body,
    ).items[0]!.id;
    const key = randomUUID(),
      body = {
        protocolVersion: 1,
        clientMessageId: key,
        text: 'Preparation withdrawal fixture',
      };
    expect(
      (
        await f.request(`/v1/sessions/${sid}/app-commands`, body, token, {
          'Idempotency-Key': key,
        })
      ).status,
    ).toBe(202);
    await until(() => !!release);
    if (loss === 'grant')
      f.devices.reduce(writer.pair.deviceId, grant(a.value.workspaceId!));
    else if (loss === 'revoke') f.devices.revoke(writer.pair.deviceId);
    else
      await f.replaceExternal(
        a.value.conversationId,
        loss === 'source-send' ? { ...a.value, pairedSend: false } : undefined,
      );
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(0);
    // The journal is retained even when authority no longer permits receipt delivery.
    const saved = f.store.db
      .prepare('SELECT data FROM external_commands WHERE id=?')
      .get(key) as { data: string };
    expect(appCommandSchema.parse(JSON.parse(saved.data)).delivery).toBe(
      'not_sent',
    );
    expect([401, 403, 404]).toContain(
      (
        await f.request(`/v1/sessions/${sid}/app-commands`, body, token, {
          'Idempotency-Key': key,
        })
      ).status,
    );
  });

it('retains uncertainty after dispatch and write reduction, isolates actors, resolves without resend only with current consent', async () => {
  const a = source();
  let release!: () => void,
    calls = 0;
  a.value.prepareSend = async () => async () => {
    calls++;
    await new Promise<void>((r) => {
      release = r;
    });
    throw new Error('lost ACK');
  };
  const f = await secureFixture(a.value, 'paired-send');
  cleanup.push(f.close);
  const writer = await f.pair(grant(a.value.workspaceId!, true)),
    other = await f.pair(grant(a.value.workspaceId!, true));
  const token = writer.pair.accessToken;
  const sid = sessionPageSchema.parse(
    (await f.request('/v1/sessions', undefined, token)).body,
  ).items[0]!.id;
  const key = randomUUID(),
    body = {
      protocolVersion: 1,
      clientMessageId: key,
      text: 'Lost ACK fixture',
    },
    route = `/v1/sessions/${sid}/app-commands`,
    headers = { 'Idempotency-Key': key };
  expect((await f.request(route, body, token, headers)).status).toBe(202);
  await until(() => !!release);
  expect(
    (await f.request(route, body, other.pair.accessToken, headers)).status,
  ).toBe(409);
  release();
  await new Promise((r) => setTimeout(r, 30));
  const get = () => f.request(`${route}/${key}`, undefined, token);
  expect(appCommandSchema.parse((await get()).body)).toMatchObject({
    delivery: 'uncertain',
    observedResult: 'not_correlated',
  });
  const resolution = { ...body, decision: 'reviewed_no_resend' };
  expect(
    (
      await f.request(
        `${route}/${key}/resolve`,
        resolution,
        other.pair.accessToken,
      )
    ).status,
  ).toBe(409);
  await f.replaceExternal(a.value.conversationId, {
    ...a.value,
    pairedSend: false,
  });
  expect((await get()).status).toBe(200);
  expect(
    (await f.request(`${route}/${key}/resolve`, resolution, token)).status,
  ).toBe(403);
  await f.replaceExternal(a.value.conversationId, a.value);
  expect(
    (await f.request(`${route}/${key}/resolve`, resolution, token)).status,
  ).toBe(200);
  expect(appCommandSchema.parse((await get()).body)).toMatchObject({
    delivery: 'uncertain',
    observedResult: 'not_correlated',
    reason: 'explicit_resolution',
  });
  expect((await f.request(route, body, token, headers)).status).toBe(202);
  f.devices.reduce(writer.pair.deviceId, grant(a.value.workspaceId!));
  expect(
    (await f.request(`${route}/${key}/resolve`, resolution, token)).status,
  ).toBe(404);
  expect((await get()).status).toBe(200);
  expect(calls).toBe(1);
  f.devices.revoke(writer.pair.deviceId);
  expect((await get()).status).toBe(401);
});

for (const loss of ['grant', 'revoke'] as const)
  it(`does not falsely cancel or resend upstream work when ${loss} is lost after dispatch`, async () => {
    const a = source();
    let release!: () => void,
      calls = 0;
    a.value.prepareSend = async () => async () => {
      calls++;
      await new Promise<void>((r) => {
        release = r;
      });
      throw new Error('ACK unavailable');
    };
    const f = await secureFixture(a.value, 'paired-send');
    cleanup.push(f.close);
    const writer = await f.pair(grant(a.value.workspaceId!, true)),
      token = writer.pair.accessToken;
    const sid = sessionPageSchema.parse(
      (await f.request('/v1/sessions', undefined, token)).body,
    ).items[0]!.id;
    const key = randomUUID(),
      body = {
        protocolVersion: 1,
        clientMessageId: key,
        text: 'Already dispatched',
      },
      route = `/v1/sessions/${sid}/app-commands`;
    expect(
      (await f.request(route, body, token, { 'Idempotency-Key': key })).status,
    ).toBe(202);
    await until(() => !!release);
    if (loss === 'grant')
      f.devices.reduce(writer.pair.deviceId, grant(a.value.workspaceId!));
    else f.devices.revoke(writer.pair.deviceId);
    release();
    await new Promise((r) => setTimeout(r, 30));
    const saved = f.store.db
      .prepare('SELECT data FROM external_commands WHERE id=?')
      .get(key) as { data: string };
    expect(appCommandSchema.parse(JSON.parse(saved.data))).toMatchObject({
      delivery: 'uncertain',
      observedResult: 'not_correlated',
    });
    expect([401, 404]).toContain(
      (await f.request(route, body, token, { 'Idempotency-Key': key })).status,
    );
    expect(calls).toBe(1);
  });
