import { StorageError } from './storage-error';
import {
  serverFrameSchema,
  utf8Bytes,
  type ServerFrame,
  type Snapshot,
} from '@pocket/protocol';
import { Api, ApiError } from './api';
import type { SessionCache } from './cache';
export type ConnectionState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline'
  | 'auth-required'
  | 'incompatible'
  | 'storage-error';
export class SessionSync {
  private socket?: WebSocket;
  private stopped = false;
  private generation = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private attempt = 0;
  constructor(
    private api: Api,
    private cache: SessionCache,
    private id: string,
    private onSnapshot: (snapshot: Snapshot) => void,
    private onState: (state: ConnectionState) => void,
    private makeSocket = (url: string) => new WebSocket(url),
  ) {}
  async start() {
    const generation = ++this.generation;
    this.stopped = false;
    this.onState(this.attempt ? 'reconnecting' : 'connecting');
    try {
      await this.api.beforeSync();
      // Every connection revalidates selected-source authority before publishing refreshed content.
      const fresh = await this.api.snapshot(this.id);
      if (this.stopped || generation !== this.generation) return;
      const cached = await this.cache.load(this.id);
      if (this.stopped || generation !== this.generation) return;
      const snapshot =
        cached &&
        cached.through <= fresh.through &&
        cached.session.external?.send === fresh.session.external?.send &&
        cached.session.external?.readOnly === fresh.session.external?.readOnly
          ? cached
          : fresh;
      if (snapshot === fresh) await this.cache.replace(snapshot);
      if (this.stopped || generation !== this.generation) return;
      this.onSnapshot(snapshot);
      const { ticket } = await this.api.ticket();
      if (this.stopped || generation !== this.generation) return;
      const socket = this.makeSocket(
        `${this.api.origin.replace(/^http/, 'ws')}/v1/events?ticket=${ticket}`,
      );
      this.socket = socket;
      const queue: { frame: ServerFrame; bytes: number }[] = [];
      let bufferedBytes = 0;
      let draining = false;
      let closed = false;
      const current = () =>
        !closed && !this.stopped && generation === this.generation;
      let lastFrame = Date.now();
      const connectedAt = Date.now();
      this.watchdog = setInterval(() => {
        if (Date.now() - lastFrame > 60000) socket.close();
      }, 10000);
      socket.onopen = () =>
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            protocolVersion: 1,
            streamId: snapshot!.streamId,
            after: snapshot!.through,
          }),
        );
      const drain = async () => {
        if (draining) return;
        draining = true;
        try {
          while (queue.length && current()) {
            const item = queue.shift()!;
            let consumedBytes = item.bytes;
            const frame = item.frame;
            try {
              if (frame.type === 'resync.required') {
                const fresh = await this.api.snapshot(this.id);
                if (!current()) return;
                await this.cache.replace(fresh);
                if (!current()) return;
                this.onSnapshot(fresh);
                if (socket.readyState === 1)
                  socket.send(
                    JSON.stringify({
                      type: 'subscribe',
                      protocolVersion: 1,
                      streamId: fresh.streamId,
                      after: fresh.through,
                    }),
                  );
              } else if (frame.type === 'subscription.ready') {
                this.onState('live');
              } else if (
                'sequence' in frame &&
                frame.type !== 'device.changed'
              ) {
                const events = [frame];
                if (this.cache.applyBatch) {
                  while (events.length < 200 && queue.length) {
                    const next = queue[0]!.frame;
                    if (!('sequence' in next) || next.type === 'device.changed')
                      break;
                    events.push(next);
                    consumedBytes += queue.shift()!.bytes;
                  }
                }
                const next = this.cache.applyBatch
                  ? await this.cache.applyBatch(this.id, events)
                  : await this.cache.apply(this.id, frame);
                if (!current()) return;
                this.onSnapshot(next);
                if (socket.readyState === 1)
                  socket.send(
                    JSON.stringify({
                      type: 'ack',
                      streamId: next.streamId,
                      through: next.through,
                    }),
                  );
              }
            } finally {
              bufferedBytes = Math.max(0, bufferedBytes - consumedBytes);
            }
          }
        } catch {
          if (!current()) return;
          queue.length = 0;
          bufferedBytes = 0;
          this.onState('reconnecting');
          try {
            const fresh = await this.api.snapshot(this.id);
            if (!current()) return;
            await this.cache.replace(fresh);
          } catch (error) {
            if (
              current() &&
              error instanceof ApiError &&
              [401, 403, 404].includes(error.status)
            ) {
              await this.deny();
              return;
            }
          }
          socket.close();
        } finally {
          draining = false;
        }
      };
      socket.onmessage = ({ data }) => {
        if (!current()) return;
        lastFrame = Date.now();
        const raw = String(data);
        const bytes = utf8Bytes(raw);
        const overflow = () => {
          closed = true;
          queue.length = 0;
          bufferedBytes = 0;
          socket.close();
        };
        if (bytes > 131072 || bufferedBytes + bytes > 1048576) {
          overflow();
          return;
        }
        let frame: ServerFrame;
        try {
          frame = serverFrameSchema.parse(JSON.parse(raw));
        } catch {
          this.stop();
          this.onState('incompatible');
          return;
        }
        // Heartbeats must not wait behind native SQLite replay transactions.
        if (frame.type === 'connection.ping') {
          if (socket.readyState === 1)
            socket.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (queue.length >= 1000) {
          overflow();
          return;
        }
        bufferedBytes += bytes;
        queue.push({ frame, bytes });
        void drain();
      };
      socket.onerror = () => socket.close();
      socket.onclose = (event) => {
        closed = true;
        queue.length = 0;
        if (this.watchdog) clearInterval(this.watchdog);
        if (this.stopped || generation !== this.generation) return;
        if (this.api.credential && event.code === 4004) {
          void this.api.invalidate('device_revoked').catch(() => {
            if (!this.stopped && generation === this.generation)
              this.onState('storage-error');
          });
          this.onState('auth-required');
          return;
        }
        if (event.code === 4003) {
          // Withdraw visible content immediately; never replay a denied cached source.
          this.stop();
          this.onState('auth-required');
          const retiredGeneration = this.generation;
          void (async () => {
            try {
              await this.cache.remove(this.id);
              if (this.api.credential && this.generation === retiredGeneration)
                await this.start(); // beforeSync rechecks grant revision before cache load
            } catch {
              if (this.generation === retiredGeneration)
                this.onState('storage-error');
              // Remain closed if local cleanup fails; explicit reconnection is required.
            }
          })();
          return;
        }
        if (this.api.credential && event.code === 4001) {
          this.schedule();
          return;
        }
        if (event.code === 4001) {
          this.onState('auth-required');
          return;
        }
        if (Date.now() - connectedAt >= 30000) this.attempt = 0;
        this.schedule();
      };
    } catch (error) {
      if (this.stopped || generation !== this.generation) return;
      if (error instanceof StorageError) {
        this.stop();
        this.onState('storage-error');
        return;
      }
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        await this.deny();
        return;
      }
      // This runtime already authenticated at bootstrap. Offline cache is never a cold-start credential.
      if (
        error instanceof TypeError ||
        (error instanceof Error && error.name === 'AbortError') ||
        (error instanceof ApiError &&
          (error.status >= 500 || error.code === 'network_unavailable'))
      ) {
        try {
          const cached = await this.cache.load(this.id);
          if (this.stopped || generation !== this.generation) return;
          if (cached) this.onSnapshot(cached);
        } catch {
          this.onState('storage-error');
          return;
        }
      }
      this.schedule(error instanceof ApiError ? error.retryAfterMs : 0);
    }
  }
  private async deny() {
    this.stop();
    const retired = this.generation;
    this.onState('auth-required');
    try {
      await this.cache.remove(this.id);
    } catch {
      if (retired === this.generation) this.onState('storage-error');
    }
  }
  private schedule(minimum = 0) {
    this.onState('reconnecting');
    const delay = Math.max(
      minimum,
      Math.random() * Math.min(30000, 500 * 2 ** Math.min(this.attempt++, 8)),
    );
    this.retry = setTimeout(() => {
      void this.start();
    }, delay);
  }
  stop() {
    this.stopped = true;
    this.generation++;
    if (this.retry) clearTimeout(this.retry);
    if (this.watchdog) clearInterval(this.watchdog);
    this.socket?.close();
    this.socket = undefined;
  }
}
