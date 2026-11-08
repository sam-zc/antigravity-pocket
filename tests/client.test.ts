import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import {
  snapshotSchema,
  type DurableEvent,
  type Snapshot,
} from '@pocket/protocol';
import { applyEvent, latestRun } from '../apps/mobile/src/services/reducer';
import { Api } from '../apps/mobile/src/services/api';
import { SessionSync } from '../apps/mobile/src/services/session-sync';
import { fixture, until } from './helpers';
import type { SessionCache } from '../apps/mobile/src/services/cache';
import { secureFixture } from './secure-helpers';
import { ApiError } from '../apps/mobile/src/services/api';
import type { z } from '@pocket/protocol';

// SQLite-backed adapter for the same SessionCache contract; no Expo native runtime in Node.
class TestCache implements SessionCache {
  db = new Database(':memory:');
  constructor() {
    this.db.exec(
      'CREATE TABLE cache(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE seen(seq INTEGER PRIMARY KEY,data TEXT)',
    );
  }
  async load(id: string) {
    const row = this.db.prepare('SELECT data FROM cache WHERE id=?').get(id) as
      { data: string } | undefined;
    return row ? snapshotSchema.parse(JSON.parse(row.data)) : null;
  }
  async remove(id: string) {
    this.db.prepare('DELETE FROM cache WHERE id=?').run(id);
  }
  async replace(s: Snapshot) {
    this.db.transaction(() => {
      this.db
        .prepare('INSERT OR REPLACE INTO cache VALUES(?,?)')
        .run(s.session.id, JSON.stringify(s));
      this.db.exec('DELETE FROM seen');
    })();
  }
  async apply(id: string, event: DurableEvent) {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT data FROM cache WHERE id=?')
        .get(id) as { data: string };
      const prior = this.db
        .prepare('SELECT data FROM seen WHERE seq=?')
        .get(event.sequence) as { data: string } | undefined;
      if (prior && prior.data !== JSON.stringify(event))
        throw new Error('Conflicting duplicate');
      const next = applyEvent(
        snapshotSchema.parse(JSON.parse(row.data)),
        event,
      );
      this.db
        .prepare('INSERT OR REPLACE INTO cache VALUES(?,?)')
        .run(id, JSON.stringify(next));
      this.db
        .prepare('INSERT OR IGNORE INTO seen VALUES(?,?)')
        .run(event.sequence, JSON.stringify(event));
      return next;
    })();
  }
}
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
it('restores a paired App cache only after HTTPS authority and never restores stale send capability; WSS withdrawal clears SQLite', async () => {
  const conversationId = randomUUID(),
    trajectoryId = randomUUID(),
    workspaceId = randomUUID();
  const f = await secureFixture({
    conversationId,
    workspaceId,
    sendMode: 'ordinary-text',
    prepareSend: async () => async () => ({}),
    read: async () => ({
      conversationId,
      trajectoryId,
      steps: [
        {
          index: 0,
          executionId: trajectoryId,
          role: 'assistant',
          text: 'Synthetic paired observation',
          done: true,
        },
      ],
    }),
  });
  const paired = await f.pair([{ workspaceId, scopes: ['session:read'] }]);
  const token = paired.pair.accessToken,
    sid = f.store.list('', 30, [workspaceId]).items[0]!.id;
  // Only the platform HTTP adapter is replaced: actual verified HTTPS and WSS,
  // production Api/SessionSync/reducer semantics, and a real SQLite cache.
  class PairedApi extends Api {
    override async request<T>(
      path: string,
      schema: z.ZodType<T>,
      body?: unknown,
      key?: string,
    ): Promise<T> {
      const result = await f.request(
        path,
        body,
        token,
        key ? { 'Idempotency-Key': key } : {},
      );
      if (result.status >= 400)
        throw new ApiError(result.status, 'fixture_denied', 'Authority denied');
      return schema.parse(result.body);
    }
  }
  const api = new PairedApi(f.profile.origin, '', {
    token: async () => token,
    clear: async () => {},
  });
  api.beforeSync = async () => {
    await api.bootstrap();
  };
  const cache = new TestCache();
  const fresh = await api.snapshot(sid);
  await cache.replace({
    ...fresh,
    session: {
      ...fresh.session,
      external: {
        ...fresh.session.external!,
        readOnly: false,
        send: 'ordinary-text',
      },
    },
  });
  let visible: Snapshot | null = null,
    state = '';
  const observed: Snapshot[] = [];
  const sync = new SessionSync(
    api,
    cache,
    sid,
    (s) => {
      observed.push(s);
      visible = s;
    },
    (s) => {
      state = s;
      if (s === 'auth-required') visible = null;
    },
    (url) =>
      new WebSocket(url, {
        ca: f.tls.ca,
        origin: f.profile.origin,
      }) as unknown as globalThis.WebSocket,
  );
  cleanup = async () => {
    sync.stop();
    await f.close();
    cache.db.close();
  };
  await sync.start();
  await until(() => state === 'live');
  expect(observed.length).toBeGreaterThan(0);
  expect(
    observed.every(
      (s) => s.session.external?.readOnly && !s.session.external.send,
    ),
  ).toBe(true);
  sync.stop();
  await sync.start();
  await until(() => state === 'live');
  expect(visible!.session.id).toBe(sid);
  await f.replaceExternal(conversationId);
  await until(() => state === 'auth-required');
  await until(
    () =>
      (cache.db.prepare('SELECT count(*) n FROM cache').get() as { n: number })
        .n === 0,
  );
  expect(visible).toBeNull();
  const before = observed.length;
  await sync.start();
  expect(observed).toHaveLength(before);
  expect(await cache.load(sid)).toBeNull();
});
it('runs the mobile API and sync owner against actual transport; resumes after disconnect and prune', async () => {
  const f = await fixture({ delay: 5 });
  const cache = new TestCache();
  const api = new Api(f.origin, f.auth.token);
  const receipt = await api.create('Native transport contract', randomUUID());
  let latest: Snapshot | undefined;
  let state = '';
  const sockets: WebSocket[] = [];
  const factory = (url: string) => {
    const socket = new WebSocket(url, { origin: f.origin });
    sockets.push(socket);
    return socket as unknown as globalThis.WebSocket;
  };
  const sync = new SessionSync(
    api,
    cache,
    receipt.sessionId,
    (s) => {
      latest = s;
    },
    (s) => {
      state = s;
    },
    factory,
  );
  cleanup = async () => {
    sync.stop();
    await f.close();
    cache.db.close();
  };
  await sync.start();
  await until(() => state === 'live');
  const sent = await api.prompt(
    receipt.sessionId,
    'Real transport recovery',
    randomUUID(),
  );
  await until(
    () =>
      !!latest?.messages.find(
        (m) => m.role === 'assistant' && m.text.length > 0,
      ),
  );
  sockets.at(-1)!.terminate();
  await until(() => f.store.run(sent.runId!).state === 'completed');
  await until(
    () => latest?.runs.find((r) => r.id === sent.runId)?.state === 'completed',
  );
  expect(latest!.messages).toEqual(
    f.store.snapshot(receipt.sessionId).messages,
  );
  sync.stop();
  const old = latest!;
  f.store.prune(receipt.sessionId, 1);
  await cache.replace({ ...old, through: 0 });
  await sync.start();
  await until(
    () =>
      state === 'live' &&
      latest!.through === f.store.watermark(receipt.sessionId).high,
  );
  expect(latest!.messages).toEqual(old.messages);
});
it('deduplicates identical events, rejects conflicting duplicates/gaps/offsets without moving cursor', async () => {
  const f = await fixture();
  cleanup = () => f.close();
  const c = await f.create();
  const snapshot = f.store.snapshot(c.receipt.sessionId);
  const p = await f.prompt(c.receipt.sessionId);
  await until(() => f.store.run(p.receipt.runId).state === 'completed');
  const events = f.store.events(c.receipt.sessionId, snapshot.through, 9999);
  const cache = new TestCache();
  await cache.replace(snapshot);
  const first = events[0]!;
  const next = await cache.apply(c.receipt.sessionId, first);
  expect(await cache.apply(c.receipt.sessionId, first)).toEqual(next);
  await expect(
    cache.apply(c.receipt.sessionId, { ...first, eventId: randomUUID() }),
  ).rejects.toThrow('Conflicting duplicate');
  expect(() =>
    applyEvent(snapshot, { ...first, sequence: first.sequence + 1 }),
  ).toThrow('Sequence gap');
  let current = snapshot;
  for (const event of events) {
    if (event.type === 'message.delta')
      expect(() =>
        applyEvent(current, {
          ...event,
          payload: { ...event.payload, startOffset: 9999 },
        }),
      ).toThrow('Delta mismatch');
    current = applyEvent(current, event);
  }
  expect(current.messages).toEqual(
    f.store.snapshot(c.receipt.sessionId).messages,
  );
  cache.db.close();
});
it('rejects external addresses, redirects and userinfo before sending credentials', () => {
  for (const origin of [
    'http://192.168.1.1:4317',
    'https://example.com',
    'http://localhost:4317',
    'http://token@127.0.0.1:4317',
    'http://127.0.0.1/path',
    'http://127.0.0.1?secret=x',
  ])
    expect(() => new Api(origin, 'secret')).toThrow();
});

