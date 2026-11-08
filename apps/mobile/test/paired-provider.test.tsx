import React from 'react';
import {
  act,
  render,
  screen,
  waitFor,
  fireEvent,
} from '@testing-library/react-native';
import { PocketProvider, usePocket } from '../src/services/PocketProvider';
import Database from 'better-sqlite3';
import { Cache } from '../src/services/cache';
import { Text, Button } from '../src/components/ui/primitives';
jest.mock('../src/services/native-security', () => ({
  requireSecureNative: () => {},
}));
const mockPurge = jest.spyOn(Cache.prototype, 'purge'),
  mockSave = jest.fn(async () => {}),
  mockClear = jest.fn(async () => {});
let mockDevice = 'device';
let mockOffline = false,
  mockRevision = 2;
let mockDatabase: Database.Database;
let mockRuntime: ReturnType<typeof usePocket>['runtime'];
const mockSaved = {
  origin: 'https://desktop.example',
  gatewayId: 'gateway',
  deviceId: 'device',
  refresh: 'private',
  installation: 'install',
  pending: false,
  grantRevision: 1,
};
jest.mock('../src/services/credentials', () => ({
  CredentialVault: class {
    async load() {
      return { ...mockSaved };
    }
    save = mockSave;
    clear = mockClear;
  },
  PairedCredentials: class {
    clear = mockClear;
    revision = mockSave;
  },
}));
jest.mock('../src/services/api', () => ({
  Api: class {
    credential = { clear: mockClear };
    onInvalid: (code: string) => Promise<void> = async () => {};
    async invalidate(code: string) {
      await mockClear();
      await this.onInvalid(code);
    }
    beforeSync = async () => {};
    async bootstrap() {
      return {
        gatewayId: 'gateway',
        device: { deviceId: mockDevice, grantRevision: mockRevision },
      };
    }
    async request() {
      if (mockOffline) throw new Error('offline');
      return { ok: true };
    }
  },
}));
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    const sql = mockDatabase;
    const db = {
      execAsync: async (query: string) => {
        sql.exec(query);
      },
      runAsync: async (query: string, ...args: unknown[]) =>
        sql.prepare(query).run(...args),
      getFirstAsync: async (query: string, ...args: unknown[]) =>
        sql.prepare(query).get(...args) ?? null,
      withExclusiveTransactionAsync: async (
        operation: (tx: unknown) => Promise<void>,
      ) => {
        sql.exec('BEGIN IMMEDIATE');
        try {
          await operation(db);
          sql.exec('COMMIT');
        } catch (error) {
          sql.exec('ROLLBACK');
          throw error;
        }
      },
    };
    return db;
  },
}));
function Status() {
  const p = usePocket();
  mockRuntime = p.runtime;
  return (
    <>
      <Text>{p.runtime ? 'Connected' : 'Disconnected'}</Text>
      <Text>{p.notice}</Text>
      <Button
        label="Log out"
        onPress={() => {
          void p.disconnect();
        }}
      />
    </>
  );
}
beforeEach(() => {
  mockDevice = 'device';
  mockOffline = false;
  mockRevision = 2;
  mockDatabase = new Database(':memory:');
  jest.clearAllMocks();
});
afterEach(() => mockDatabase.close());
it('purges old cached ACL epoch before exposing a restored paired runtime', async () => {
  await render(
    <PocketProvider>
      <Status />
    </PocketProvider>,
  );
  await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
  expect(mockPurge).toHaveBeenCalledTimes(1);
  expect(mockSave).toHaveBeenCalled();
  await mockRuntime!.cache.saveDraft('session', 'Current epoch draft');
  expect((await mockRuntime!.cache.draft('session')).text).toBe(
    'Current epoch draft',
  );
});
it('offline logout clears local credentials/cache and explicitly reports pending server revocation', async () => {
  await render(
    <PocketProvider>
      <Status />
    </PocketProvider>,
  );
  await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
  mockOffline = true;
  await fireEvent.press(screen.getByRole('button', { name: 'Log out' }));
  await waitFor(() =>
    expect(screen.getByText(/Server revocation is pending/)).toBeTruthy(),
  );
  expect(mockClear).toHaveBeenCalled();
  expect(mockPurge).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Disconnected')).toBeTruthy();
});

it('replaces retired cache handles when current grants change and keeps the new epoch writable', async () => {
  await render(
    <PocketProvider>
      <Status />
    </PocketProvider>,
  );
  await waitFor(() => expect(mockRuntime).not.toBeNull());
  const previous = mockRuntime!;
  await previous.cache.saveDraft('session', 'Old epoch');
  mockRevision = 3;
  await act(async () => {
    await expect(previous.api.beforeSync()).rejects.toThrow(
      'Permissions changed',
    );
  });
  await waitFor(() => expect(mockRuntime!.epoch).toBe(3));
  expect(mockRuntime!.cache).not.toBe(previous.cache);
  await expect(previous.cache.saveDraft('session', 'Retired')).rejects.toThrow(
    'retired',
  );
  expect((await mockRuntime!.cache.draft('session')).text).toBe('');
  await mockRuntime!.cache.saveDraft('session', 'Still authorized');
  expect((await mockRuntime!.cache.draft('session')).text).toBe(
    'Still authorized',
  );
});

it('retains unresolved command protection through send-scope epoch reduction and clears it on explicit logout', async () => {
  const view = await render(
    <PocketProvider>
      <Status />
    </PocketProvider>,
  );
  await waitFor(() => expect(mockRuntime).not.toBeNull());
  const old = mockRuntime!;
  await old.cache.saveDraft('session', 'Exact pending intent', 'one-shot-id');
  mockRevision = 3;
  await act(async () => {
    await expect(old.api.beforeSync()).rejects.toThrow('Permissions changed');
  });
  await waitFor(() => expect(mockRuntime!.epoch).toBe(3));
  expect(await mockRuntime!.cache.draft('session')).toEqual({
    text: 'Exact pending intent',
    command: 'one-shot-id',
  });
  await fireEvent.press(screen.getByRole('button', { name: 'Log out' }));
  await waitFor(() => expect(screen.getByText('Disconnected')).toBeTruthy());
  expect(
    (await (await Cache.open('gateway:device')).draft('session')).command,
  ).toBeNull();
  await view.unmount();
});

it('retires protected content when bootstrap changes actor identity instead of reassigning its cache', async () => {
  await render(
    <PocketProvider>
      <Status />
    </PocketProvider>,
  );
  await waitFor(() => expect(mockRuntime).not.toBeNull());
  const old = mockRuntime!;
  await old.cache.saveDraft('session', 'Actor-specific draft');
  mockDevice = 'different-device';
  await act(async () => {
    await expect(old.api.beforeSync()).rejects.toThrow('Identity changed');
  });
  await waitFor(() => expect(mockRuntime).toBeNull());
  expect((await old.cache.draft('session')).text).toBe('');
  expect(mockClear).toHaveBeenCalled();
});
