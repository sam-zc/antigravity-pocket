import { readFileSync, lstatSync } from 'node:fs';
import { isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { request } from 'node:https';
import type { FastifyRequest } from 'fastify';
import { httpsOriginSchema } from '@pocket/protocol';
import { DomainError } from '../errors.js';
export type NetworkProfile =
  | { mode: 'development' }
  | { mode: 'lan'; origin: string; host: string; cert: Buffer; key: Buffer }
  | { mode: 'serve'; origin: string; host: '127.0.0.1' };
export const loopback = (address: string | undefined) =>
  !!address && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
export function privateAddress(host: string) {
  return (
    isIP(host) === 4 &&
    (/^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^127\./.test(host))
  );
}
export function networkProfile(env: NodeJS.ProcessEnv): NetworkProfile {
  const mode = env.POCKET_PROFILE ?? 'development';
  if (mode === 'development') {
    if (env.HOST && env.HOST !== '127.0.0.1')
      throw new Error('Development gateway is loopback only');
    return { mode };
  }
  const origin = httpsOriginSchema.parse(env.POCKET_ORIGIN);
  if (mode === 'serve') {
    if (
      !new URL(origin).hostname.endsWith('.ts.net') ||
      new URL(origin).port ||
      (env.HOST && env.HOST !== '127.0.0.1')
    )
      throw new Error(
        'Serve requires a private ts.net HTTPS origin and loopback backend',
      );
    return { mode, origin, host: '127.0.0.1' };
  }
  if (mode !== 'lan' || !privateAddress(env.HOST ?? ''))
    throw new Error(
      'LAN requires an explicitly selected private IPv4 bind address',
    );
  const keyPath = env.POCKET_TLS_KEY,
    certPath = env.POCKET_TLS_CERT;
  if (!keyPath || !certPath)
    throw new Error('Trusted certificate and key paths required');
  const st = lstatSync(keyPath);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    (st.mode & 0o077) !== 0 ||
    st.uid !== process.getuid?.()
  )
    throw new Error('TLS key must be an owner-only regular file');
  return {
    mode,
    origin,
    host: env.HOST!,
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };
}
export function remoteBoundary(
  req: FastifyRequest,
  profile: Exclude<NetworkProfile, { mode: 'development' }>,
) {
  const url = new URL(profile.origin);
  if (req.headers['tailscale-funnel-request'])
    throw new DomainError(
      403,
      'public_proxy_denied',
      'Public proxying is forbidden',
    );
  const forwarded = Object.keys(req.headers).filter(
    (h) => h === 'forwarded' || h.startsWith('x-forwarded-'),
  );
  const socketOrigin =
    req.routeOptions.url === '/v1/events' &&
    req.headers.upgrade?.toLowerCase() === 'websocket' &&
    req.headers.origin === profile.origin;
  if (req.headers.host !== url.host || (req.headers.origin && !socketOrigin))
    throw new DomainError(403, 'origin_denied', 'Unexpected origin or host');
  if (profile.mode === 'lan') {
    if (
      forwarded.length ||
      !('encrypted' in req.socket && req.socket.encrypted)
    )
      throw new DomainError(403, 'tls_required', 'Direct trusted TLS required');
  } else {
    if (
      !loopback(req.socket.remoteAddress) ||
      forwarded.some(
        (h) =>
          ![
            'x-forwarded-for',
            'x-forwarded-proto',
            'x-forwarded-host',
          ].includes(h),
      ) ||
      req.headers['x-forwarded-proto'] !== 'https' ||
      (req.headers['x-forwarded-host'] &&
        req.headers['x-forwarded-host'] !== url.host)
    )
      throw new DomainError(
        403,
        'proxy_denied',
        'Only the configured loopback TLS proxy is permitted',
      );
  }
}
export async function verifyOrigin(
  origin: string,
  gatewayId: string,
  ca?: Buffer,
) {
  httpsOriginSchema.parse(origin);
  await new Promise<void>((resolve, reject) => {
    const req = request(
      origin + '/health/live',
      { ca, timeout: 5000, method: 'GET' },
      (res) => {
        let bytes = 0,
          text = '';
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024) req.destroy(new Error('Invalid health response'));
          else text += chunk.toString();
        });
        res.on('end', () => {
          try {
            const body = JSON.parse(text) as { gatewayId?: string };
            if (res.statusCode !== 200 || body.gatewayId !== gatewayId)
              throw new Error('Gateway identity mismatch');
            resolve();
          } catch {
            reject(new Error('Trusted origin does not identify this gateway'));
          }
        });
      },
    );
    req.on('timeout', () =>
      req.destroy(new Error('TLS verification timed out')),
    );
    req.on('error', () =>
      reject(new Error('Trusted TLS/hostname verification failed')),
    );
    req.end();
  });
}

export async function verifyServe(
  binary: string,
  origin: string,
  port: number,
) {
  const output = await new Promise<string>((resolve, reject) =>
    execFile(
      binary,
      ['serve', 'status', '--json'],
      { timeout: 5000, maxBuffer: 65536, encoding: 'utf8' },
      (error, stdout) =>
        error
          ? reject(new Error('Tailscale Serve status unavailable'))
          : resolve(stdout),
    ),
  );
  const config = JSON.parse(output) as {
    AllowFunnel?: Record<string, boolean>;
    TCP?: Record<string, { HTTPS?: boolean }>;
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  };
  if (Object.values(config.AllowFunnel ?? {}).some(Boolean))
    throw new Error('Public Funnel is forbidden');
  const host = new URL(origin).hostname + ':443';
  if (
    config.TCP?.['443']?.HTTPS !== true ||
    config.Web?.[host]?.Handlers?.['/']?.Proxy !== `http://127.0.0.1:${port}`
  )
    throw new Error(
      'Configure private Serve for the exact origin and loopback backend first',
    );
}
