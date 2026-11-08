import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { fixture, until } from './helpers.js';
import { Store } from '../services/gateway/src/db/store.js';
import { buildApp } from '../services/gateway/src/app.js';
import { AppOwner } from '../services/gateway/src/experimental/app-owner.js';
import { parseAppArgs } from '../services/gateway/src/experimental/app-cli.js';
import { normalizeAppSteps } from '../services/gateway/src/experimental/app-observation.js';
import type { AppSource } from '../services/gateway/src/experimental/app-projection.js';
import type { Enrollment } from '../services/gateway/src/experimental/app-enrollment.js';

const setup = {
  action: 'app-setup',
  version: '2.29.0',
  pid: 123,
  port: 12345,
  ca: '/public.pem',
  pin: 'a'.repeat(64),
};
const tick = () => new Promise((r) => setTimeout(r, 20));
describe('owner-managed local App lifecycle', () => {
  it('keeps pilot enrollment private until separate opt-in, strips local send preparation and validates exact read grants', async () => {
    const store = new Store(':memory:');
    const conversationId = randomUUID(),
      projectId = randomUUID(),
      trajectoryId = randomUUID();
    const observation = {
      conversationId,
      trajectoryId,
      steps: [
        {
          index: 0,
          executionId: trajectoryId,
          role: 'assistant' as const,
          text: 'Synthetic pilot',
          done: true,
        },
      ],
    };
    const active: AppSource[] = [];
    let prepared = 0;
    const dependencies = {
      verify: async () => {},
      read: async () => observation,
      sources: async (
        _store: Store,
        _env: NodeJS.ProcessEnv,
        records: Enrollment[],
      ) => {
        prepared++;
        return records.map((r) => ({ ...r, read: async () => observation }));
      },
    };
    const owner = new AppOwner(
      store,
      async (_id, value) => {
        active.splice(0);
        if (value) active.push(value);
      },
      dependencies,
      'paired-read-only',
    );
    try {
      await owner.execute(setup);
      await owner.execute({
        action: 'app-enroll',
        url: `http://127.0.0.1:12345/c/${conversationId}?project=${projectId}`,
        title: 'Pilot fixture',
      });
      const record = owner.status().sources[0]!;
      expect(active).toHaveLength(0);
      expect(prepared).toBe(0);
      const grants = [
        { workspaceId: record.workspaceId, scopes: ['session:read' as const] },
      ];
      expect(() => owner.validatePilotGrants(grants)).toThrow(
        'pilot_read_only_grant_required',
      );
      // Simulate persisted state from an earlier owner-authorized local mode.
      const saved = store.db
        .prepare('SELECT value FROM metadata WHERE key=?')
        .get(`app-owner-source:${conversationId}`) as { value: string };
      const prior = JSON.parse(saved.value) as {
        enabled: boolean;
        source: Enrollment;
      };
      prior.source.sendMode = 'ordinary-text';
      store.db
        .prepare('UPDATE metadata SET value=? WHERE key=?')
        .run(JSON.stringify(prior), `app-owner-source:${conversationId}`);
      await owner.execute(
        parseAppArgs(['pilot', '--conversation', conversationId, '--on']),
      );
      expect(active).toHaveLength(1);
      expect(active[0]!.sendMode).toBeUndefined();
      expect(owner.status().sources[0]).toMatchObject({
        localSendOptIn: true,
        readOnly: true,
      });
      expect(() => owner.validatePilotGrants(grants)).not.toThrow();
      expect(() =>
        owner.validatePilotGrants([
          {
            workspaceId: record.workspaceId,
            scopes: ['session:read', 'session:write'],
          },
        ]),
      ).toThrow();
      await expect(
        owner.execute({
          action: 'app-send',
          conversation: conversationId,
          enabled: true,
        }),
      ).rejects.toThrow('pilot_read_only');
      const restored = new AppOwner(
        store,
        async (_id, value) => {
          active.splice(0);
          if (value) active.push(value);
        },
        dependencies,
        'paired-read-only',
      );
      await restored.restore();
      expect(active).toHaveLength(1);
      await restored.execute(
        parseAppArgs(['pilot', '--conversation', conversationId, '--off']),
      );
      expect(active).toHaveLength(0);
      expect(restored.status().sources[0]!.pilotShared).toBe(false);
      await restored.execute({
        action: 'app-disable',
        conversation: conversationId,
      });
      await restored.execute({
        action: 'app-enable',
        conversation: conversationId,
      });
      expect(active).toHaveLength(0);
      expect(restored.status().sources[0]!.readOnly).toBe(true);
    } finally {
      store.close();
    }
  });
  it('requires separate paired source consent and exact new write confirmation without changing existing grants', async () => {
    const store = new Store(':memory:');
    const conversationId = randomUUID(),
      projectId = randomUUID(),
      trajectoryId = randomUUID();
    const observation = { conversationId, trajectoryId, steps: [] };
    const active: AppSource[] = [];
    const owner = new AppOwner(
      store,
      async (_id, value) => {
        active.splice(0);
        if (value) active.push(value);
      },
      {
        verify: async () => {},
        read: async () => observation,
        sources: async (
          _store: Store,
          _env: NodeJS.ProcessEnv,
          records: Enrollment[],
        ) => records.map((r) => ({ ...r, read: async () => observation })),
      },
      'paired-send',
    );
    try {
      await owner.execute(setup);
      await owner.execute({
        action: 'app-enroll',
        url: `http://127.0.0.1:12345/c/${conversationId}?project=${projectId}`,
        title: 'Disposable ordinary',
      });
      expect(active).toHaveLength(0);
      const workspaceId = owner.status().sources[0]!.workspaceId;
      const writes = [
        {
          workspaceId,
          scopes: ['session:read' as const, 'session:write' as const],
        },
      ];
      const opt = (on: boolean) =>
        owner.execute(
          parseAppArgs([
            'paired-send',
            '--conversation',
            conversationId,
            on ? '--on' : '--off',
          ]),
        );
      await expect(opt(true)).rejects.toThrow('pilot_sharing_required');
      await owner.execute(
        parseAppArgs(['pilot', '--conversation', conversationId, '--on']),
      );
      expect(active[0]!.sendMode).toBeUndefined();
      expect(() => owner.validatePilotGrants(writes)).toThrow();
      await opt(true);
      expect(active[0]!.sendMode).toBe('ordinary-text');
      expect(() => owner.validatePilotGrants(writes)).not.toThrow();
      expect(() =>
        owner.validatePilotGrants([{ workspaceId, scopes: ['session:write'] }]),
      ).toThrow();
      expect(owner.status().sources[0]).toMatchObject({
        pairedSendOptIn: true,
        localSendOptIn: false,
      });
      await owner.execute(
        parseAppArgs(['pilot', '--conversation', conversationId, '--off']),
      );
      await owner.execute(
        parseAppArgs(['pilot', '--conversation', conversationId, '--on']),
      );
      expect(active[0]!.sendMode).toBeUndefined();
      expect(() => owner.validatePilotGrants(writes)).toThrow();
      await opt(true);
      await owner.execute({
        action: 'app-disable',
        conversation: conversationId,
      });
      await owner.execute({
        action: 'app-enable',
        conversation: conversationId,
      });
      expect(active).toHaveLength(0);
      expect(owner.status().sources[0]!.pairedSendOptIn).toBe(false);
    } finally {
      store.close();
    }
  });
  it('persists paired send-off before awaited retirement so interrupted withdrawal cannot restore writer consent', async () => {
    const store = new Store(':memory:');
    const conversationId = randomUUID(),
      projectId = randomUUID(),
      trajectoryId = randomUUID();
    const observation = { conversationId, trajectoryId, steps: [] };
    let hold = false,
      entered = false;
    let release: (() => void) | undefined;
    let withdrawal: Promise<unknown> | undefined;
    const active: AppSource[] = [];
    const dependencies = {
      verify: async () => {},
      read: async () => observation,
      sources: async (
        _store: Store,
        _env: NodeJS.ProcessEnv,
        records: Enrollment[],
      ) => records.map((r) => ({ ...r, read: async () => observation })),
    };
    const owner = new AppOwner(
      store,
      async (_id, value) => {
        active.splice(0);
        if (value) active.push(value);
        if (hold) {
          hold = false;
          entered = true;
          await new Promise<void>((r) => {
            release = r;
          });
        }
      },
      dependencies,
      'paired-send',
    );
    try {
      await owner.execute(setup);
      await owner.execute({
        action: 'app-enroll',
        url: `http://127.0.0.1:12345/c/${conversationId}?project=${projectId}`,
        title: 'Synthetic interrupted withdrawal',
      });
      await owner.execute({
        action: 'app-pilot',
        conversation: conversationId,
        enabled: true,
      });
      await owner.execute({
        action: 'app-paired-send',
        conversation: conversationId,
        enabled: true,
      });
      expect(active[0]!.sendMode).toBe('ordinary-text');
      hold = true;
      withdrawal = owner.execute({
        action: 'app-paired-send',
        conversation: conversationId,
        enabled: false,
      });
      await until(() => entered);
      expect(active).toHaveLength(0);
      // Read only the persisted owner state through a fresh owner instance, as restart does.
      const recovered: AppSource[] = [];
      const restarted = new AppOwner(
        store,
        async (_id, value) => {
          if (value) recovered.push(value);
        },
        dependencies,
        'paired-send',
      );
      await restarted.restore();
      expect(restarted.status().sources[0]!.pairedSendOptIn).toBe(false);
      expect(recovered.every((source) => !source.sendMode)).toBe(true);
    } finally {
      release?.();
      await withdrawal;
      store.close();
    }
  });
  it('withdraws only affected live subscriptions and keeps Mock transport and prior SQLite projections intact', async () => {
    const f = await fixture();
    const conversationId = randomUUID(),
      workspaceId = randomUUID(),
      trajectoryId = randomUUID();
    const source: AppSource = {
      conversationId,
      workspaceId,
      read: async () => ({
        conversationId,
        trajectoryId,
        steps: [
          {
            index: 0,
            executionId: trajectoryId,
            role: 'assistant',
            text: 'Safe visible answer',
            done: true,
          },
        ],
      }),
    };
    try {
      await f.replaceExternal(conversationId, source);
      const sid = f.store.list('', 30, [workspaceId]).items[0]!.id;
      const mock = await f.create();
      const viewer = await f.socket(),
        unaffected = await f.socket();
      viewer.subscribe(sid, 0);
      unaffected.subscribe(mock.receipt.sessionId, 0);
      await until(
        () =>
          viewer.frames.some((e) => e.type === 'subscription.ready') &&
          unaffected.frames.some((e) => e.type === 'subscription.ready'),
      );
      const saved = f.store.snapshot(sid);
      await f.replaceExternal(conversationId);
      await until(() => viewer.ws.readyState === WebSocket.CLOSED);
      expect(unaffected.ws.readyState).toBe(WebSocket.OPEN);
      expect((await f.request(`/v1/sessions/${sid}/snapshot`)).status).toBe(
        404,
      );
      expect(f.store.snapshot(sid)).toEqual(saved);
      await f.replaceExternal(conversationId, source);
      const back = await f.socket();
      back.subscribe(sid, saved.through);
      await until(() =>
        back.frames.some((e) => e.type === 'subscription.ready'),
      );
      expect((await f.request(`/v1/sessions/${sid}/snapshot`)).status).toBe(
        200,
      );
      expect(f.store.snapshot(sid).messages[0]!.id).toBe(saved.messages[0]!.id);
    } finally {
      await f.close();
    }
  });
  it('parses usable flags strictly and requires a separate explicit send choice', () => {
    expect(parseAppArgs(['status'])).toEqual({ action: 'app-status' });
    expect(
      parseAppArgs(['enroll', '--url', 'url', '--title', 'A']),
    ).toMatchObject({ offset: 0, disposable: false });
    for (const args of [
      ['send'],
      ['send', '--on', '--off'],
      ['status', '--on'],
      ['enroll', '--offset', '1.5'],
      ['setup', '--token', 'secret'],
    ])
      expect(() => parseAppArgs(args)).toThrow();
  });
  it('attaches an explicitly indexed suffix, preserves pins/IDs, opts in separately, withdraws prepared sends, disables HTTP and re-enables read-only', async () => {
    const store = new Store(':memory:');
    const f = await buildApp({ store });
    const conversationId = randomUUID(),
      projectId = randomUUID(),
      trajectoryId = randomUUID(),
      executionId = randomUUID();
    let calls = 0,
      release: (() => void) | undefined;
    const observation = {
      conversationId,
      trajectoryId,
      steps: [
        {
          index: 28,
          executionId,
          role: 'assistant' as const,
          text: 'Visible answer',
          done: true,
        },
      ],
    };
    const dependencies = {
      verify: async () => {},
      read: async () => observation,
      sources: async (
        _store: Store,
        _env: NodeJS.ProcessEnv,
        sources: Enrollment[],
      ): Promise<AppSource[]> =>
        sources.map((source) => ({
          ...source,
          read: async () => observation,
          ...(source.sendMode
            ? {
                prepareSend: async () => {
                  await new Promise<void>((r) => {
                    release = r;
                  });
                  return async () => {
                    calls++;
                    return {};
                  };
                },
              }
            : {}),
        })),
    };
    const owner = new AppOwner(store, f.replaceExternal, dependencies);
    const headers = {
      host: '127.0.0.1',
      authorization: `Bearer ${f.auth.token}`,
    };
    try {
      await owner.execute(setup);
      await owner.execute({
        action: 'app-enroll',
        url: `http://127.0.0.1:12345/c/${conversationId}?project=${projectId}`,
        title: 'Selected App',
        offset: 28,
      });
      const record = owner.status().sources[0]!;
      expect(record.readOnly).toBe(true);
      const sid = store.list('', 30, [record.workspaceId]).items[0]!.id;
      const initial = store.snapshot(sid);
      expect(initial.session.external).toMatchObject({
        windowStart: 28,
        windowEnd: 29,
        historyComplete: false,
      });
      expect(initial.messages[0]!.ordinal).toBe(29);
      await owner.execute({
        action: 'app-send',
        conversation: conversationId,
        enabled: true,
      });
      const key = randomUUID();
      const route = `/v1/sessions/${sid}/app-commands`;
      const response = await f.app.inject({
        method: 'POST',
        url: route,
        headers: { ...headers, 'idempotency-key': key },
        payload: { protocolVersion: 1, clientMessageId: key, text: 'Hello' },
      });
      expect(response.statusCode).toBe(202);
      expect(release).toBeDefined();
      await owner.execute({
        action: 'app-disable',
        conversation: conversationId,
      });
      await owner.execute({
        action: 'app-enable',
        conversation: conversationId,
      });
      release!();
      await tick();
      expect(calls).toBe(0);
      const receipt = store.db
        .prepare('SELECT data FROM external_commands WHERE id=?')
        .get(key) as { data: string };
      expect(JSON.parse(receipt.data).delivery).toBe('not_sent');
      expect(owner.status().sources[0]!.readOnly).toBe(true);
      expect(store.snapshot(sid).messages[0]!.id).toBe(initial.messages[0]!.id);
      await owner.execute({
        action: 'app-disable',
        conversation: conversationId,
      });
      expect(
        (await f.app.inject({ url: `/v1/sessions/${sid}/snapshot`, headers }))
          .statusCode,
      ).toBe(404);
      expect(
        store.db.prepare('SELECT COUNT(*) n FROM external_commands').get(),
      ).toEqual({ n: 1 });
      const restored = new AppOwner(store, f.replaceExternal, dependencies);
      await restored.restore();
      expect(restored.status().sources[0]!.enabled).toBe(false);
      expect(
        (await f.app.inject({ url: `/v1/sessions/${sid}/snapshot`, headers }))
          .statusCode,
      ).toBe(404);
    } finally {
      release?.();
      await f.app.close();
      store.close();
    }
  });
  it('refuses unknown coding steps without exposing payloads or fabricating text/completion', () => {
    for (const type of [
      'CORTEX_STEP_TYPE_RUN_COMMAND',
      'CORTEX_STEP_TYPE_TOOL_CALL',
      'CORTEX_STEP_TYPE_CHECKPOINT',
      'CORTEX_STEP_TYPE_UNKNOWN',
    ]) {
      expect(() =>
        normalizeAppSteps(
          [
            {
              type,
              status: 'CORTEX_STEP_STATUS_DONE',
              privateReasoning: 'PRIVATE',
              tool: { output: 'PRIVATE' },
            },
          ],
          randomUUID(),
        ),
      ).toThrow('unsupported_step_or_gap');
    }
  });
});
