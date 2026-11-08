import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  clientFrameSchema,
  serverFrameSchema,
  type ServerFrame,
  type DurableEvent,
} from '@pocket/protocol';
import { Store } from '../db/store.js';
import { Devices, type Principal } from '../security/devices.js';
import { DevelopmentAuth } from '../security/development-auth.js';
import { DomainError } from '../errors.js';

export class Realtime {
  private sockets = new Set<WebSocket>();
  private identities = new Map<WebSocket, Principal>();
  private checks = new Map<WebSocket, () => void>();
  constructor(
    private store: Store,
    private auth: DevelopmentAuth,
    private options = {
      pollMs: 40,
      maxUnacked: 1000,
      maxBytes: 1024 * 1024,
      heartbeatMs: 25000,
      deadMs: 60000,
    },
    private devices?: Devices,
    private externalAllowed: (sid: string) => boolean = () => false,
    private presentEvent: (
      event: DurableEvent,
      principal?: Principal,
    ) => DurableEvent = (event) => event,
  ) {}
  attach(socket: WebSocket, principal?: Principal) {
    const current = () => {
      if (principal) this.devices!.current(principal);
      else if (!this.auth.active()) throw new Error('Expired');
    };
    const authorize = (stream: string) => {
      current();
      if (
        stream.startsWith('session:') &&
        this.store.session(stream.slice(8)).adapterId !== 'mock' &&
        !this.externalAllowed(stream.slice(8))
      )
        throw new Error('Denied');
      if (stream.startsWith('device:')) {
        if (!principal) throw new Error('Denied');
        this.devices!.deviceEvents(principal, stream, 0);
      } else if (principal)
        this.devices!.require(
          principal,
          this.store.session(stream.slice(8)).workspaceId,
          'session:read',
        );
      else if (
        this.store.session(stream.slice(8)).workspaceId !==
          '00000000-0000-4000-8000-000000000001' &&
        !this.externalAllowed(stream.slice(8))
      )
        throw new Error('Denied');
    };
    if (this.sockets.size >= 16) {
      socket.close(1013, 'Connection limit');
      return;
    }
    this.sockets.add(socket);
    if (principal) this.identities.set(socket, principal);
    const subscriptions = new Map<
      string,
      { sent: number; ack: number; high: number; ready: boolean }
    >();
    this.checks.set(socket, () => {
      for (const stream of subscriptions.keys()) authorize(stream);
    });
    let lastPong = Date.now();
    let lastPing = Date.now();
    let frames = 0;
    const send = (frame: ServerFrame) => {
      if (socket.readyState !== 1) return false;
      try {
        current();
        if ('streamId' in frame) authorize(frame.streamId);
      } catch {
        socket.close(4003, 'Authority changed');
        return false;
      }
      const presented =
        'sessionId' in frame ? this.presentEvent(frame, principal) : frame;
      const data = JSON.stringify(serverFrameSchema.parse(presented));
      if (
        socket.bufferedAmount + Buffer.byteLength(data) >
        this.options.maxBytes
      ) {
        socket.close(1013, 'Slow consumer; replay on reconnect');
        return false;
      }
      socket.send(data);
      return true;
    };
    const pump = () => {
      try {
        current();
      } catch {
        socket.close(4001, 'Credential expired or revoked');
        return;
      }
      if (Date.now() - lastPong > this.options.deadMs) {
        socket.close(4000, 'Heartbeat timeout');
        return;
      }
      if (Date.now() - lastPing > this.options.heartbeatMs) {
        lastPing = Date.now();
        frames = 0;
        send({ type: 'connection.ping' });
      }
      for (const [streamId, sub] of subscriptions) {
        const sessionId = streamId.slice(8);
        try {
          authorize(streamId);
          const deviceStream = streamId.startsWith('device:');
          const high = sub.ready
            ? deviceStream
              ? this.devices!.watermark(principal!)
              : this.store.watermark(sessionId).high
            : sub.high;
          for (const event of deviceStream
            ? this.devices!.deviceEvents(principal!, streamId, sub.sent)
            : this.store.events(sessionId, sub.sent, high, 200)) {
            if (sub.sent - sub.ack >= this.options.maxUnacked) {
              send({
                type: 'resync.required',
                streamId,
                reason: 'slow_consumer',
              });
              socket.close(1013, 'Acknowledge durable events');
              return;
            }
            if (!send(event)) return;
            sub.sent = event.sequence;
          }
          if (!sub.ready && sub.sent === sub.high) {
            sub.ready = true;
            send({ type: 'subscription.ready', streamId, through: sub.high });
          }
        } catch (error) {
          if (
            error instanceof DomainError &&
            ['pruned', 'future_cursor'].includes(error.code)
          )
            send({
              type: 'resync.required',
              streamId,
              reason: error.code as 'pruned' | 'future_cursor',
            });
          else socket.close(1011, 'Stream unavailable');
          subscriptions.delete(streamId);
        }
      }
    };
    socket.on('message', (raw) => {
      try {
        if (++frames > 2000) {
          socket.close(1008, 'Frame rate limit');
          return;
        }
        const frame = clientFrameSchema.parse(JSON.parse(raw.toString()));
        current();
        if (frame.type === 'pong') {
          lastPong = Date.now();
          return;
        }
        if (frame.type === 'unsubscribe') subscriptions.delete(frame.streamId);
        else if (frame.type === 'ack') {
          const sub = subscriptions.get(frame.streamId);
          if (!sub || frame.through < sub.ack || frame.through > sub.sent) {
            socket.close(1008, 'Invalid acknowledgement');
            return;
          }
          sub.ack = frame.through;
        } else {
          if (subscriptions.size >= 8 && !subscriptions.has(frame.streamId)) {
            socket.close(1008, 'Subscription limit');
            return;
          }
          // No await: registration and high-water capture are serialized with synchronous DB commits.
          authorize(frame.streamId);
          const high = frame.streamId.startsWith('device:')
            ? this.devices!.watermark(principal!)
            : this.store.watermark(frame.streamId.slice(8)).high;
          subscriptions.set(frame.streamId, {
            sent: frame.after,
            ack: frame.after,
            high,
            ready: false,
          });
        }
        pump();
      } catch {
        socket.close(1008, 'Invalid or inaccessible frame');
      }
    });
    socket.on('error', () => socket.terminate());
    const timer = setInterval(pump, this.options.pollMs);
    socket.on('close', () => {
      clearInterval(timer);
      subscriptions.clear();
      this.sockets.delete(socket);
      this.identities.delete(socket);
      this.checks.delete(socket);
    });
    send({
      type: 'connection.ready',
      protocolVersion: 1,
      connectionId: randomUUID(),
    });
  }
  invalidate(device: string, code: number) {
    for (const [socket, p] of this.identities)
      if (p.device === device) socket.close(code, 'Authority changed');
  }
  reauthorize() {
    for (const [socket, check] of this.checks) {
      try {
        check();
      } catch {
        socket.close(4003, 'Authority changed');
      }
    }
  }
  close() {
    for (const socket of this.sockets) socket.terminate();
  }
}