it('shows the latest cancelled run after reopening a multi-turn session regardless of run-array order', async () => {
  const f = await fixture({ delay: 5 });
  try {
    const api = new Api(f.origin, f.auth.token);
    const receipt = await api.create('Multi-turn status', randomUUID());
    const first = await api.prompt(
      receipt.sessionId,
      'First completed turn',
      randomUUID(),
    );
    await until(() => f.store.run(first.runId!).state === 'completed');
    const second = await api.prompt(
      receipt.sessionId,
      'Cancel the new turn',
      randomUUID(),
    );
    await api.cancel(second.runId!, randomUUID());
    const snapshot = await api.snapshot(receipt.sessionId);
    expect(latestRun(snapshot)?.id).toBe(second.runId);
    expect(latestRun(snapshot)?.state).toBe('cancelled');
    expect(
      latestRun({ ...snapshot, runs: [...snapshot.runs].reverse() })?.state,
    ).toBe('cancelled');
  } finally {
    await f.close();
  }
});

it('batches replay behind a native commit barrier and never acknowledges or publishes uncommitted events', async () => {
  const f = await fixture({ delay: 1 });
  const api = new Api(f.origin, f.auth.token);
  const receipt = await api.create('Batched replay', randomUUID());
  const cache = new TestCache();
  const before = await api.snapshot(receipt.sessionId);
  await cache.replace(before);
  const sent = await api.prompt(
    receipt.sessionId,
    'A completed stream to replay after a slow native transaction',
    randomUUID(),
  );
  await until(() => f.store.run(sent.runId!).state === 'completed');
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batches: number[] = [];
  const durableCache: SessionCache = {
    load: (id) => cache.load(id),
    remove: (id) => cache.remove(id),
    replace: (snapshot) => cache.replace(snapshot),
    apply: (id, event) => cache.apply(id, event),
    applyBatch: async (id, events) => {
      batches.push(events.length);
      await barrier;
      let next = (await cache.load(id))!;
      for (const event of events) next = await cache.apply(id, event);
      return next;
    },
  };
  const acks: number[] = [];
  let latest = before;
  let state = '';
  const sync = new SessionSync(
    api,
    durableCache,
    receipt.sessionId,
    (snapshot) => {
      latest = snapshot;
    },
    (value) => {
      state = value;
    },
    (url) => {
      const socket = new WebSocket(url, { origin: f.origin });
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        const frame = JSON.parse(String(data));
        if (frame.type === 'ack') acks.push(frame.through);
        send(data);
      };
      return socket as unknown as globalThis.WebSocket;
    },
  );
  cleanup = async () => {
    release();
    sync.stop();
    await f.close();
    cache.db.close();
  };
  await sync.start();
  await until(() => batches.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(acks).toEqual([]);
  expect(latest.through).toBe(before.through);
  expect(state).not.toBe('live');
  release();
  await until(() => state === 'live');
  expect(batches.some((size) => size > 1)).toBe(true);
  expect(Math.max(...batches)).toBeLessThanOrEqual(200);
  expect(acks.at(-1)).toBe(f.store.watermark(receipt.sessionId).high);
  expect(latest.messages).toEqual(f.store.snapshot(receipt.sessionId).messages);
});

