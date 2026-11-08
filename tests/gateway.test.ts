import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture, until } from './helpers.js';
import { DevelopmentAuth } from '../services/gateway/src/security/development-auth.js';
import { Store } from '../services/gateway/src/db/store.js';
import WebSocket from 'ws';
import { request as httpRequest } from 'node:http';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0)) await close();
});
async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options);
  cleanups.push(() => f.close());
  return f;
}
describe('real HTTP + WebSocket + SQLite', () => {
  it('lists newly created sessions first and paginates without duplicates', async () => {
    // Exercise the documented UUID tie-break explicitly, without relying on
    // HTTP requests happening in different wall-clock milliseconds.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T12:00:00.000Z'));
    const f = await setup();
    const tied: string[] = [];
    for (let i = 0; i < 4; i++)
      tied.push((await f.create(`Session ${i}`)).receipt.sessionId);
    vi.setSystemTime(new Date('2026-11-06T12:00:01.000Z'));
    const newest = await f.create('Newest');
    const first = await (await f.request('/v1/sessions?limit=2')).json();
    expect(first.items[0].id).toBe(newest.receipt.sessionId);
    const ids = first.items.map((item: { id: string }) => item.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await (
        await f.request(`/v1/sessions?limit=2&cursor=${cursor}`)
      ).json();
      ids.push(...page.items.map((item: { id: string }) => item.id));
      cursor = page.nextCursor;
    }
    expect(new Set(ids).size).toBe(5);
    expect(ids).toHaveLength(5);
    expect(ids).toEqual([newest.receipt.sessionId, ...tied.sort().reverse()]);
  });
  it('accepts native loopback WS Origin only with a ticket and rejects a foreign Origin', async () => {
    const f = await setup();
    const { ticket } = await (await f.request('/v1/auth/ws-ticket', {})).json();
    const url =
      f.origin.replace('http:', 'ws:') + '/v1/events?ticket=' + ticket;
    const denied = new WebSocket(url, { origin: 'http://evil.test' });
    denied.on('error', () => {});
    const status = await new Promise<number>((resolve) =>
      denied.once('unexpected-response', (_, response) => {
        response.resume();
        denied.terminate();
        resolve(response.statusCode!);
      }),
    );
    expect(status).toBe(403);
    const native = new WebSocket(url, { origin: f.origin });
    await new Promise<void>((resolve, reject) => {
      native.once('open', resolve);
      native.once('error', reject);
    });
    native.terminate();
    expect(
      (
        await f.request('/v1/sessions', undefined, undefined, {
          Origin: f.origin,
        })
      ).status,
    ).toBe(403);
  });
  it('accepts a maximum escaped prompt and rejects oversized bodies and unknown frame versions', async () => {
    const f = await setup();
    const c = await f.create();
    const text = 'x' + '\u0000'.repeat(65535);
    const p = await f.prompt(c.receipt.sessionId, text);
    expect(p.response.status).toBe(202);
    expect(f.store.snapshot(c.receipt.sessionId).messages[0]!.text).toBe(text);
    // Advertise the oversized body before uploading it. A fetch upload can race
    // the server's early 413/connection close and surface EPIPE instead.
    const { request } = await import('node:http');
    const rejected = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = request(
          `${f.origin}/v1/sessions`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${f.auth.token}`,
              'Content-Type': 'application/json',
              'Content-Length': '400001',
            },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
            req.end();
          },
        );
        req.on('error', reject);
        req.flushHeaders();
      },
    );
    expect(rejected).toBe(413);
    const viewer = await f.socket();
    viewer.ws.send(
      JSON.stringify({
        type: 'subscribe',
        protocolVersion: 2,
        streamId: `session:${c.receipt.sessionId}`,
        after: 0,
      }),
    );
    await until(() => viewer.ws.readyState === WebSocket.CLOSED);
  });
  it('creates, lists, streams and reconstructs identical durable history for two viewers', async () => {
    const f = await setup();
    const { receipt } = await f.create();
    const sid = receipt.sessionId;
    expect((await (await f.request('/v1/sessions')).json()).items[0].id).toBe(
      sid,
    );
    const first = await f.socket();
    const second = await f.socket();
    first.subscribe(sid, 0);
    second.subscribe(sid, 0);
    const sent = await f.prompt(sid, 'Persisted 🛰️ response');
    expect(sent.response.status).toBe(202);
    await until(
      () =>
        first.frames.some((e) => e.type === 'run.terminal') &&
        second.frames.some((e) => e.type === 'run.terminal'),
    );
    const events = first.frames.filter((e) => 'sequence' in e);
    expect(events).toEqual(second.frames.filter((e) => 'sequence' in e));
    expect(events.map((e) => e.sequence)).toEqual(
      Array.from({ length: events.length }, (_, i) => i + 1),
    );
    const snapshot = await (
      await f.request(`/v1/sessions/${sid}/snapshot`)
    ).json();
    expect(snapshot.messages[1].text).toContain('Persisted 🛰️ response');
    expect(snapshot.runs[0].state).toBe('completed');
    expect(snapshot.through).toBe(events.length);
  });
  it('replays after disconnect without aborting a run, including partial snapshot cutover', async () => {
    const f = await setup({ delay: 10 });
    const { receipt } = await f.create();
    const sid = receipt.sessionId;
    const sent = await f.prompt(sid);
    await until(() =>
      f.store
        .snapshot(sid)
        .messages.some((m) => m.role === 'assistant' && m.text.length > 0),
    );
    const partial = f.store.snapshot(sid);
    expect(partial.messages[1]!.status).toBe('streaming');
    const viewer = await f.socket();
    viewer.subscribe(sid, partial.through);
    await until(() => viewer.frames.some((e) => 'sequence' in e));
    viewer.ws.terminate();
    await until(() => f.store.run(sent.receipt.runId).state === 'completed');
    const back = await f.socket();
    back.subscribe(sid, partial.through);
    await until(() => back.frames.some((e) => e.type === 'run.terminal'));
    const events = back.frames.filter((e) => 'sequence' in e);
    expect(events[0]!.sequence).toBe(partial.through + 1);
    expect(events.at(-1)!.sequence).toBe(f.store.watermark(sid).high);
  });
  it('deduplicates commands and client IDs, rejects changed body and changed target', async () => {
    const f = await setup({ delay: 10 });
    const key = randomUUID();
    const a = await f.create('A', key);
    const b = await f.create('A', key);
    expect(a.receipt).toEqual(b.receipt);
    expect((await f.create('Changed', key)).response.status).toBe(409);
    const other = await f.create('B');
    const pkey = randomUUID();
    const p = await f.prompt(a.receipt.sessionId, 'same', pkey);
    expect((await f.prompt(a.receipt.sessionId, 'same', pkey)).receipt).toEqual(
      p.receipt,
    );
    expect(
      (await f.prompt(other.receipt.sessionId, 'same', pkey)).response.status,
    ).toBe(409);
    expect(
      (await f.prompt(a.receipt.sessionId, 'changed', pkey)).response.status,
    ).toBe(409);
    expect(
      (await f.prompt(a.receipt.sessionId, 'distinct')).response.status,
    ).toBe(409);
    const again = await f.request(
      `/v1/sessions/${a.receipt.sessionId}/messages`,
      { protocolVersion: 1, clientMessageId: pkey, text: 'same' },
    );
    expect((await again.json()).runId).toBe(p.receipt.runId);
    expect(
      f.store
        .snapshot(a.receipt.sessionId)
        .messages.filter((m) => m.role === 'user'),
    ).toHaveLength(1);
  });
  it('cancels queued and running runs exactly once and fences late deltas', async () => {
    const f = await setup({ delay: 100 });
    const runs: { sid: string; rid: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await f.create();
      const p = await f.prompt(c.receipt.sessionId);
      runs.push({ sid: c.receipt.sessionId, rid: p.receipt.runId });
    }
    expect(f.store.run(runs[2]!.rid).state).toBe('queued');
    for (const item of [runs[2]!, runs[0]!]) {
      expect(
        (await f.request(`/v1/runs/${item.rid}/cancel`, { protocolVersion: 1 }))
          .status,
      ).toBe(202);
      await f.request(`/v1/runs/${item.rid}/cancel`, { protocolVersion: 1 });
      f.store.delta(item.rid, 'late output');
      expect(f.store.run(item.rid).state).toBe('cancelled');
      expect(
        f.store
          .events(item.sid, 0, 9999)
          .filter((e) => e.type === 'run.terminal'),
      ).toHaveLength(1);
      expect(
        f.store
          .snapshot(item.sid)
          .messages.some((m) => m.text.includes('late output')),
      ).toBe(false);
    }
  });
  it('marks unfinished runs interrupted on reopen, preserves receipt and never resurrects', async () => {
    const f = await fixture({ delay: 100 });
    const c = await f.create();
    const p = await f.prompt(c.receipt.sessionId);
    const directory = f.directory;
    await f.close(false);
    const restarted = await setup({ directory });
    expect(restarted.store.run(p.receipt.runId)).toMatchObject({
      state: 'failed',
      reason: 'process_restarted',
    });
    const again = await restarted.prompt(
      c.receipt.sessionId,
      'Hello',
      p.receipt.commandId,
    );
    expect(again.receipt.runId).toBe(p.receipt.runId);
    expect(restarted.store.queued()).toHaveLength(0);
  });
  it('tails commits without an in-memory publish and makes pruning explicit', async () => {
    const f = await setup();
    const c = await f.create();
    const viewer = await f.socket();
    viewer.subscribe(c.receipt.sessionId, 0);
    const key = randomUUID();
    const receipt = f.store.command('direct', key, key, () =>
      f.store.prompt(c.receipt.sessionId, {
        protocolVersion: 1,
        clientMessageId: key,
        text: 'commit without notify',
      }),
    );
    await until(() =>
      viewer.frames.some(
        (e) =>
          e.type === 'agent.status.changed' && e.payload.id === receipt.runId,
      ),
    );
    f.store.prune(c.receipt.sessionId, 1);
    expect(
      (await f.request(`/v1/sessions/${c.receipt.sessionId}/events?after=0`))
        .status,
    ).toBe(410);
    const back = await f.socket();
    back.subscribe(c.receipt.sessionId, 0);
    await until(() => back.frames.some((e) => e.type === 'resync.required'));
    const snapshot = f.store.snapshot(c.receipt.sessionId);
    back.subscribe(c.receipt.sessionId, snapshot.through);
    await until(() => back.frames.some((e) => e.type === 'subscription.ready'));
  });
  it('bounds slow subscribers and rejects future acknowledgements', async () => {
    const f = await setup({
      realtime: {
        pollMs: 5,
        maxUnacked: 3,
        maxBytes: 1048576,
        heartbeatMs: 25000,
        deadMs: 60000,
      },
    });
    const c = await f.create();
    const viewer = await f.socket();
    viewer.subscribe(c.receipt.sessionId, 0);
    const p = await f.prompt(c.receipt.sessionId);
    await until(() => viewer.ws.readyState === WebSocket.CLOSED);
    expect(
      viewer.frames.some(
        (e) => e.type === 'resync.required' && e.reason === 'slow_consumer',
      ),
    ).toBe(true);
    await until(() => f.store.run(p.receipt.runId).state === 'completed');
    const other = await f.socket();
    other.subscribe(
      c.receipt.sessionId,
      f.store.watermark(c.receipt.sessionId).high,
    );
    other.ws.send(
      JSON.stringify({
        type: 'ack',
        streamId: `session:${c.receipt.sessionId}`,
        through: 99999,
      }),
    );
    await until(() => other.ws.readyState === WebSocket.CLOSED);
  });
  it('rejects auth, browser origins, rebinding Hosts, spoofed forwarding and unsupported versions', async () => {
    const f = await setup();
    expect((await fetch(f.origin + '/v1/sessions')).status).toBe(401);
    for (const headers of [
      { Origin: 'http://evil.test' },
      { 'X-Forwarded-For': '127.0.0.1' },
    ])
      expect(
        (await f.request('/v1/sessions', undefined, undefined, headers)).status,
      ).toBe(403);
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        f.origin + '/v1/sessions',
        {
          headers: {
            Host: 'evil.test',
            Authorization: `Bearer ${f.auth.token}`,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(hostStatus).toBe(403);
    const bad = await f.request('/v1/sessions', {
      protocolVersion: 2,
      title: 'bad',
    });
    expect(bad.status).toBe(400);
    const text = await bad.text();
    expect(text).not.toContain(f.auth.token);
    expect(text).not.toContain(f.directory);
  });
  it('consumes tickets once and closes active streams at development expiry', async () => {
    const f = await setup({ auth: new DevelopmentAuth(350) });
    const { ticket } = await (await f.request('/v1/auth/ws-ticket', {})).json();
    const url =
      f.origin.replace('http:', 'ws:') + '/v1/events?ticket=' + ticket;
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const duplicate = new WebSocket(url);
    const rejected = await new Promise<number>((resolve) => {
      duplicate.once('unexpected-response', (_, response) => {
        response.resume();
        duplicate.terminate();
        resolve(response.statusCode!);
      });
      duplicate.on('error', () => {});
    });
    expect(rejected).toBe(401);
    await until(() => ws.readyState === WebSocket.CLOSED);
    expect((await f.request('/v1/sessions')).status).toBe(401);
  });
  it('detects dead heartbeat connections and rejects oversized websocket frames', async () => {
    const f = await setup({
      realtime: {
        pollMs: 5,
        maxUnacked: 1000,
        maxBytes: 1048576,
        heartbeatMs: 20,
        deadMs: 80,
      },
    });
    const viewer = await f.socket();
    await until(() => viewer.ws.readyState === WebSocket.CLOSED);
    expect(viewer.frames.some((e) => e.type === 'connection.ping')).toBe(true);
    const huge = await f.socket();
    huge.ws.send('x'.repeat(140000));
    await until(() => huge.ws.readyState === WebSocket.CLOSED);
  });
  it('persists explicit adapter failure with partial output and terminal tool status', async () => {
    const f = await setup();
    const c = await f.create();
    const p = await f.prompt(c.receipt.sessionId, '/fail');
    await until(() => f.store.run(p.receipt.runId).state === 'failed');
    const s = f.store.snapshot(c.receipt.sessionId);
    expect(s.messages[1]!.text.length).toBeGreaterThan(0);
    expect(s.messages[1]!.status).toBe('failed');
    expect(s.runs[0]!.reason).toBe('mock_failure');
  });
  it('enforces one DB owner and rolls back state, event sequence and receipt together', async () => {
    const f = await setup();
    expect(() => new Store(f.directory + '/db.sqlite')).toThrow();
    expect(() =>
      f.store.command('rollback', 'key', 'hash', () => {
        f.store.create('Rolled back');
        throw new Error('fault');
      }),
    ).toThrow('fault');
    expect(f.store.list().items).toHaveLength(0);
    expect(f.store.db.prepare('SELECT * FROM events').all()).toHaveLength(0);
    expect(f.store.db.prepare('SELECT * FROM receipts').all()).toHaveLength(0);
  });
});
