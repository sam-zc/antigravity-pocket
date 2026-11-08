import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { Store } from '../services/gateway/src/db/store.js';
import { AppCommands } from '../services/gateway/src/experimental/app-commands.js';
import {
  APP_WORKSPACE,
  AppProjection,
  type AppSource,
} from '../services/gateway/src/experimental/app-projection.js';
import { sendAppText } from '../services/gateway/src/experimental/app-probe.js';
import { certificates, secureFixture } from './secure-helpers.js';
import { appCommandSchema } from '@pocket/protocol';
const text =
  'Reply with exactly POCKET-APP-TEST. Text only. Do not use tools, files, commands, or network.';
const wait = async (check: () => boolean) => {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out');
};
function source(send: () => Promise<Record<string, never>>): AppSource {
  const conversationId = randomUUID(),
    trajectoryId = randomUUID();
  return {
    conversationId,
    read: async () => ({
      conversationId,
      trajectoryId,
      steps: [
        { index: 0, executionId: randomUUID(), role: 'user', text, done: true },
      ],
    }),
    prepareSend: async () => send,
  };
}
async function fixture(upstream: AppSource, path = ':memory:') {
  const store = new Store(path),
    projection = new AppProjection(store, upstream);
  await projection.start();
  const sid = store.list('', 30, [APP_WORKSPACE]).items[0]!.id;
  const commands = new AppCommands(store, upstream);
  return {
    store,
    sid,
    commands,
    close: async () => {
      await commands.close();
      await projection.close();
      store.close();
    },
  };
}
describe('durable one-shot App sends', () => {
  it('commits intent before preparation/dispatch; duplicate local IDs never dispatch twice and conflicting IDs fail', async () => {
    let calls = 0;
    const upstream = source(async () => {
      calls++;
      const row = f.store.db
        .prepare('SELECT data FROM external_commands')
        .get() as { data: string };
      expect(JSON.parse(row.data).delivery).toBe('dispatching');
      return {};
    });
    const f = await fixture(upstream),
      key = randomUUID();
    try {
      const first = f.commands.submit(f.sid, key, 'owner', text, () => {});
      expect(first.delivery).toBe('received');
      expect(
        f.commands.submit(f.sid, key, 'owner', text, () => {}).commandId,
      ).toBe(key);
      expect(() =>
        f.commands.submit(
          f.sid,
          key,
          'owner',
          text.replace('TEST', 'OTHER'),
          () => {},
        ),
      ).toThrow('already bound');
      await wait(
        () => f.commands.get(f.sid, key, 'owner').delivery === 'acknowledged',
      );
      f.commands.submit(f.sid, key, 'owner', text, () => {});
      expect(calls).toBe(1);
      expect(f.commands.get(f.sid, key, 'owner').observedResult).toBe(
        'not_correlated',
      );
      expect(() => f.commands.get(f.sid, key, 'another-device')).toThrow(
        'unavailable',
      );
    } finally {
      await f.close();
    }
  });
  it('retains lost-ack uncertainty across SQLite restart, ignores matching desktop text, and requires explicit resolution', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pocket-command-restart-')),
      path = join(dir, 'db.sqlite');
    let calls = 0;
    const upstream = source(async () => {
      calls++;
      throw new Error('PRIVATE TOKEN must not leak');
    });
    const f = await fixture(upstream, path),
      key = randomUUID();
    f.commands.submit(f.sid, key, 'owner', text, () => {});
    await wait(
      () => f.commands.get(f.sid, key, 'owner').delivery === 'uncertain',
    );
    const sid = f.sid;
    expect(JSON.stringify(f.commands.get(sid, key, 'owner'))).not.toContain(
      'PRIVATE',
    );
    // Upstream history already contains equal text; there is no automatic inference.
    expect(f.store.snapshot(sid).messages[0]!.text).toBe(text);
    await f.close();
    const store = new Store(path),
      recovered = new AppCommands(store, upstream);
    try {
      expect(recovered.get(sid, key, 'owner').delivery).toBe('uncertain');
      recovered.submit(sid, key, 'owner', text, () => {});
      expect(calls).toBe(1);
      expect(() =>
        recovered.submit(sid, randomUUID(), 'owner', text, () => {}),
      ).toThrow('Resolve');
      const resolved = recovered.resolve(sid, key, 'owner', text);
      expect(resolved.delivery).toBe('uncertain');
      expect(resolved.resolvedAt).toBeTruthy();
      const delayed = randomUUID();
      recovered.resolve(sid, delayed, 'owner', text);
      recovered.submit(sid, delayed, 'owner', text, () => {});
      expect(calls).toBe(1);
    } finally {
      await recovered.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('distinguishes crash-before-dispatch from crash-after-dispatch and never recovers by sending', async () => {
    let calls = 0;
    const upstream = source(async () => {
      calls++;
      return {};
    });
    const f = await fixture(upstream);
    try {
      const key = randomUUID();
      f.commands.resolve(f.sid, key, 'owner', text);
      const command = f.commands.get(f.sid, key, 'owner');
      for (const [delivery, expected] of [
        ['received', 'not_sent'],
        ['dispatching', 'uncertain'],
      ] as const) {
        f.store.db
          .prepare('UPDATE external_commands SET data=? WHERE id=?')
          .run(
            JSON.stringify({ ...command, resolvedAt: undefined, delivery }),
            key,
          );
        const recovered = new AppCommands(f.store, upstream);
        expect(recovered.get(f.sid, key, 'owner').delivery).toBe(expected);
        expect(recovered.get(f.sid, key, 'owner').reason).toBe('restart');
        await recovered.close();
      }
      expect(calls).toBe(0);
    } finally {
      await f.close();
    }
  });
  it('reauthorizes after preflight; revocation prevents dispatch and denies HTTP receipt/replay access', async () => {
    let release!: () => void,
      calls = 0;
    const upstream = source(async () => {
      calls++;
      return {};
    });
    upstream.prepareSend = async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return async () => {
        calls++;
        return {};
      };
    };
    const f = await secureFixture(upstream);
    // Internal command-service regression only: the new paired HTTP profile denies sends.
    const commands = new AppCommands(f.store, upstream);
    try {
      const sid = f.store.list('', 30, [APP_WORKSPACE]).items[0]!.id;
      const writer = await f.pair([
        {
          workspaceId: APP_WORKSPACE,
          scopes: ['session:read', 'session:write'],
        },
      ]);
      const reader = await f.pair([
        { workspaceId: APP_WORKSPACE, scopes: ['session:read'] },
      ]);
      const key = randomUUID(),
        route = `/v1/sessions/${sid}/app-commands`,
        body = { protocolVersion: 1, clientMessageId: key, text };
      expect(
        (
          await f.request(route, body, reader.pair.accessToken, {
            'Idempotency-Key': key,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await f.request(route, body, writer.pair.accessToken, {
            'Idempotency-Key': key,
          })
        ).status,
      ).toBe(403);
      const principal = f.devices.authenticate(writer.pair.accessToken);
      const authorize = () =>
        f.devices.require(principal, APP_WORKSPACE, 'session:write');
      const receipt = commands.submit(
        sid,
        key,
        writer.pair.deviceId,
        text,
        authorize,
      );
      expect(appCommandSchema.parse(receipt).delivery).toBe('received');
      expect(
        commands.submit(sid, key, writer.pair.deviceId, text, authorize)
          .delivery,
      ).toBe('received');
      expect(
        f.store.db.prepare('SELECT count(*) AS n FROM external_commands').get(),
      ).toEqual({ n: 1 });
      f.devices.revoke(writer.pair.deviceId);
      release();
      await wait(() => {
        const row = f.store.db
          .prepare('SELECT data FROM external_commands WHERE id=?')
          .get(key) as { data: string };
        return JSON.parse(row.data).delivery === 'not_sent';
      });
      expect(calls).toBe(0);
      expect(
        (await f.request(route + '/' + key, undefined, writer.pair.accessToken))
          .status,
      ).toBe(401);
      expect(
        (
          await f.request(
            `/v1/sessions/${sid}/events?after=0`,
            undefined,
            writer.pair.accessToken,
          )
        ).status,
      ).toBe(401);
    } finally {
      release?.();
      await commands.close();
      await f.close();
    }
  });
  it('does not assign concurrent desktop content to a phone intent or interrupt upstream work on post-dispatch revocation', async () => {
    const conversationId = randomUUID(),
      trajectoryId = randomUUID();
    const steps = [
      {
        index: 0,
        executionId: randomUUID(),
        role: 'user' as const,
        text: 'Initial fixture',
        done: true,
      },
    ];
    let release!: () => void;
    const upstream: AppSource = {
      conversationId,
      read: async () => ({ conversationId, trajectoryId, steps }),
      prepareSend: async () => {
        // A desktop insertion wins while the phone is preparing; equal text still proves nothing.
        steps.push({
          index: 1,
          executionId: randomUUID(),
          role: 'user',
          text,
          done: true,
        });
        return async () => {
          steps.push({
            index: 2,
            executionId: randomUUID(),
            role: 'user',
            text,
            done: true,
          });
          await new Promise<void>((r) => {
            release = r;
          });
          return {};
        };
      },
    };
    const f = await secureFixture(upstream);
    // Internal command-service regression only: the new paired HTTP profile denies sends.
    const commands = new AppCommands(f.store, upstream);
    try {
      const sid = f.store.list('', 30, [APP_WORKSPACE]).items[0]!.id;
      const paired = await f.pair([
        {
          workspaceId: APP_WORKSPACE,
          scopes: ['session:read', 'session:write'],
        },
      ]);
      const key = randomUUID(),
        route = `/v1/sessions/${sid}/app-commands`;
      expect(
        (
          await f.request(
            route,
            { protocolVersion: 1, clientMessageId: key, text },
            paired.pair.accessToken,
          )
        ).status,
      ).toBe(403);
      const principal = f.devices.authenticate(paired.pair.accessToken);
      commands.submit(sid, key, paired.pair.deviceId, text, () =>
        f.devices.require(principal, APP_WORKSPACE, 'session:write'),
      );
      await wait(() => !!release);
      f.devices.revoke(paired.pair.deviceId);
      release();
      await wait(() => {
        const row = f.store.db
          .prepare('SELECT data FROM external_commands WHERE id=?')
          .get(key) as { data: string };
        return JSON.parse(row.data).delivery === 'acknowledged';
      });
      f.store.projectExternal(APP_WORKSPACE, await upstream.read(), true);
      expect(
        f.store.snapshot(sid).messages.filter((m) => m.text === text),
      ).toHaveLength(2);
      const row = f.store.db
        .prepare('SELECT data FROM external_commands WHERE id=?')
        .get(key) as { data: string };
      expect(JSON.parse(row.data).observedResult).toBe('not_correlated');
      expect(
        (await f.request(route + '/' + key, undefined, paired.pair.accessToken))
          .status,
      ).toBe(401);
      expect(f.store.snapshot(sid).runs).toEqual([]);
    } finally {
      release?.();
      await commands.close();
      await f.close();
    }
  });
  it('uses one strictly verified HTTPS send, no client correlation guess, no TLS fallback or retry after lost acknowledgement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pocket-send-tls-')),
      tls = certificates(dir);
    let calls = 0,
      drop = false;
    const server = createServer(tls, (req, res) => {
      calls++;
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        expect(req.url).toBe(
          '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
        );
        expect(req.headers['x-codeium-csrf-token']).toBe(
          'local-fixture-secret',
        );
        expect(JSON.parse(body)).toEqual({
          cascadeId: config.conversationId,
          metadata: {
            ideName: 'antigravity-pocket-experimental',
            ideVersion: '0.1.0',
            extensionVersion: '0.1.0',
          },
          items: [{ text }],
        });
        if (drop) {
          req.socket.destroy();
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            cascadeId: config.conversationId,
            executionStatus: 'CORTEX_EXECUTION_STATUS_RUNNING',
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('address');
    const config = {
      enabled: true as const,
      version: '2.29.0' as const,
      pid: 1,
      port: address.port,
      conversationId: randomUUID(),
    };
    try {
      await expect(
        sendAppText(
          config,
          'local-fixture-secret',
          Buffer.from('invalid'),
          text,
        ),
      ).rejects.toBeTruthy();
      expect(calls).toBe(0);
      expect(
        (await sendAppText(config, 'local-fixture-secret', tls.ca, text))
          .cascadeId,
      ).toBe(config.conversationId);
      drop = true;
      await expect(
        sendAppText(config, 'local-fixture-secret', tls.ca, text),
      ).rejects.toMatchObject({ code: 'transport_failed' });
      expect(calls).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
