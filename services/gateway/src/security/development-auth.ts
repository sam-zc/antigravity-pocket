import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { DomainError } from '../errors.js';
import { hash } from '../db/store.js';
export class DevelopmentAuth {
  readonly token = randomBytes(32).toString('hex');
  readonly expiresAt: number;
  private tickets = new Map<string, number>();
  constructor(lifetimeMs = 8 * 60 * 60 * 1000) {
    this.expiresAt = Date.now() + lifetimeMs;
  }
  active() {
    return Date.now() < this.expiresAt;
  }
  boundary(request: FastifyRequest) {
    const remote = request.socket.remoteAddress;
    // React Native Android supplies this Origin automatically. It is only a
    // transport compatibility check; a one-use authenticated ticket is still required.
    const nativeSocketOrigin =
      request.routeOptions.url === '/v1/events' &&
      request.headers.upgrade?.toLowerCase() === 'websocket' &&
      request.headers.origin === `http://${request.headers.host}`;
    if (remote && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote))
      throw new DomainError(
        403,
        'loopback_only',
        'Development access requires loopback',
      );
    if (
      !/^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host ?? '') ||
      (request.headers.origin && !nativeSocketOrigin) ||
      Object.keys(request.headers).some(
        (h) => h === 'forwarded' || h.startsWith('x-forwarded-'),
      )
    )
      throw new DomainError(
        403,
        'origin_denied',
        'Browser and proxy access are disabled in Phase 1',
      );
  }
  authorize(request: FastifyRequest) {
    const supplied = /^Bearer [a-f0-9]{64}$/.test(
      request.headers.authorization ?? '',
    )
      ? request.headers.authorization!.slice(7)
      : '';
    if (
      !this.active() ||
      !timingSafeEqual(
        Buffer.from(hash(supplied)),
        Buffer.from(hash(this.token)),
      )
    )
      throw new DomainError(
        401,
        'development_auth',
        'Enter the current desktop development credential',
      );
  }
  ticket() {
    for (const [key, expiry] of this.tickets)
      if (expiry <= Date.now()) this.tickets.delete(key);
    if (this.tickets.size >= 64)
      throw new DomainError(
        429,
        'ticket_capacity',
        'Too many connection attempts',
      );
    const ticket = randomBytes(32).toString('hex');
    const expiresAt = Math.min(this.expiresAt, Date.now() + 30000);
    this.tickets.set(hash(ticket), expiresAt);
    return { ticket, expiresAt };
  }
  consume(ticket: string) {
    const key = hash(ticket);
    const expiry = this.tickets.get(key);
    this.tickets.delete(key);
    if (!this.active() || !expiry || expiry <= Date.now())
      throw new DomainError(
        401,
        'ticket_invalid',
        'Connection ticket expired or consumed',
      );
  }
}
