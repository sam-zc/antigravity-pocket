import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { Store } from '../services/gateway/src/db/store';
const bridge = vi.hoisted(() => ({
  database: null as unknown,
  readGate: undefined as undefined | (() => Promise<void>),
  commitGate: undefined as undefined | (() => Promise<void>),
}));
vi.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => bridge.database,
}));
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'sha256' },
  digestStringAsync: async (_algorithm: string, value: string) =>
    createHash('sha256').update(value).digest('hex'),
}));
import { Cache } from '../apps/mobile/src/services/cache';

let native: Database.Database | undefined;
afterEach(() => {
  native?.close();
});
async function setup() {
  bridge.readGate = undefined;
  bridge.commitGate = undefined;
  native = new Database(':memory:');
  const sql = native;
  // Emulate only the Expo async bridge; execute the production Cache's exact SQL and transactions.
  const db = {
    execAsync: async (query: string) => {
      sql.exec(query);
    },
    runAsync: async (query: string, ...args: unknown[]) =>
      sql.prepare(query).run(...args),
    getAllAsync: async (query: string, ...args: unknown[]) =>
      sql.prepare(query).all(...args),
    getFirstAsync: async (query: string, ...args: unknown[]) => {
      const row = sql.prepare(query).get(...args) ?? null;
      if (query.startsWith('SELECT text,command')) await bridge.readGate?.();
      return row;
    },
    withExclusiveTransactionAsync: async (
      action: (transaction: unknown) => Promise<void>,
    ) => {
      sql.exec('BEGIN IMMEDIATE');
      try {
        await action(db);
        await bridge.commitGate?.();
        sql.exec('COMMIT');
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
  bridge.database = db;
  return Cache.open('test-gateway');
}
function timeline() {
  const store = new Store(':memory:');
  const key = randomUUID();
  const created = store.command('create', key, key, () =>
    store.create('Cache test'),
  );
  const snapshot = store.snapshot(created.sessionId);
  const sent = store.command('prompt', key, key, () =>
    store.prompt(created.sessionId, {
      protocolVersion: 1,
      clientMessageId: key,
      text: 'Hello',
    }),
  );
  store.start(sent.runId!);
  store.delta(sent.runId!, 'Persisted output');
  store.finish(sent.runId!, 'completed');
  const events = store.events(created.sessionId, snapshot.through, 9999);
  const final = store.snapshot(created.sessionId);
  store.close();
  return { snapshot, events, final };
}
it('executes production cache SQL atomically and verifies completion hashes and duplicate identity', async () => {
  const cache = await setup();
  const { snapshot, events, final } = timeline();
  await cache.replace(snapshot);
  for (const event of events) {
    if (event.type === 'message.completed') {
      await expect(
        cache.apply(snapshot.session.id, {
          ...event,
          payload: { ...event.payload, hash: 'a'.repeat(64) },
        }),
      ).rejects.toThrow('Message hash mismatch');
      expect((await cache.load(snapshot.session.id))!.through).toBe(
        event.sequence - 1,
      );
    }
    await cache.apply(snapshot.session.id, event);
    await cache.apply(snapshot.session.id, event);
    await expect(
      cache.apply(snapshot.session.id, { ...event, eventId: randomUUID() }),
    ).rejects.toThrow('Conflicting duplicate');
  }
  expect((await cache.load(snapshot.session.id))!.messages).toEqual(
    final.messages,
  );
});
it('persists draft command identity, namespaces data and purges only the selected gateway', async () => {
  const cache = await setup();
  const id = randomUUID();
  const command = randomUUID();
  await cache.saveDraft(id, 'Keep this draft', command);
  const reopened = await Cache.open('test-gateway');
  expect(await reopened.draft(id)).toEqual({
    text: 'Keep this draft',
    command,
  });
  const other = await Cache.open('other-gateway');
  await other.saveDraft(id, 'Other draft');
  await cache.purge();
  expect((await reopened.draft(id)).text).toBe('');
  expect((await other.draft(id)).text).toBe('Other draft');
  await expect(cache.saveDraft(id, '🛰'.repeat(20000))).rejects.toThrow(
    '64 KiB',
  );
});
it('bounds snapshots and refuses excess drafts without evicting user text', async () => {
  const cache = await setup();
  const { snapshot } = timeline();
  for (let i = 0; i < 22; i++) {
    const id = randomUUID();
    await cache.replace({
      ...snapshot,
      session: { ...snapshot.session, id },
      streamId: `session:${id}`,
    });
  }
  expect(native!.prepare('SELECT count(*) AS n FROM snapshots').get()).toEqual({
    n: 20,
  });
  for (let i = 0; i < 100; i++) await cache.saveDraft(randomUUID(), 'Saved');
  await expect(cache.saveDraft(randomUUID(), 'Too many')).rejects.toThrow(
    'capacity',
  );
  expect(native!.prepare('SELECT count(*) AS n FROM drafts').get()).toEqual({
    n: 100,
  });
});
it('serializes draft and stream transactions across cache handles sharing one native database', async () => {
  const cache = await setup();
  const other = await Cache.open('other-gateway');
  const { snapshot, events, final } = timeline();
  await cache.replace(snapshot);
  for (const event of events) {
    await Promise.all([
      cache.saveDraft(snapshot.session.id, `Draft ${event.sequence}`),
      other.saveDraft('another-session', 'Other gateway draft'),
      cache.apply(snapshot.session.id, event),
    ]);
  }
  expect((await cache.load(snapshot.session.id))!.messages).toEqual(
    final.messages,
  );
  expect((await cache.draft(snapshot.session.id)).text).toBe(
    `Draft ${final.through}`,
  );
});

it('invalidates queued writes and old handles when a namespace or installation is purged', async () => {
  const cache = await setup();
  const old = await Cache.open('test-gateway');
  const delayed = old.saveDraft('session', 'Must not resurrect');
  const purge = cache.purge();
  await Promise.all([expect(delayed).rejects.toThrow('retired'), purge]);
  await expect(old.saveDraft('session', 'Still retired')).rejects.toThrow(
    'retired',
  );
  const fresh = await Cache.open('test-gateway');
  await fresh.saveDraft('session', 'Fresh authorized runtime');
  await old.purge();
  expect((await fresh.draft('session')).text).toBe('Fresh authorized runtime');
  expect((await old.draft('session')).text).toBe('');
  await Cache.purgeAll();
  await expect(fresh.saveDraft('session', 'Old installation')).rejects.toThrow(
    'retired',
  );
  expect((await (await Cache.open('test-gateway')).draft('session')).text).toBe(
    '',
  );
});

it('suppresses draft reads and successful in-flight write results retired during native work', async () => {
  const cache = await setup();
  await cache.saveDraft('session', 'Private draft');
  let releaseRead!: () => void;
  bridge.readGate = () =>
    new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
  const read = cache.draft('session');
  await Promise.resolve();
  await cache.purge();
  releaseRead();
  expect((await read).text).toBe('');
  bridge.readGate = undefined;
  const fresh = await Cache.open('test-gateway');
  let releaseCommit!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  bridge.commitGate = () =>
    new Promise<void>((resolve) => {
      releaseCommit = resolve;
      entered();
    });
  const write = fresh.saveDraft('session', 'In-flight text');
  await started;
  const purged = fresh.purge();
  bridge.commitGate = undefined;
  releaseCommit();
  await Promise.all([expect(write).rejects.toThrow('retired'), purged]);
  expect((await (await Cache.open('test-gateway')).draft('session')).text).toBe(
    '',
  );
});

it('commits bounded replay batches atomically and rejects corrupt tails without a partial cursor', async () => {
  const cache = await setup();
  const { snapshot, events, final } = timeline();
  await cache.replace(snapshot);
  const corrupt = events.map((event) =>
    event.type === 'message.completed'
      ? { ...event, payload: { ...event.payload, hash: 'a'.repeat(64) } }
      : event,
  );
  await expect(cache.applyBatch(snapshot.session.id, corrupt)).rejects.toThrow(
    'Message hash',
  );
  expect((await cache.load(snapshot.session.id))!.through).toBe(
    snapshot.through,
  );
  const result = await cache.applyBatch(snapshot.session.id, events);
  expect(result.messages).toEqual(final.messages);
  expect(result.runs).toEqual(final.runs);
  expect(result.through).toBe(final.through);
  expect(await cache.applyBatch(snapshot.session.id, events)).toEqual(result);
  await expect(
    cache.applyBatch(snapshot.session.id, [
      { ...events[0]!, eventId: randomUUID() },
    ]),
  ).rejects.toThrow('Conflicting duplicate');
  await expect(
    cache.applyBatch(snapshot.session.id, Array(201).fill(events[0])),
  ).rejects.toThrow('batch');
});

it('removes only the withdrawn conversation cache, replay and draft, preserving other sources', async () => {
  const cache = await setup();
  const { snapshot, events } = timeline();
  const other = timeline().snapshot;
  await cache.replace(snapshot);
  await cache.replace(other);
  await cache.apply(snapshot.session.id, events[0]!);
  await cache.saveDraft(snapshot.session.id, 'Withdrawn draft');
  await cache.remove(snapshot.session.id);
  expect(await cache.load(snapshot.session.id)).toBeNull();
  expect(await cache.draft(snapshot.session.id)).toEqual({
    text: '',
    command: null,
  });
  expect(
    native!
      .prepare('SELECT count(*) AS n FROM seen WHERE id=?')
      .get(snapshot.session.id),
  ).toEqual({ n: 0 });
  expect(await cache.load(other.session.id)).toEqual(other);
});

it('migrates legacy schema without dropping pending command IDs and refuses future schemas', async () => {
  const cache = await setup();
  await cache.saveDraft('pending', 'Exact intent', 'immutable-id');
  native!.pragma('user_version = 0');
  const migrated = await Cache.open('test-gateway');
  expect(native!.pragma('user_version', { simple: true })).toBe(1);
  expect(await migrated.draft('pending')).toEqual({
    text: 'Exact intent',
    command: 'immutable-id',
  });
  native!.pragma('user_version = 2');
  await expect(Cache.open('test-gateway')).rejects.toThrow('newer');
  expect(native!.prepare('SELECT command FROM drafts').get()).toEqual({
    command: 'immutable-id',
  });
});
it('repairs only corrupt read rows and keeps command protection through eviction and grant/source cleanup', async () => {
  const cache = await setup();
  const { snapshot } = timeline();
  const id = snapshot.session.id;
  await cache.saveDraft(id, 'Uncertain intent', 'one-shot');
  await cache.replace(snapshot);
  native!.prepare('UPDATE snapshots SET data=? WHERE id=?').run('{partial', id);
  expect(await cache.load(id)).toBeNull();
  expect((await cache.draft(id)).command).toBe('one-shot');
  for (let i = 0; i < 22; i++) {
    const next = randomUUID();
    await cache.replace({
      ...snapshot,
      session: { ...snapshot.session, id: next },
      streamId: `session:${next}`,
    });
  }
  expect((await cache.draft(id)).command).toBe('one-shot');
  const queued = cache.saveDraft(id, 'Late edit');
  const removed = cache.remove(id);
  await expect(queued).rejects.toThrow('retired');
  await removed;
  expect((await cache.draft(id)).text).toBe('');
  const fresh = await Cache.open('test-gateway');
  expect((await fresh.draft(id)).command).toBe('one-shot');
  await fresh.saveDraft('unsent', 'Private unsent text');
  await fresh.purge(true);
  const authorized = await Cache.open('test-gateway');
  expect((await authorized.draft(id)).command).toBe('one-shot');
  expect((await authorized.draft('unsent')).text).toBe('');
  await authorized.purge();
  expect(
    (await (await Cache.open('test-gateway')).draft(id)).command,
  ).toBeNull();
});
it('uses deterministic eviction ties and enforces the byte budget independently of count', async () => {
  const cache = await setup();
  const { snapshot } = timeline();
  const time = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const ids = Array.from({ length: 22 }, () => randomUUID()).sort();
    for (const id of ids.slice().reverse())
      await cache.replace({
        ...snapshot,
        session: { ...snapshot.session, id },
        streamId: `session:${id}`,
      });
    expect(
      native!.prepare('SELECT id FROM snapshots ORDER BY id').all(),
    ).toEqual(ids.slice(0, 20).map((id) => ({ id })));
    // Seed finite large disposable cache rows; production insertion must enforce total bytes too.
    native!.prepare('UPDATE snapshots SET data=?').run('x'.repeat(1200000));
    await cache.replace(snapshot);
    const stored = native!
      .prepare(
        'SELECT sum(length(CAST(data AS BLOB))) AS bytes,count(*) AS n FROM snapshots',
      )
      .get() as { bytes: number; n: number };
    expect(stored.bytes).toBeLessThanOrEqual(20971520);
    expect(stored.n).toBeLessThan(20);
  } finally {
    time.mockRestore();
  }
});
it('fails closed on corrupt command rows without deleting the no-resend barrier', async () => {
  const cache = await setup();
  await cache.saveDraft('pending', 'Exact intent', 'one-shot');
  native!.prepare('UPDATE drafts SET text=NULL').run();
  await expect(cache.draft('pending')).rejects.toThrow('corrupt');
  expect(native!.prepare('SELECT command FROM drafts').get()).toEqual({
    command: 'one-shot',
  });
});

it('recovers missing disposable tables without resetting drafts and quarantines cleanup failures', async () => {
  await setup();
  const cache = await Cache.open('cleanup-case');
  await cache.saveDraft('source', 'Private unsent');
  native!.exec('DROP TABLE seen');
  await Cache.open('cleanup-case');
  expect((await cache.draft('source')).text).toBe('Private unsent');
  bridge.commitGate = async () => {
    throw new Error('disk failure');
  };
  await expect(cache.remove('source')).rejects.toThrow('disk failure');
  bridge.commitGate = undefined;
  expect(await cache.load('source')).toBeNull();
  expect((await cache.draft('source')).text).toBe('');
  await expect(Cache.open('cleanup-case')).rejects.toThrow('cleanup failed');
  const unrelated = await Cache.open('unrelated');
  await unrelated.saveDraft('source', 'Permitted');
  expect((await unrelated.draft('source')).text).toBe('Permitted');
});
