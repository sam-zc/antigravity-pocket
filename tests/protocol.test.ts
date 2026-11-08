import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createSessionSchema,
  snapshotSchema,
  promptSchema,
  cancelSchema,
  clientFrameSchema,
  eventSchema,
  serverFrameSchema,
  utf8Bytes,
  WORKSPACE_ID,
} from '@pocket/protocol';
import { fingerprint } from '../services/gateway/src/db/store.js';
describe('bounded v1 contracts', () => {
  it('rejects an oversized malformed cache collection before accumulating per-item issues', () => {
    // Regression for GHSA-mrhx-c7xc-m3w5: bounded bytes alone do not bound validation issue amplification.
    const result = snapshotSchema.shape.messages.safeParse(
      Array(10000).fill(null),
    );
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Oversized collection accepted');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.code).toBe('too_big');
  });

  it('bounds UTF-8, rejects whitespace, unknown fields and wrong protocol versions', () => {
    const body = {
      protocolVersion: 1,
      clientMessageId: randomUUID(),
      text: 'a'.repeat(65536),
    };
    expect(promptSchema.safeParse(body).success).toBe(true);
    for (const text of [' ', 'a'.repeat(65537), '🛰'.repeat(20000)])
      expect(promptSchema.safeParse({ ...body, text }).success).toBe(false);
    expect(utf8Bytes('aé🛰')).toBe(Buffer.byteLength('aé🛰'));
    expect(promptSchema.safeParse({ ...body, shell: true }).success).toBe(
      false,
    );
    expect(
      promptSchema.safeParse({ ...body, protocolVersion: 2 }).success,
    ).toBe(false);
    expect(cancelSchema.safeParse({ protocolVersion: 1 }).success).toBe(true);
    expect(
      createSessionSchema.safeParse({
        protocolVersion: 1,
        title: 'a',
        workspaceId: WORKSPACE_ID,
        adapterId: 'mock',
      }).success,
    ).toBe(true);
  });
  it('correlates every supported event payload and rejects unknown envelopes', () => {
    const id = randomUUID();
    const session = {
      id,
      title: 'S',
      workspaceId: WORKSPACE_ID,
      adapterId: 'mock',
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run = {
      id,
      sessionId: id,
      clientMessageId: id,
      state: 'running',
      reason: null,
    };
    const message = {
      id,
      sessionId: id,
      runId: id,
      ordinal: 1,
      role: 'assistant',
      status: 'streaming',
      text: '',
      revision: 0,
    };
    const payloads = {
      'session.created': session,
      'message.started': message,
      'message.delta': {
        messageId: id,
        runId: id,
        expectedRevision: 0,
        revision: 1,
        startOffset: 0,
        text: 'hi',
      },
      'message.completed': {
        messageId: id,
        runId: id,
        revision: 2,
        length: 2,
        hash: 'a'.repeat(64),
        status: 'completed',
      },
      'agent.status.changed': run,
      'run.terminal': { ...run, state: 'completed' },
      'agent.tool.changed': {
        id,
        runId: id,
        name: 'mock_fixture',
        status: 'running',
        summary: 'fixture',
      },
    };
    for (const [type, payload] of Object.entries(payloads)) {
      const envelope = {
        protocolVersion: 1,
        eventId: id,
        streamId: `session:${id}`,
        sessionId: id,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type,
        payload,
      };
      expect(eventSchema.safeParse(envelope).success, type).toBe(true);
      expect(
        eventSchema.safeParse({ ...envelope, payload: { bad: true } }).success,
      ).toBe(false);
      expect(eventSchema.safeParse({ ...envelope, sequence: 0 }).success).toBe(
        false,
      );
      expect(
        eventSchema.safeParse({ ...envelope, protocolVersion: 2 }).success,
      ).toBe(false);
    }
    expect(serverFrameSchema.safeParse({ type: 'new.unknown' }).success).toBe(
      false,
    );
  });
  it('validates every client frame and safe integer cursors', () => {
    const streamId = `session:${randomUUID()}`;
    for (const frame of [
      { type: 'subscribe', protocolVersion: 1, streamId, after: 0 },
      { type: 'unsubscribe', streamId },
      { type: 'ack', streamId, through: 0 },
      { type: 'pong' },
    ])
      expect(clientFrameSchema.safeParse(frame).success).toBe(true);
    for (const after of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        clientFrameSchema.safeParse({
          type: 'subscribe',
          protocolVersion: 1,
          streamId,
          after,
        }).success,
      ).toBe(false);
  });
  it('fingerprints method, canonical target and normalized validated body', () => {
    expect(fingerprint('POST', '/a', { a: 1, b: 2 })).toBe(
      fingerprint('POST', '/a', { b: 2, a: 1 }),
    );
    expect(fingerprint('POST', '/a', {})).not.toBe(
      fingerprint('POST', '/b', {}),
    );
    expect(fingerprint('GET', '/a', {})).not.toBe(
      fingerprint('POST', '/a', {}),
    );
  });
});
