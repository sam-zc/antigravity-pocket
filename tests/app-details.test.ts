import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { commandDetail } from '../services/gateway/src/experimental/app-command-detail.js';
import { budgetActivityDetails } from '../services/gateway/src/experimental/app-detail-budget.js';
import { encodeVarint as v } from '../services/gateway/src/experimental/app-wire.js';
import {
  appActivityDetailSchema,
  snapshotSchema,
  type AppActivity,
} from '@pocket/protocol';
import { fixture, until } from './helpers.js';
const b = (key: number, value: string | Buffer) => {
  const data = Buffer.from(value);
  return Buffer.concat([v(key * 8 + 2), v(data.length), data]);
};
const n = (key: number, value: number) => Buffer.concat([v(key * 8), v(value)]);
const wire = (output: string, exit?: number) =>
  Buffer.concat([
    b(23, 'echo fixture'),
    b(21, b(1, output)),
    ...(exit === undefined ? [] : [n(6, exit)]),
  ]);
const activity = (output: string): AppActivity => ({
  schemaVersion: 'app-2.29.0',
  kind: 'tool',
  label: 'Run command',
  upstreamType: 21,
  state: 'done',
  detailsOmitted: true,
  detail: commandDetail(wire(output)),
});
it('admits only observed command/output/explicit exit fields, never infers absent zero or uses proposed/debug/internal fields', () => {
  expect(commandDetail(wire('visible', 0))).toMatchObject({
    output: 'visible',
    exitCode: 0,
    clipped: false,
  });
  expect(commandDetail(wire('visible')).exitCode).toBeUndefined();
  const hidden = Buffer.concat([
    b(25, 'HIDDEN_PROPOSAL'),
    b(24, 'PRIVATE_DEBUG'),
    b(21, b(2, 'UNVERIFIED_TRUNCATED_FIELD')),
  ]);
  expect(commandDetail(hidden)).toEqual({
    kind: 'command',
    source: 'app-2.29.0/runCommand',
    clipped: false,
  });
  const negative = Buffer.concat([
    v(48),
    Buffer.from([255, 255, 255, 255, 255, 255, 255, 255, 255, 1]),
  ]);
  expect(commandDetail(negative).exitCode).toBe(-1);
  expect(() => commandDetail(n(6, 2147483648))).toThrow('malformed_wire');
  expect(() =>
    commandDetail(Buffer.concat([wire('ok'), n(6, 0), n(6, 1)])),
  ).toThrow('ambiguous_wire');
  expect(
    appActivityDetailSchema.safeParse({
      ...commandDetail(wire('visible')),
      url: 'https://example.com',
    }).success,
  ).toBe(false);
});
it('checks all admitted bytes before clipping, bounds input/lines/UTF-8, rejects unsafe controls and credentials', () => {
  expect(commandDetail(wire('😀'.repeat(400)))).toMatchObject({
    clipped: true,
    output: '😀'.repeat(256),
  });
  const lines = commandDetail(wire('line\n'.repeat(60)));
  expect(lines.output!.split('\n')).toHaveLength(48);
  expect(lines.clipped).toBe(true);
  expect(() =>
    commandDetail(wire('x'.repeat(2000) + ' password=hidden')),
  ).toThrow('unsafe_content');
  expect(() => commandDetail(wire('https://user:secret@example.com'))).toThrow(
    'unsafe_content',
  );
  expect(() =>
    commandDetail(wire('\u001b[31munsafe terminal control')),
  ).toThrow('unsafe_content');
  expect(() => commandDetail(wire('x'.repeat(65537)))).toThrow('content_limit');
  expect(() => commandDetail(b(21, Buffer.from([10, 200])))).toThrow(
    'malformed_wire',
  );
  expect(
    commandDetail(wire('<img src="https://example.com/x"> ../../path')),
  ).toMatchObject({ output: '<img src="https://example.com/x"> ../../path' });
});
it('omits details explicitly under aggregate and persistence budgets without dropping rows or identity', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: String(i),
    activity: activity('x'.repeat(1024)),
  }));
  const result = budgetActivityDetails(rows);
  expect(result.map((row) => row.id)).toEqual(rows.map((row) => row.id));
  expect(
    result.some((row) => row.activity?.detailOmission === 'window_budget'),
  ).toBe(true);
  expect(
    result.reduce(
      (sum, row) =>
        sum +
        (row.activity?.detail
          ? Buffer.byteLength(JSON.stringify(row.activity.detail))
          : 0),
      0,
    ),
  ).toBeLessThanOrEqual(4096);
});
it('persists bounded mixed details and incremental revisions over HTTP/WS, replay and source withdrawal without a detail RPC', async () => {
  const f = await fixture();
  const conversationId = randomUUID(),
    trajectoryId = randomUUID(),
    workspaceId = randomUUID();
  const ids = Array.from({ length: 20 }, () => randomUUID());
  let output = 'First observed output';
  const read = async () => ({
    conversationId,
    trajectoryId,
    view: 'coding' as const,
    laterHistory: 'unobserved' as const,
    steps: ids.map((executionId, index) =>
      index === 0
        ? {
            index,
            executionId,
            role: 'user' as const,
            text: 'Fixture prompt',
            done: true,
            appStepType: 14,
          }
        : {
            index,
            executionId,
            role: 'activity' as const,
            text: '',
            done: true,
            appStepType: 21,
            activity: activity(output),
          },
    ),
  });
  try {
    await f.replaceExternal(conversationId, {
      conversationId,
      workspaceId,
      readMode: 'coding',
      read,
    });
    const sid = f.store.list('', 30, [workspaceId]).items[0]!.id;
    const before = snapshotSchema.parse(
      await (await f.request(`/v1/sessions/${sid}/snapshot`)).json(),
    );
    const socket = await f.socket();
    socket.subscribe(sid, before.through);
    await until(() =>
      socket.frames.some((e) => e.type === 'subscription.ready'),
    );
    output = 'Updated observed output';
    await until(
      () =>
        f.store.snapshot(sid).messages[1]!.activity?.detail?.output === output,
      5000,
    );
    const after = f.store.snapshot(sid);
    expect(after.messages[1]!.id).toBe(before.messages[1]!.id);
    expect(after.messages[1]!.revision).toBe(before.messages[1]!.revision + 1);
    expect(after.messages[0]!.text).toBe('Fixture prompt');
    expect(after.session.external?.readOnly).toBe(true);
    await until(() =>
      socket.frames.some((e) => e.type === 'external.snapshot'),
    );
    const replay = await f.socket();
    replay.subscribe(sid, before.through);
    await until(() =>
      replay.frames.some((e) => e.type === 'external.snapshot'),
    );
    output = 'x'.repeat(1024);
    await until(
      () =>
        f.store
          .snapshot(sid)
          .messages.some((m) => m.activity?.detailOmission === 'window_budget'),
      5000,
    );
    const limited = f.store.snapshot(sid);
    expect(
      Buffer.byteLength(JSON.stringify(limited.messages)),
    ).toBeLessThanOrEqual(24000);
    await new Promise((resolve) => setTimeout(resolve, 3200));
    expect(f.store.snapshot(sid).through).toBe(limited.through); // no revision churn for budget-omitted fields
    await f.replaceExternal(conversationId);
    expect((await f.request(`/v1/sessions/${sid}/snapshot`)).status).toBe(404);
    await until(() => socket.ws.readyState === 3);
  } finally {
    await f.close();
  }
}, 15000);
