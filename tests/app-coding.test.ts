import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secureFixture } from './secure-helpers.js';
import { certificates } from './secure-helpers.js';
import { fixture, until } from './helpers.js';
import {
  encodeVarint as v,
  StepWindowParser,
  selectedFields,
  single,
} from '../services/gateway/src/experimental/app-wire.js';
import { decodeCodingStep } from '../services/gateway/src/experimental/app-coding-step.js';
import { readCodingWindow } from '../services/gateway/src/experimental/app-coding-read.js';
import { validateEnrollment } from '../services/gateway/src/experimental/app-enrollment.js';
import { snapshotSchema } from '@pocket/protocol';
import { ProbeError } from '../services/gateway/src/experimental/app-probe.js';
const conversation = randomUUID(),
  trajectory = randomUUID();
const ids = Array.from({ length: 60 }, () => randomUUID());
const n = (key: number, value: number) => Buffer.concat([v(key * 8), v(value)]);
const b = (key: number, value: string | Buffer) => {
  const data = Buffer.from(value);
  return Buffer.concat([v(key * 8 + 2), v(data.length), data]);
};
function step(
  index: number,
  type = 21,
  extra = Buffer.alloc(0),
  sensitivity = 0,
) {
  return Buffer.concat([
    n(1, type),
    n(4, 3),
    b(
      5,
      Buffer.concat([
        b(12, ids[index]!),
        n(39, sensitivity),
        b(
          20,
          Buffer.concat([b(1, trajectory), n(2, index), b(4, conversation)]),
        ),
      ]),
    ),
    extra,
  ]);
}
const decode = (raw: Buffer, index: number) =>
  decodeCodingStep(raw, conversation, index);
