import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../services/gateway/src/db/store.js';
import {
  APP_WORKSPACE,
  AppProjection,
} from '../services/gateway/src/experimental/app-projection.js';
import {
  normalizeAppSteps,
  type AppObservation,
} from '../services/gateway/src/experimental/app-observation.js';
import { applyEvent } from '../apps/mobile/src/services/reducer.js';
import { secureFixture } from './secure-helpers.js';

function observation(): AppObservation {
  return {
    conversationId: randomUUID(),
    trajectoryId: randomUUID(),
    steps: [
      {
        index: 0,
        executionId: randomUUID(),
        role: 'user',
        text: 'Disposable fixture',
        done: true,
      },
      {
        index: 1,
        executionId: randomUUID(),
        role: 'assistant',
        text: 'POCKET-APP-20261107-READY',
        done: true,
      },
    ],
  };
}
describe('experimental read-only App projection', () => {
  it('commits stable identity and Pocket replay separately, never creating or restarting a Mock run', async () => {
    const store = new Store(':memory:');
    const data = observation();
    const projection = new AppProjection(store, {
      conversationId: data.conversationId,
      read: async () => data,
    });
    try {
      await projection.start();
      const sid = store.list('', 30, [APP_WORKSPACE]).items[0]!.id;
      const before = store.snapshot(sid);
      expect(before.session.external?.conversationId).toBe(data.conversationId);
      expect(before.through).not.toBe(data.steps.length - 1);
      expect(before.runs).toEqual([]);
      await projection.refresh();
      expect(store.snapshot(sid)).toEqual(before);
      data.steps.push({
        index: 2,
        executionId: randomUUID(),
        role: 'user',
        text: 'Desktop follow-up',
        done: true,
      });
      await projection.refresh();
      const after = store.snapshot(sid);
      expect(
        store
          .events(sid, before.through, after.through)
          .reduce(applyEvent, before),
      ).toEqual(after);
      expect(after.messages[0]!.id).toBe(before.messages[0]!.id);
      store.recover();
      expect(store.snapshot(sid).runs).toEqual([]);
      expect(() =>
        store.prompt(sid, {
          protocolVersion: 1,
          clientMessageId: randomUUID(),
          text: 'blocked',
        }),
      ).toThrow('read-only');
      data.steps.pop();
      await projection.refresh();
      expect(store.snapshot(sid).session.external?.observation).toBe('gap');
      expect(store.snapshot(sid).messages).toEqual(after.messages);
    } finally {
      await projection.close();
      store.close();
    }
  });
  it('strips internal data and rejects cross-session, unknown steps and offset gaps', () => {
    const cascadeId = randomUUID(),
      trajectoryId = randomUUID();
    const step = {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: {
        executionId: randomUUID(),
        sourceTrajectoryStepInfo: { cascadeId, trajectoryId },
      },
      plannerResponse: { response: 'visible', thinkingSignature: 'PRIVATE' },
      internal: 'PRIVATE',
    };
    expect(JSON.stringify(normalizeAppSteps([step], cascadeId))).not.toContain(
      'PRIVATE',
    );
    for (const plannerResponse of [
      {
        ...step.plannerResponse,
        toolCalls: [{ name: 'private-tool', arguments: 'PRIVATE' }],
      },
      { ...step.plannerResponse, items: [{ image: 'PRIVATE' }] },
    ])
      expect(() =>
        normalizeAppSteps([{ ...step, plannerResponse }], cascadeId),
      ).toThrow('unsupported_step_or_gap');
    expect(() =>
      normalizeAppSteps(
        [
          {
            ...step,
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            userInput: {
              items: [{ text: 'visible' }],
              media: [{ bytes: 'PRIVATE' }],
            },
          },
        ],
        cascadeId,
      ),
    ).toThrow('unsupported_step_or_gap');
    expect(() => normalizeAppSteps([step], randomUUID())).toThrow(
      'upstream_identity_or_gap',
    );
    expect(() =>
      normalizeAppSteps([{ ...step, type: 'UNKNOWN' }], cascadeId),
    ).toThrow('unsupported_step_or_gap');
    expect(() => normalizeAppSteps([step, step], cascadeId)).toThrow(
      'upstream_identity_or_gap',
    );
  });
  it('enforces grants for history/replay/live and closes on revocation without upstream control', async () => {
    const data = observation();
    const f = await secureFixture({
      conversationId: data.conversationId,
      read: async () => data,
    });
    try {
      const sid = f.store.list('', 30, [APP_WORKSPACE]).items[0]!.id;
      const allowed = await f.pair([
        { workspaceId: APP_WORKSPACE, scopes: ['session:read'] },
      ]);
      const other = await f.pair();
      expect(
        (
          await f.request(
            `/v1/sessions/${sid}/snapshot`,
            undefined,
            other.pair.accessToken,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await f.request(
            `/v1/sessions/${sid}/snapshot`,
            undefined,
            allowed.pair.accessToken,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await f.request(
            `/v1/sessions/${sid}/messages`,
            {
              protocolVersion: 1,
              clientMessageId: randomUUID(),
              text: 'no send',
            },
            allowed.pair.accessToken,
          )
        ).status,
      ).toBe(404);
      const socket = await f.socket(allowed.pair.accessToken);
      socket.subscribe(`session:${sid}`);
      await new Promise((r) => setTimeout(r, 100));
      expect(JSON.stringify(socket.frames)).toContain(
        'POCKET-APP-20261107-READY',
      );
      const closed = new Promise<number>((resolve) =>
        socket.ws.once('close', resolve),
      );
      f.devices.revoke(allowed.pair.deviceId);
      expect(await closed).toBe(4004);
      expect(
        (
          await f.request(
            `/v1/sessions/${sid}/events?after=0`,
            undefined,
            allowed.pair.accessToken,
          )
        ).status,
      ).toBe(401);
      expect(f.store.snapshot(sid).runs).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
