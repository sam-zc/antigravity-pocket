import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
} from 'react';
import { AppState } from 'react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { create } from 'zustand';
import { z, type TokenPair, type Snapshot } from '@pocket/protocol';
import { requireSecureNative } from './native-security';
import { Api, ApiError } from './api';
import {
  CredentialVault,
  PairedCredentials,
  type SavedCredential,
} from './credentials';
import { Cache } from './cache';
import { SessionSync, type ConnectionState } from './session-sync';

export const useConnection = create<{
  state: ConnectionState;
  snapshot: Snapshot | null;
  setState: (state: ConnectionState) => void;
  setSnapshot: (snapshot: Snapshot | null) => void;
}>((set) => ({
  state: 'offline',
  snapshot: null,
  setState: (state) =>
    set(
      ['auth-required', 'storage-error'].includes(state)
        ? { state, snapshot: null }
        : { state },
    ),
  setSnapshot: (snapshot) => set({ snapshot }),
}));
type Runtime = { api: Api; cache: Cache; gatewayId: string; epoch?: number };
const Context = createContext<{
  runtime: Runtime | null;
  notice: string;
  restoring: boolean;
  paired: (origin: string, gatewayId: string, pair: TokenPair) => Promise<void>;
  connect: (origin: string, token: string) => Promise<void>;
  disconnect: () => Promise<void>;
  reauthenticate: () => void;
  activate: (id: string | null) => void;
  retry: () => void;
} | null>(null);
export function PocketProvider({ children }: { children: React.ReactNode }) {
  const [query] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 2000 } },
      }),
  );
  const [notice, setNotice] = useState('');
  const [restoring, setRestoring] = useState(true);
  const generation = useRef(0);
  const activeSync = useRef<SessionSync | null>(null);
  const loggingOut = useRef(false);
  const vault = useRef(new CredentialVault()).current;
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [session, activate] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [foreground, setForeground] = useState(
    AppState.currentState === 'active',
  );
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) =>
      setForeground(state === 'active'),
    );
    return () => listener.remove();
  }, []);
  useEffect(() => {
    useConnection.getState().setSnapshot(null);
    if (!runtime || !session || !foreground) {
      useConnection.getState().setState('offline');
      return;
    }
    const sync = new SessionSync(
      runtime.api,
      runtime.cache,
      session,
      useConnection.getState().setSnapshot,
      useConnection.getState().setState,
    );
    activeSync.current = sync;
    void sync.start();
    return () => {
      sync.stop();
      if (activeSync.current === sync) activeSync.current = null;
    };
  }, [runtime, session, foreground, attempt]);
  function retireRuntime() {
    activeSync.current?.stop();
    runtime?.cache.retire();
    setRuntime(null);
    query.clear();
    useConnection.getState().setSnapshot(null);
  }
  async function openPaired(saved: SavedCredential, pair?: TokenPair) {
    requireSecureNative();
    const turn = ++generation.current;
    retireRuntime();
    const credential = new PairedCredentials(saved, vault);
    if (pair) credential.seed(pair);
    const api = new Api(saved.origin, '', credential);
    const namespace = saved.gatewayId + ':' + saved.deviceId;
    let cache = await Cache.open(namespace);
    if (turn !== generation.current) return;
    let bootstrap;
    try {
      bootstrap = await api.bootstrap();
    } catch (error) {
      if (
        turn === generation.current &&
        error instanceof ApiError &&
        [401, 403].includes(error.status)
      )
        await cache.purge();
      throw error;
    }
    if (turn !== generation.current) return;
    if (
      bootstrap.gatewayId !== saved.gatewayId ||
      bootstrap.device?.deviceId !== saved.deviceId
    ) {
      await credential.clear();
      await cache.purge();
      throw new Error('Gateway identity mismatch');
    }
    if (turn !== generation.current) return;
    if (saved.grantRevision !== bootstrap.device.grantRevision) {
      await cache.purge(true);
      cache = await Cache.open(namespace);
    }
    if (turn !== generation.current) return;
    await credential.revision(bootstrap.device.grantRevision);
    if (turn !== generation.current) return;
    let revision = bootstrap.device.grantRevision;
    api.onInvalid = async (code) => {
      if (turn !== generation.current) return;
      generation.current++;
      setRuntime(null);
      activate(null);
      query.clear();
      useConnection.getState().setSnapshot(null);
      setNotice(
        code === 'device_revoked'
          ? 'This device was revoked. Ask the desktop owner for a new invitation.'
          : 'Session expired or renewal was not confirmed. Revoke this device on desktop and pair again.',
      );
      await cache.purge();
    };
    api.beforeSync = async () => {
      if (turn !== generation.current) throw new Error('Connection changed');
      const latest = await api.bootstrap();
      if (turn !== generation.current) throw new Error('Connection changed');
      if (
        latest.gatewayId !== saved.gatewayId ||
        latest.device?.deviceId !== saved.deviceId
      ) {
        await api.invalidate('identity_changed');
        throw new Error('Identity changed');
      }
      if (latest.device.grantRevision !== revision) {
        revision = latest.device.grantRevision;
        activeSync.current?.stop();
        useConnection.getState().setSnapshot(null);
        await cache.purge(true);
        cache = await Cache.open(namespace);
        if (turn !== generation.current) throw new Error('Connection changed');
        await credential.revision(revision);
        if (turn !== generation.current) throw new Error('Connection changed');
        query.clear();
        setRuntime((previous) =>
          previous?.api === api
            ? { ...previous, cache, epoch: revision }
            : previous,
        );
        useConnection.getState().setSnapshot(null);
        setNotice(
          'Desktop permissions changed. Cached history and unsent drafts were cleared. Pending send protection was retained.',
        );
        throw new Error('Permissions changed; replaced sync runtime');
      }
    };
    query.clear();
    setRuntime({ api, cache, gatewayId: saved.gatewayId, epoch: revision });
    setNotice('');
  }
  async function paired(origin: string, gatewayId: string, pair: TokenPair) {
    if (loggingOut.current) throw new Error('Logout is in progress');
    const saved: SavedCredential = {
      origin,
      gatewayId,
      deviceId: pair.deviceId,
      refresh: pair.refreshToken,
      installation: await vault.marker(),
      pending: false,
      grantRevision: pair.grantRevision,
    };
    await vault.save(saved);
    await openPaired(saved, pair);
  }
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const saved = await vault.load();
        if (saved && mounted) await openPaired(saved);
        else if (mounted && vault.resetRequired) await Cache.purgeAll();
      } catch {
        if (mounted)
          setNotice(
            'Saved session could not be restored. Check the private network and trusted certificate, or revoke the old device on desktop and pair again.',
          );
      } finally {
        if (mounted) setRestoring(false);
      }
    })();
    return () => {
      mounted = false;
      generation.current++;
    };
    // One installation bootstrap; later lifecycle transitions belong to SessionSync.
  }, []);
  async function connect(origin: string, token: string) {
    if (loggingOut.current) throw new Error('Logout is in progress');
    const turn = ++generation.current;
    retireRuntime();
    const api = new Api(origin, token.trim());
    const bootstrap = await api.bootstrap();
    if (turn !== generation.current) return;
    const cache = await Cache.open(bootstrap.gatewayId);
    if (turn !== generation.current) {
      cache.retire();
      return;
    }
    query.clear();
    setRuntime({ api, cache, gatewayId: bootstrap.gatewayId });
  }
  async function disconnect() {
    if (loggingOut.current) return;
    loggingOut.current = true;
    setRestoring(true);
    generation.current++;
    activeSync.current?.stop();
    const cache = runtime?.cache;
    const api = runtime?.api;
    setRuntime(null);
    activate(null);
    query.clear();
    useConnection.getState().setSnapshot(null);
    let revoked = true,
      cleanupFailed = false;
    try {
      if (api?.credential)
        await api.request(
          '/v1/auth/logout',
          z.object({ ok: z.literal(true) }),
          {},
        );
    } catch {
      revoked = false;
    } finally {
      const results = await Promise.allSettled([
        api?.credential?.clear(),
        vault.clear(),
        cache?.purge(),
      ]);
      if (results.some((r) => r.status === 'rejected')) {
        setNotice(
          'Disconnected, but local cleanup failed. Clear app data before sharing this device; revoke it from the desktop.',
        );
        cleanupFailed = true;
      }
    }
    loggingOut.current = false;
    setRestoring(false);
    if (cleanupFailed) throw new Error('Local cleanup failed');
    setNotice(
      revoked
        ? 'Disconnected and local data cleared.'
        : 'Local credentials cleared. Server revocation is pending: ask the desktop owner to revoke this device with the admin CLI.',
    );
    setRuntime(null);
    activate(null);
    query.clear();
  }
  function reauthenticate() {
    if (runtime?.api.credential) {
      void disconnect();
      return;
    }
    generation.current++;
    retireRuntime();
    // Rotate the development credential without discarding replay state or drafts.
  }
  return (
    <QueryClientProvider client={query}>
      <Context.Provider
        value={{
          runtime,
          notice,
          restoring,
          paired,
          connect,
          disconnect,
          reauthenticate,
          activate,
          retry: () => setAttempt((n) => n + 1),
        }}
      >
        {children}
      </Context.Provider>
    </QueryClientProvider>
  );
}
export function usePocket() {
  const value = useContext(Context);
  if (!value) throw new Error('Missing PocketProvider');
  return value;
}