it('bounds raw frames and queued plus in-flight replay bytes while a native commit is stalled', async () => {
  const f = await fixture();
  const api = new Api(f.origin, f.auth.token);
  const receipt = await api.create('Bounded native queue', randomUUID());
  const before = await api.snapshot(receipt.sessionId);
  const sent = await api.prompt(
    receipt.sessionId,
    'Queue fixture',
    randomUUID(),
  );
  await until(() => f.store.run(sent.runId!).state === 'completed');
  const event = f.store
    .events(receipt.sessionId, before.through, 9999)
    .find((event) => event.type === 'message.started')!;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let applied = 0,
    published = 0;
  const cache: SessionCache = {
    load: async () => before,
    remove: async () => undefined,
    replace: async () => undefined,
    apply: async () => {
      applied++;
      await barrier;
      return before;
    },
  };
  let closed = 0;
  const writes: string[] = [];
  const socket = {
    readyState: 1,
    close: () => {
      closed++;
    },
    send: (data: string) => {
      writes.push(data);
    },
    onmessage: undefined as undefined | ((event: { data: string }) => void),
  };
  const sync = new SessionSync(
    api,
    cache,
    receipt.sessionId,
    () => {
      published++;
    },
    () => undefined,
    () => socket as unknown as globalThis.WebSocket,
  );
  cleanup = async () => {
    release();
    sync.stop();
    await f.close();
  };
  await sync.start();
  const frame = JSON.stringify({
    ...event,
    payload: { ...event.payload, text: 'x'.repeat(60000) },
  });
  socket.onmessage!({ data: frame });
  expect(applied).toBe(1);
  for (let i = 0; i < 30; i++) socket.onmessage!({ data: frame });
  expect(closed).toBe(1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(applied).toBe(1);
  expect(published).toBe(1); // Only the initial durable snapshot.
  expect(writes).toEqual([]);
  sync.stop();
  await sync.start();
  socket.onmessage!({
    data: JSON.stringify({
      type: 'connection.ping',
      padding: 'x'.repeat(131072),
    }),
  });
  expect(closed).toBe(3); // Overflow, explicit stop, oversized raw frame.
  expect(writes).toEqual([]);
});

it('withdraws cached details when a real source authority socket closes and never auto-replays them', async () => {
  const f = await fixture();
  const cache = new TestCache();
  const api = new Api(f.origin, f.auth.token);
  const conversationId = randomUUID(),
    workspaceId = randomUUID(),
    trajectoryId = randomUUID();
  await f.replaceExternal(conversationId, {
    conversationId,
    workspaceId,
    readMode: 'coding',
    read: async () => ({
      conversationId,
      trajectoryId,
      view: 'coding',
      laterHistory: 'unobserved',
      steps: [
        {
          index: 0,
          executionId: conversationId,
          role: 'activity',
          text: '',
          done: true,
          appStepType: 21,
          activity: {
            schemaVersion: 'app-2.29.0',
            kind: 'tool',
            label: 'Run command',
            upstreamType: 21,
            state: 'done',
            detailsOmitted: true,
            detail: {
              kind: 'command',
              source: 'app-2.29.0/runCommand',
              output: 'Observed fixture output',
              clipped: false,
            },
          },
        },
      ],
    }),
  });
  const sid = f.store.list('', 30, [workspaceId]).items[0]!.id;
  let state = '';
  let visible: Snapshot | null = null;
  const sync = new SessionSync(
    api,
    cache,
    sid,
    (s) => {
      visible = s;
    },
    (s) => {
      state = s;
      if (s === 'auth-required') visible = null;
    },
    (url) =>
      new WebSocket(url, {
        origin: f.origin,
      }) as unknown as globalThis.WebSocket,
  );
  cleanup = async () => {
    sync.stop();
    await f.close();
    cache.db.close();
  };
  await sync.start();
  await until(() => state === 'live');
  expect(visible!.messages[0]!.activity?.detail?.output).toBe(
    'Observed fixture output',
  );
  await f.replaceExternal(conversationId);
  await until(() => state === 'auth-required');
  expect(visible).toBeNull();
  await until(
    () =>
      cache.db.prepare('SELECT count(*) AS n FROM cache').get() &&
      (
        cache.db.prepare('SELECT count(*) AS n FROM cache').get() as {
          n: number;
        }
      ).n === 0,
  );
});

it('revalidates removed-source authority before exposing cached content on a new connection', async () => {
  const f = await fixture();
  const cache = new TestCache();
  const api = new Api(f.origin, f.auth.token);
  const conversationId = randomUUID(),
    trajectoryId = randomUUID(),
    workspaceId = randomUUID();
  await f.replaceExternal(conversationId, {
    conversationId,
    workspaceId,
    read: async () => ({
      conversationId,
      trajectoryId,
      steps: [
        {
          index: 0,
          executionId: randomUUID(),
          role: 'user',
          text: 'Protected cached observation',
          done: true,
        },
      ],
    }),
  });
  const sid = f.store
    .list('', 30, [workspaceId])
    .items.find((s) => s.external?.conversationId === conversationId)!.id;
  await cache.replace(await api.snapshot(sid));
  await f.replaceExternal(conversationId);
  let published = 0,
    state = '';
  const sync = new SessionSync(
    api,
    cache,
    sid,
    () => {
      published++;
    },
    (s) => {
      state = s;
    },
  );
  cleanup = async () => {
    sync.stop();
    await f.close();
    cache.db.close();
  };
  await sync.start();
  expect(state).toBe('auth-required');
  expect(published).toBe(0);
  expect(await cache.load(sid)).toBeNull();
});
it('ignores a delayed real HTTP snapshot after runtime retirement', async () => {
  const f = await fixture();
  const cache = new TestCache();
  const api = new Api(f.origin, f.auth.token);
  const receipt = await api.create('Delayed source', randomUUID());
  const read = api.snapshot.bind(api);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
    entered = r;
  });
  api.snapshot = async (id) => {
    const value = await read(id);
    entered();
    await new Promise<void>((r) => {
      release = r;
    });
    return value;
  };
  let published = 0;
  const sync = new SessionSync(
    api,
    cache,
    receipt.sessionId,
    () => {
      published++;
    },
    () => {},
  );
  cleanup = async () => {
    sync.stop();
    await f.close();
    cache.db.close();
  };
  const pending = sync.start();
  await gate;
  sync.stop();
  release();
  await pending;
  expect(published).toBe(0);
  expect(await cache.load(receipt.sessionId)).toBeNull();
});

it('retains a previously authorized cache during real transport loss without issuing any mutation', async () => {
  const f = await fixture();
  const cache = new TestCache();
  const api = new Api(f.origin, f.auth.token);
  const receipt = await api.create('Offline read cache', randomUUID());
  const snapshot = await api.snapshot(receipt.sessionId);
  await cache.replace(snapshot);
  await f.close();
  let latest: Snapshot | undefined,
    state = '';
  const sync = new SessionSync(
    api,
    cache,
    receipt.sessionId,
    (s) => {
      latest = s;
    },
    (s) => {
      state = s;
    },
  );
  cleanup = async () => {
    sync.stop();
    cache.db.close();
  };
  await sync.start();
  expect(state).toBe('reconnecting');
  expect(latest).toEqual(snapshot);
});
