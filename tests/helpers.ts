import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Store } from '../services/gateway/src/db/store.js';
import { buildApp } from '../services/gateway/src/app.js';
import { MockAdapter } from '../services/gateway/src/adapters/mock.js';
import {
  WORKSPACE_ID,
  type ServerFrame,
  serverFrameSchema,
} from '@pocket/protocol';
export async function fixture(
  options: {
    delay?: number;
    realtime?: Parameters<typeof buildApp>[0]['realtime'];
    auth?: Parameters<typeof buildApp>[0]['auth'];
    directory?: string;
  } = {},
) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'pocket-'));
  const store = new Store(join(directory, 'db.sqlite'));
  const runtime = await buildApp({
    store,
    adapter: new MockAdapter(options.delay ?? 3),
    realtime: options.realtime,
    auth: options.auth,
  });
  const origin = await runtime.app.listen({ host: '127.0.0.1', port: 0 });
  async function request(
    path: string,
    body?: unknown,
    key = randomUUID(),
    headers: Record<string, string> = {},
  ) {
    return fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${runtime.auth.token}`,
        ...(body === undefined
          ? {}
          : { 'Content-Type': 'application/json', 'Idempotency-Key': key }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function create(title = 'Test session', key?: string) {
    const response = await request(
      '/v1/sessions',
      {
        protocolVersion: 1,
        title,
        workspaceId: WORKSPACE_ID,
        adapterId: 'mock',
      },
      key,
    );
    return { response, receipt: await response.json() };
  }
  async function prompt(sessionId: string, text = 'Hello', key = randomUUID()) {
    const response = await request(
      `/v1/sessions/${sessionId}/messages`,
      { protocolVersion: 1, clientMessageId: key, text },
      key,
    );
    return { response, receipt: await response.json() };
  }
  async function socket() {
    const { ticket } = await (await request('/v1/auth/ws-ticket', {})).json();
    const ws = new WebSocket(
      origin.replace('http:', 'ws:') + '/v1/events?ticket=' + ticket,
    );
    const frames: ServerFrame[] = [];
    ws.on('message', (raw) =>
      frames.push(serverFrameSchema.parse(JSON.parse(raw.toString()))),
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return {
      ws,
      frames,
      subscribe: (sid: string, after: number) =>
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            protocolVersion: 1,
            streamId: `session:${sid}`,
            after,
          }),
        ),
    };
  }
  async function close(remove = true) {
    runtime.realtime.close();
    await runtime.app.close();
    store.close();
    if (remove) rmSync(directory, { recursive: true, force: true });
  }
  return {
    ...runtime,
    origin,
    directory,
    store,
    request,
    create,
    prompt,
    socket,
    close,
  };
}
export async function until(
  check: () => boolean | Promise<boolean>,
  timeout = 5000,
) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error('Condition timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
