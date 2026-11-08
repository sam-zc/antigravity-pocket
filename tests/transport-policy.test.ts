import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { z } from '@pocket/protocol';
import { wire } from '../apps/mobile/src/services/wire';
it('refuses HTTP redirects before forwarding a POST body and enforces response byte caps', async () => {
  let leaked = 0,
    aborted = false;
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(307, { Location: '/sink' });
      res.end();
    } else if (req.url === '/sink') {
      leaked++;
      res.end('{}');
    } else if (req.url === '/large') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': '99999999',
      });
      res.write('{');
      req.on('close', () => {
        aborted = true;
      });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await expect(
      wire(origin, '/redirect', z.object({}), { canary: 'one-use-test-body' }),
    ).rejects.toThrow();
    expect(leaked).toBe(0);
    await expect(wire(origin, '/large', z.object({}))).rejects.toThrow('limit');
    await new Promise((r) => setTimeout(r, 25));
    expect(aborted).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
