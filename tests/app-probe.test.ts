import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { certificates } from './secure-helpers.js';
import {
  probeHistory,
  readAppSteps,
  type ProbeConfig,
} from '../services/gateway/src/experimental/app-probe.js';
import { runAppProbe } from '../services/gateway/src/experimental/app-runtime.js';

describe('isolated App compatibility probe (fixtures, not live App proof)', () => {
  let directory: string;
  let tls: ReturnType<typeof certificates>;
  let server: Server;
  let config: ProbeConfig;
  let mode = 'success';
  let expectedOffset = 0;
  let received = 0;
  const secret = 'fixture-csrf-never-in-diagnostics';
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'pocket-probe-'));
    tls = certificates(directory);
    server = createServer(tls, (req, res) => {
      received++;
      expect(req.method).toBe('POST');
      expect(req.url).toBe(
        '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps',
      );
      expect(req.headers['x-codeium-csrf-token']).toBe(secret);
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        expect(JSON.parse(body)).toEqual({
          cascadeId: config.conversationId,
          stepOffset: expectedOffset,
        });
        if (mode === 'timeout') return;
        if (mode === 'empty') {
          res.setHeader('content-type', 'application/json');
          res.end('{}');
          return;
        }
        if (mode === 'redirect') {
          res.writeHead(302, { Location: 'https://127.0.0.1:1/secret' });
          res.end(secret);
          return;
        }
        if (mode === 'auth') {
          res.writeHead(401);
          res.end(secret);
          return;
        }
        res.setHeader('content-type', 'application/json');
        if (mode === 'oversize') {
          res.end(' '.repeat(65537) + secret);
          return;
        }
        if (mode === 'malformed') {
          res.end(secret);
          return;
        }
        if (mode === 'shape') {
          res.end(JSON.stringify({ steps: [secret] }));
          return;
        }
        res.end(
          JSON.stringify({
            steps: [{ privateContent: secret }],
            unknown: secret,
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('fixture address unavailable');
    config = {
      enabled: true,
      version: '2.29.0',
      pid: 1,
      port: address.port,
      conversationId: '539a401e-fd2a-49c1-a1e9-b97c73ad3bd8',
    };
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  it('is disabled without opt-in, ignoring invalid owner configuration', async () => {
    expect(await runAppProbe({ POCKET_APP_PID: 'invalid' })).toEqual({
      status: 'disabled',
    });
  });
  it('rejects unknown versions and endpoint configuration before connecting', async () => {
    const before = received;
    await expect(
      runAppProbe({
        POCKET_EXPERIMENTAL_APP_PROBE: '1',
        POCKET_APP_VERSION: 'future',
      }),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    await expect(
      probeHistory({ ...config, port: 0 }, secret, tls.ca),
    ).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(received).toBe(before);
  });
  it('rejects an untrusted server before sending the credential; never downgrades', async () => {
    const before = received;
    await expect(probeHistory(config, secret)).rejects.toMatchObject({
      code: 'tls_trust_failed',
    });
    expect(received).toBe(before);
  });
  it('uses verified owner trust and returns only bounded metadata, not raw history', async () => {
    mode = 'success';
    const result = await probeHistory(config, secret, tls.ca);
    expect(result).toEqual({ stepCount: 1, complete: false });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('sends a bounded exact offset and accepts protobuf empty steps without claiming complete history', async () => {
    mode = 'empty';
    expectedOffset = 16;
    expect(await readAppSteps(config, secret, tls.ca, 16)).toEqual({
      steps: [],
    });
    expectedOffset = 0;
    const before = received;
    for (const offset of [-1, 1.5, 2001])
      await expect(
        readAppSteps(config, secret, tls.ca, offset),
      ).rejects.toMatchObject({ code: 'invalid_offset' });
    expect(received).toBe(before);
  });
  it.each([
    ['redirect', 'upstream_http_rejected'],
    ['auth', 'upstream_auth_rejected'],
    ['oversize', 'response_limit'],
    ['malformed', 'incompatible_response'],
    ['shape', 'incompatible_response'],
    ['timeout', 'timeout'],
  ])(
    'rejects %s once without exposing upstream content',
    async (nextMode, code) => {
      mode = nextMode;
      const before = received;
      let failure: unknown;
      try {
        await probeHistory(config, secret, tls.ca);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code, message: code });
      expect(String(failure)).not.toContain(secret);
      expect(received).toBe(before + 1);
    },
  );
});
