import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../services/gateway/src/db/store.js';
import {
  enrollmentSchema,
  persistEnrollment,
  readEnrollmentFile,
  type Enrollment,
} from '../services/gateway/src/experimental/app-enrollment.js';
import type { AppObservation } from '../services/gateway/src/experimental/app-observation.js';
import { applyEvent } from '../apps/mobile/src/services/reducer.js';
import { secureFixture } from './secure-helpers.js';
import { appOrdinaryTextSchema, snapshotSchema } from '@pocket/protocol';

function enrollment(): Enrollment {
  const conversationId = randomUUID(),
    projectId = randomUUID();
  return {
    workspaceId: randomUUID(),
    projectId,
    conversationId,
    trajectoryId: randomUUID(),
    title: 'Disposable A',
    marker: 'POCKET-A-READY',
    disposable: true,
    observedAppUrl: `http://127.0.0.1:12345/c/${conversationId}?project=${projectId}`,
  };
}
describe('owner enrollment and bounded windows', () => {
  it('defaults read-only, requires private regular owner files, rejects arbitrary fields and mismatched project URL', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pocket-enroll-'))),
      path = join(dir, 'enroll.json');
    const source = enrollment();
    try {
      writeFileSync(path, JSON.stringify({ version: 1, sources: [source] }), {
        mode: 0o600,
      });
      expect(
        (await readEnrollmentFile(path)).sources[0]!.sendMode,
      ).toBeUndefined();
      chmodSync(path, 0o644);
      await expect(readEnrollmentFile(path)).rejects.toThrow(
        'invalid_enrollment_file',
      );
      chmodSync(path, 0o600);
      symlinkSync(path, join(dir, 'link'));
      await expect(readEnrollmentFile(join(dir, 'link'))).rejects.toThrow(
        'invalid_enrollment_file',
      );
      expect(
        enrollmentSchema.safeParse({
          version: 1,
          sources: [{ ...source, endpoint: 'https://evil' }],
        }).success,
      ).toBe(false);
      const store = new Store(':memory:');
      try {
        expect(() =>
          persistEnrollment(store, { ...source, projectId: randomUUID() }),
        ).toThrow('enrollment_identity_rejected');
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('persists immutable per-conversation grant/trajectory pins across restart and permits separate send opt-in only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pocket-enroll-db-')),
      path = join(dir, 'db.sqlite'),
      a = enrollment(),
      b = enrollment();
    let store = new Store(path);
    try {
      persistEnrollment(store, a);
      persistEnrollment(store, b);
      store.close();
      store = new Store(path);
      persistEnrollment(store, { ...a, sendMode: 'ordinary-text' });
      expect(() =>
        persistEnrollment(store, { ...a, trajectoryId: randomUUID() }),
      ).toThrow('enrollment_identity_changed');
      expect(() =>
        persistEnrollment(store, { ...a, workspaceId: b.workspaceId }),
      ).toThrow('enrollment_identity_changed');
      expect(() =>
        persistEnrollment(store, {
          ...enrollment(),
          workspaceId: a.workspaceId,
        }),
      ).toThrow('enrollment_conflict_or_limit');
      expect(
        store.db
          .prepare(
            "SELECT value FROM metadata WHERE key LIKE 'app-enrollment:%'",
          )
          .all(),
      ).toHaveLength(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('continues overlapping windows past twenty with stable retained IDs, explicit boundaries, replay and restart; refuses gaps and oversize', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pocket-window-')),
      path = join(dir, 'db.sqlite');
    let store = new Store(path);
    const source = enrollment();
    const all = Array.from({ length: 28 }, (_, index) => ({
      index,
      executionId: randomUUID(),
      role: 'user' as const,
      text: `visible ${index}`,
      done: true,
    }));
    const observation = (start: number, end: number): AppObservation => ({
      conversationId: source.conversationId,
      trajectoryId: source.trajectoryId,
      steps: all.slice(start, end),
    });
    try {
      const sid = store.projectExternal(
        source.workspaceId,
        observation(0, 18),
        'ordinary-text',
        source,
      );
      const before = store.snapshot(sid);
      store.projectExternal(
        source.workspaceId,
        observation(14, 24),
        'ordinary-text',
        source,
      );
      const after = store.snapshot(sid);
      expect(
        snapshotSchema.safeParse({
          ...after,
          messages: after.messages.slice(1),
        }).success,
      ).toBe(false);
      expect(
        snapshotSchema.safeParse({
          ...after,
          session: {
            ...after.session,
            external: { ...after.session.external, windowEnd: 2001 },
          },
        }).success,
      ).toBe(false);
      expect(after.messages).toHaveLength(20);
      expect(after.session.external).toMatchObject({
        windowStart: 4,
        windowEnd: 24,
        historyComplete: false,
        turnState: 'unknown',
      });
      expect(after.messages[0]!.id).toBe(before.messages[4]!.id);
      expect(
        store
          .events(sid, before.through, after.through)
          .reduce(applyEvent, before),
      ).toEqual(after);
      expect(store.history(sid, undefined, 5).nextBefore).toBe(20);
      store.close();
      store = new Store(path);
      store.projectExternal(
        source.workspaceId,
        observation(20, 28),
        'ordinary-text',
        source,
      );
      expect(store.snapshot(sid).messages[0]!.id).toBe(after.messages[4]!.id);
      const stable = store.snapshot(sid);
      expect(() =>
        store.projectExternal(
          source.workspaceId,
          observation(0, 2),
          'ordinary-text',
          source,
        ),
      ).toThrow('overlap');
      const changed = observation(24, 28);
      changed.steps = changed.steps.map((s) => ({
        ...s,
        text: 'x'.repeat(8192),
      }));
      expect(() =>
        store.projectExternal(
          source.workspaceId,
          changed,
          'ordinary-text',
          source,
        ),
      ).toThrow('byte budget');
      expect(store.snapshot(sid)).toEqual(stable);
      expect(store.snapshot(sid).runs).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('keeps ordinary-text schemas bounded without granting attachment or command privileges', () => {
    expect(appOrdinaryTextSchema.safeParse('Please say hello.').success).toBe(
      true,
    );
    for (const text of ['', '  ', '🙂'.repeat(513), 'abc\u0000'])
      expect(appOrdinaryTextSchema.safeParse(text).success).toBe(false);
  });
  it('authorizes two sources separately over HTTPS; rejects cross-source receipts, arbitrary IDs, read-only sends and App cancel', async () => {
    const a = enrollment(),
      b = enrollment();
    let calls = 0;
    const sources = [a, b].map((s) => ({
      ...s,
      read: async () => ({
        conversationId: s.conversationId,
        trajectoryId: s.trajectoryId,
        steps: [
          {
            index: 0,
            executionId: s.trajectoryId,
            role: 'assistant' as const,
            text: s.marker!,
            done: true,
          },
        ],
      }),
      ...(s === a
        ? {
            sendMode: 'ordinary-text' as const,
            prepareSend: async () => async () => {
              calls++;
              return {};
            },
          }
        : {}),
    }));
    const f = await secureFixture(sources);
    try {
      const sessions = f.store.list('', 30, [
        a.workspaceId,
        b.workspaceId,
      ]).items;
      const sa = sessions.find((s) => s.workspaceId === a.workspaceId)!.id,
        sb = sessions.find((s) => s.workspaceId === b.workspaceId)!.id;
      const device = await f.pair([
        {
          workspaceId: a.workspaceId,
          scopes: ['session:read', 'session:write'],
        },
      ]);
      const token = device.pair.accessToken;
      const eventA = f.store.events(sa, 0, f.store.watermark(sa).high).at(-1)!;
      expect(() => applyEvent(f.store.snapshot(sb), eventA)).toThrow(
        'Wrong stream',
      );
      expect(
        (await f.request(`/v1/sessions/${sb}/snapshot`, undefined, token))
          .status,
      ).toBe(404);
      const key = randomUUID(),
        body = {
          protocolVersion: 1,
          clientMessageId: key,
          text: 'Please answer hello, using text only.',
        };
      expect(
        (
          await f.request(`/v1/sessions/${sa}/app-commands`, body, token, {
            'Idempotency-Key': key,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await f.request(`/v1/sessions/${sa}/app-commands`, body, token, {
            'Idempotency-Key': key,
          })
        ).status,
      ).toBe(403);
      expect(calls).toBe(0);
      const both = await f.pair([
        {
          workspaceId: a.workspaceId,
          scopes: ['session:read', 'session:write'],
        },
        {
          workspaceId: b.workspaceId,
          scopes: ['session:read', 'session:write'],
        },
      ]);
      expect(
        (
          await f.request(
            `/v1/sessions/${sb}/app-commands/${key}`,
            undefined,
            both.pair.accessToken,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await f.request(
            `/v1/sessions/${sb}/app-commands`,
            body,
            both.pair.accessToken,
            { 'Idempotency-Key': key },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await f.request(
            `/v1/sessions/${a.conversationId}/snapshot`,
            undefined,
            token,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await f.request(
            `/v1/runs/${a.trajectoryId}/cancel`,
            { protocolVersion: 1 },
            token,
          )
        ).status,
      ).toBe(404);
      f.devices.revoke(device.pair.deviceId);
      expect(
        (
          await f.request(
            `/v1/sessions/${sa}/app-commands/${key}`,
            undefined,
            token,
          )
        ).status,
      ).toBe(401);
      expect(calls).toBe(0);
    } finally {
      await f.close();
    }
  });
});
