import { expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { certificates } from './secure-helpers.js';
import { Api } from '../apps/mobile/src/services/api';
import { until } from './helpers';

it('recovers from SIGKILL through compiled startup, rotates secrets and rejects insecure listen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-process-'));
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, '127.0.0.1', resolve),
  );
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const script = resolve('services/gateway/dist/server.js');
  const origin = `http://127.0.0.1:${port}`;
  let output = '';
  let child: ChildProcess | undefined;
  const start = (host = '127.0.0.1') => {
    const p = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        HOST: host,
        PORT: String(port),
        POCKET_STATE_DIR: directory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout!.on('data', (data) => {
      output += String(data);
    });
    p.stderr!.on('data', (data) => {
      output += String(data);
    });
    return p;
  };
  const stop = async (signal: NodeJS.Signals) => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) =>
        child!.once('exit', () => resolve()),
      );
      child.kill(signal);
      await exited;
    }
  };
  try {
    child = start('0.0.0.0');
    await new Promise((resolve) => child!.once('exit', resolve));
    expect(child.exitCode).not.toBe(0);
    expect(output).toContain('Development gateway is loopback only');
    output = '';
    child = start();
    await until(async () => {
      try {
        return (await fetch(origin + '/health/live')).ok;
      } catch {
        return false;
      }
    });
    const access = JSON.parse(
      readFileSync(join(directory, 'development-access.json'), 'utf8'),
    ) as { token: string };
    const api = new Api(origin, access.token);
    expect(
      statSync(join(directory, 'development-access.json')).mode & 0o777,
    ).toBe(0o600);
    const session = await api.create('Crash recovery', randomUUID());
    const sent = await api.prompt(
      session.sessionId,
      'Survive restart',
      randomUUID(),
    );
    await until(async () =>
      (await api.snapshot(session.sessionId)).messages.some(
        (m) => m.role === 'assistant' && m.text.length > 0,
      ),
    );
    await stop('SIGKILL');
    child = start();
    await until(() => {
      const next = JSON.parse(
        readFileSync(join(directory, 'development-access.json'), 'utf8'),
      ) as { token: string };
      return next.token !== access.token;
    });
    const next = JSON.parse(
      readFileSync(join(directory, 'development-access.json'), 'utf8'),
    ) as { token: string };
    const recovered = new Api(origin, next.token);
    const snapshot = await recovered.snapshot(session.sessionId);
    expect(snapshot.runs.find((r) => r.id === sent.runId)).toMatchObject({
      state: 'failed',
      reason: 'process_restarted',
    });
    expect(snapshot.messages[1]!.text.length).toBeGreaterThan(0);
    await expect(api.sessions()).rejects.toMatchObject({ status: 401 });
    const replay = await recovered.prompt(
      session.sessionId,
      'Survive restart',
      sent.commandId,
    );
    expect(replay.runId).toBe(sent.runId);
    expect(output).not.toContain(access.token);
    expect(output).not.toContain(next.token);
    expect(output).not.toContain('Survive restart');
    await stop('SIGTERM');
  } finally {
    await stop('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

it('starts the opt-in paired read-only profile through compiled server/owner CLI without a development credential', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-pilot-startup-'));
  const tls = certificates(directory);
  chmodSync(join(directory, 'server.key'), 0o600);
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((done) => listener.close(() => done()));
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    POCKET_PROFILE: 'lan',
    POCKET_ORIGIN: `https://127.0.0.1:${port}`,
    POCKET_STATE_DIR: join(directory, 'state'),
    POCKET_TLS_KEY: join(directory, 'server.key'),
    POCKET_TLS_CERT: join(directory, 'server.pem'),
    POCKET_TLS_CA: join(directory, 'ca.pem'),
    POCKET_EXPERIMENTAL_APP_PROJECTION: '1',
    POCKET_APP_ACCESS: 'paired-read-only',
    POCKET_APP_ENROLLMENTS_FILE: '',
  };
  const child = spawn(
    process.execPath,
    [resolve('services/gateway/dist/server.js')],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout!.on('data', (data) => {
    output += String(data);
  });
  child.stderr!.on('data', (data) => {
    output += String(data);
  });
  const get = (path: string) =>
    new Promise<number>((done, reject) => {
      const req = httpsRequest(
        env.POCKET_ORIGIN + path,
        { ca: tls.ca },
        (res) => {
          res.resume();
          res.on('end', () => done(res.statusCode!));
        },
      );
      req.on('error', reject);
      req.end();
    });
  try {
    await until(async () => {
      try {
        return (await get('/health/live')) === 200;
      } catch {
        return false;
      }
    });
    expect(await get('/v1/sessions')).toBe(401);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [resolve('services/gateway/dist/cli.js'), 'app', 'status'],
      { env },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      mode: 'EXPERIMENTAL PAIRED READ-ONLY',
      sources: [],
    });
    expect(
      existsSync(join(env.POCKET_STATE_DIR, 'development-access.json')),
    ).toBe(false);
    expect(
      statSync(join(env.POCKET_STATE_DIR, 'admin.sock')).mode & 0o777,
    ).toBe(0o600);
    expect(output).not.toContain('Development credential');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((done) =>
        child.once('exit', () => done()),
      );
      child.kill('SIGTERM');
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