describe('App 2.29.0 coding schemas (synthetic wire fixtures)', () => {
  it('whitelists public text/status, explicitly distinguishes omissions and unknowns, never copies private fields', () => {
    const secret = 'PRIVATE_THINKING_DO_NOT_RENDER';
    const response = b(
      20,
      Buffer.concat([
        b(1, 'Visible response'),
        b(3, secret),
        b(16, secret),
        b(7, secret),
      ]),
    );
    const visible = decode(step(0, 15, response), 0);
    expect(visible).toMatchObject({
      role: 'assistant',
      text: 'Visible response',
      contentOmitted: true,
    });
    expect(JSON.stringify(visible)).not.toContain(secret);
    expect(decode(step(0, 21, b(28, b(24, secret))), 0).activity).toMatchObject(
      {
        kind: 'tool',
        label: 'Run command',
        state: 'done',
      },
    );
    expect(decode(step(0, 101, b(158, secret)), 0).activity?.kind).toBe(
      'omitted',
    );
    expect(decode(step(0, 9999, b(158, secret)), 0).activity?.kind).toBe(
      'unknown',
    );
  });
  it('rejects malformed identity, duplicate singleton fields, unsafe public content and restricted sensitivity', () => {
    expect(() => decode(step(1), 0)).toThrow('upstream_identity_or_gap');
    expect(() => decode(Buffer.concat([step(0), n(1, 21)]), 0)).toThrow(
      'ambiguous_wire',
    );
    expect(() =>
      decode(step(0, 15, b(20, b(1, 'password=do-not-render'))), 0),
    ).toThrow('unsafe_content');
    expect(() => decode(step(0, 21, Buffer.alloc(0), 2), 0)).toThrow(
      'unsafe_content',
    );
    expect(() =>
      decode(step(0, 15, b(20, b(1, Buffer.from([0xff])))), 0),
    ).toThrow('unsafe_content');
    // Check every public byte BEFORE truncation, including a credential split across user items.
    expect(() =>
      decode(
        step(
          0,
          14,
          b(
            19,
            Buffer.concat([
              b(3, b(1, 'x'.repeat(1000) + ' password')),
              b(3, b(1, '=secret')),
            ]),
          ),
        ),
        0,
      ),
    ).toThrow('unsafe_content');
    const clipped = decode(step(0, 15, b(20, b(1, '😀'.repeat(1000)))), 0);
    expect(Buffer.byteLength(clipped.text)).toBe(768);
    expect(clipped.contentOmitted).toBe(true);
  });
  it('bounds public text scanning even with a long malformed URL authority', () => {
    const text = 'https://' + 'a:'.repeat(100000);
    const result = decode(step(0, 15, b(20, b(1, text))), 0);
    expect(Buffer.byteLength(result.text)).toBe(768);
    expect(result.contentOmitted).toBe(true);
    expect(() =>
      decode(
        step(0, 15, b(20, b(1, 'https://user:credential@example.com/path'))),
        0,
      ),
    ).toThrow('unsafe_content');
  }, 1000);
  it('parses split frames, stops at twenty, bounds oversized steps/chunks, rejects truncated and invalid wire', () => {
    const payload = Buffer.concat(
      Array.from({ length: 21 }, (_, i) => b(1, step(i))),
    );
    const parser = new StepWindowParser(decode);
    let stopped = false;
    for (let i = 0; i < payload.length && !stopped; i += 7)
      stopped = parser.push(payload.subarray(i, i + 7));
    expect(stopped).toBe(true);
    expect(parser.rows).toHaveLength(20);
    expect(parser.peakBuffered).toBeLessThan(1024);
    const over = new StepWindowParser(decode);
    expect(() => over.push(Buffer.concat([v(10), v(262145)]))).toThrow(
      'step_limit',
    );
    expect(() =>
      new StepWindowParser(decode).push(Buffer.alloc(65537)),
    ).toThrow('chunk_limit');
    const truncated = new StepWindowParser(decode);
    truncated.push(payload.subarray(0, 5));
    expect(() => truncated.finish()).toThrow('truncated_wire');
    expect(() => new StepWindowParser(decode).push(Buffer.from([15]))).toThrow(
      'incompatible_response',
    );
  });
  it('uses real verified HTTPS, explicit offsets, cancellation and finite total/deadline bounds without retries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-tls-'));
    const tls = certificates(dir);
    let mode = 'window',
      calls = 0;
    const server = createServer(tls, (req, res) => {
      calls++;
      const body: Buffer[] = [];
      req.on('data', (c) => body.push(c));
      req.on('end', () => {
        expect(req.url).toBe(
          '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps',
        );
        const fields = selectedFields(Buffer.concat(body), [1, 2, 4]);
        expect(single(fields, 2)).toBe(0);
        expect(single(fields, 4)).toBe(2);
        res.setHeader('content-type', 'application/proto');
        if (mode === 'wait') return;
        if (mode === 'auth') {
          res.writeHead(403);
          res.end();
          return;
        }
        if (mode === 'overflow') {
          res.end(
            Buffer.concat(
              Array.from({ length: 20 }, (_, i) =>
                b(1, step(i, 21, b(158, Buffer.alloc(220000)))),
              ),
            ),
          );
          return;
        }
        const count = mode === 'end' ? 2 : 30;
        res.end(
          Buffer.concat(Array.from({ length: count }, (_, i) => b(1, step(i)))),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error();
    const config = {
      enabled: true as const,
      version: '2.29.0' as const,
      pid: 1,
      port: address.port,
      conversationId: conversation,
    };
    try {
      const observation = await readCodingWindow(config, 'fixture', tls.ca);
      expect(observation.steps).toHaveLength(20);
      expect(observation.laterHistory).toBe('unobserved');
      mode = 'end';
      expect(
        (await readCodingWindow(config, 'fixture', tls.ca)).laterHistory,
      ).toBe('observed_end');
      mode = 'overflow';
      await expect(
        readCodingWindow(config, 'fixture', tls.ca),
      ).rejects.toMatchObject({ code: 'response_limit' });
      mode = 'auth';
      await expect(
        readCodingWindow(config, 'fixture', tls.ca),
      ).rejects.toMatchObject({ code: 'upstream_auth_rejected' });
      mode = 'wait';
      const controller = new AbortController();
      const pending = readCodingWindow(
        config,
        'fixture',
        tls.ca,
        0,
        controller.signal,
      );
      setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      await expect(
        readCodingWindow(config, 'fixture', tls.ca),
      ).rejects.toMatchObject({ code: 'timeout' });
      expect(calls).toBe(6);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('forbids coding send opt-in even through owner-file configuration', () => {
    expect(() =>
      validateEnrollment({
        workspaceId: randomUUID(),
        projectId: randomUUID(),
        conversationId: conversation,
        trajectoryId: trajectory,
        title: 'Coding',
        observedAppUrl: 'invalid',
        disposable: false,
        readMode: 'coding',
        sendMode: 'ordinary-text',
      }),
    ).toThrow('coding_read_only');
  });
});
describe('coding projection through real HTTP/WebSocket and SQLite (synthetic upstream)', () => {
  it('preserves overlapping IDs, one-window duplicate semantics, replay, failures, disable and switching isolation', async () => {
    const f = await fixture();
    const workspaceId = randomUUID();
    let start = 0,
      revision = 0,
      fail = false;
    const read = async (offset?: number) => {
      if (fail) throw new ProbeError('unsafe_content');
      start = offset ?? start;
      return {
        conversationId: conversation,
        trajectoryId: trajectory,
        view: 'coding' as const,
        laterHistory: 'unobserved' as const,
        steps: Array.from({ length: 20 }, (_, i) => {
          const index = start + i;
          return decode(
            step(
              index,
              index % 2 ? 21 : 15,
              index % 2 ? Buffer.alloc(0) : b(20, b(1, `Visible ${revision}`)),
            ),
            index,
          );
        }),
      };
    };
    try {
      await f.replaceExternal(conversation, {
        conversationId: conversation,
        workspaceId,
        readMode: 'coding',
        read,
      });
      const sid = f.store.list('', 30, [workspaceId]).items[0]!.id;
      const path = `/v1/sessions/${sid}`;
      const initial = snapshotSchema.parse(
        await (await f.request(path + '/snapshot')).json(),
      );
      const socket = await f.socket();
      socket.subscribe(sid, initial.through);
      await until(() =>
        socket.frames.some((e) => e.type === 'subscription.ready'),
      );
      const results = await Promise.all([
        f.request(path + '/app-history/next', {
          protocolVersion: 1,
          expectedEnd: 20,
        }),
        f.request(path + '/app-history/next', {
          protocolVersion: 1,
          expectedEnd: 20,
        }),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const after = f.store.snapshot(sid);
      expect(after.session.external?.windowStart).toBe(16);
      expect(after.session.external?.windowEnd).toBe(36);
      expect(after.messages[0]!.id).toBe(initial.messages[16]!.id);
      expect(after.messages.some((m) => m.role === 'activity')).toBe(true);
      await until(() =>
        socket.frames.some((e) => e.type === 'external.snapshot'),
      );
      const back = await f.socket();
      back.subscribe(sid, initial.through);
      await until(() =>
        back.frames.some((e) => e.type === 'external.snapshot'),
      );
      expect((await f.prompt(sid, 'No send')).response.status).toBe(404);
      const mock = await f.create('Separate mock');
      expect(f.store.snapshot(mock.receipt.sessionId).messages).toEqual([]);
      revision++;
      await until(
        () =>
          f.store.snapshot(sid).messages.some((m) => m.text === 'Visible 1'),
        5000,
      );
      expect(f.store.snapshot(sid).messages[0]!.id).toBe(after.messages[0]!.id);
      const saved = f.store.snapshot(sid).messages;
      fail = true;
      await until(
        () =>
          f.store.snapshot(sid).session.external?.issue === 'unsafe_content',
        5000,
      );
      expect(f.store.snapshot(sid).messages).toEqual(saved);
      expect(f.store.snapshot(sid).session.external?.observation).toBe('gap');
      expect(
        (
          await f.request(path + '/app-history/next', {
            protocolVersion: 1,
            expectedEnd: 36,
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
      await f.replaceExternal(conversation);
      expect((await f.request(path + '/snapshot')).status).toBe(404);
      expect(
        (
          await f.request(path + '/app-history/next', {
            protocolVersion: 1,
            expectedEnd: 36,
          })
        ).status,
      ).toBe(404);
      expect(f.store.snapshot(sid).session.external?.readOnly).toBe(true);
    } finally {
      await f.close();
    }
  }, 15000);
});

it('rechecks a read-only grant after awaiting the upstream window and denies subsequent replay/paging', async () => {
  const workspaceId = randomUUID();
  let release: (() => void) | undefined;
  const f = await secureFixture({
    conversationId: conversation,
    workspaceId,
    readMode: 'coding',
    read: async (offset) => {
      if (offset !== undefined)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return {
        conversationId: conversation,
        trajectoryId: trajectory,
        view: 'coding',
        laterHistory: 'unobserved',
        steps: Array.from({ length: 20 }, (_, i) =>
          decode(
            step(
              (offset ?? 0) + i,
              21,
              b(28, b(21, b(1, 'Observed authorized fixture output'))),
            ),
            (offset ?? 0) + i,
          ),
        ),
      };
    },
  });
  try {
    const sid = f.store.list('', 30, [workspaceId]).items[0]!.id;
    const paired = await f.pair([{ workspaceId, scopes: ['session:read'] }]);
    const socket = await f.socket(paired.pair.accessToken);
    socket.subscribe(`session:${sid}`);
    await until(() =>
      socket.frames.some((frame) => frame.type === 'subscription.ready'),
    );
    const before = f.store.snapshot(sid).messages;
    const pending = f.request(
      `/v1/sessions/${sid}/app-history/next`,
      { protocolVersion: 1, expectedEnd: 20 },
      paired.pair.accessToken,
    );
    await until(() => !!release);
    f.devices.reduce(paired.pair.deviceId, []);
    release!();
    expect((await pending).status).toBeGreaterThanOrEqual(400);
    expect(f.store.snapshot(sid).messages).toEqual(before);
    expect(f.store.snapshot(sid).session.external?.observation).toBe('fresh');
    expect(
      (
        await f.request(
          `/v1/sessions/${sid}/events?after=0`,
          undefined,
          paired.pair.accessToken,
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await f.request(
          `/v1/sessions/${sid}/app-history/next`,
          { protocolVersion: 1, expectedEnd: 20 },
          paired.pair.accessToken,
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
  } finally {
    release?.();
    await f.close();
  }
});
