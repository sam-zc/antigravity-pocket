import {
  CredentialVault,
  PairedCredentials,
  type SavedCredential,
} from '../src/services/credentials';
import * as SecureStore from 'expo-secure-store';
import { wire, ApiError } from '../src/services/wire';
const mockId = '11111111-1111-4111-8111-111111111111';
let mockMarker: string | null = mockId;
let mockStored: string | null = null;
jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: jest.fn(async () => mockStored),
  setItemAsync: jest.fn(async (_key: string, value: string) => {
    mockStored = value;
  }),
  deleteItemAsync: jest.fn(async () => {
    mockStored = null;
  }),
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => mockId }));
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => ({
    execAsync: async () => {},
    getFirstAsync: async () => (mockMarker ? { id: mockMarker } : null),
    runAsync: async (_sql: string, id: string) => {
      mockMarker = id;
    },
  }),
}));
jest.mock('../src/services/wire', () => ({
  wire: jest.fn(),
  ApiError: class extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));
const saved = (): SavedCredential => ({
  origin: 'https://desktop.example',
  gatewayId: mockId,
  deviceId: mockId,
  installation: mockId,
  refresh: 'a'.repeat(64),
  pending: false,
  grantRevision: 1,
});
const pair = () => ({
  deviceId: mockId,
  accessToken: 'b'.repeat(64),
  refreshToken: 'c'.repeat(64),
  accessExpiresAt: Date.now() + 300000,
  refreshExpiresAt: Date.now() + 86400000,
  grantRevision: 1,
});
beforeEach(() => {
  mockMarker = mockId;
  mockStored = null;
  jest.clearAllMocks();
});
it('clears leftover Keychain credentials after reinstall and never treats them as identity', async () => {
  mockStored = JSON.stringify(saved());
  mockMarker = null;
  const vault = new CredentialVault();
  expect(await vault.load()).toBeNull();
  expect(mockStored).toBeNull();
});
it('refuses a pending ambiguous refresh and malformed secure record on restart', async () => {
  const vault = new CredentialVault();
  mockStored = JSON.stringify({ ...saved(), pending: true });
  expect(await vault.load()).toBeNull();
  mockStored = '{bad';
  expect(await vault.load()).toBeNull();
});
it('serializes concurrent refresh callers and persists the ambiguity marker before dispatch', async () => {
  const vault = new CredentialVault(),
    credential = new PairedCredentials(saved(), vault);
  jest.mocked(wire).mockImplementationOnce(async () => {
    expect(JSON.parse(mockStored!).pending).toBe(true);
    return pair();
  });
  const tokens = await Promise.all([
    credential.token(),
    credential.token(),
    credential.token(),
  ]);
  expect(tokens.every((t) => t === tokens[0])).toBe(true);
  expect(wire).toHaveBeenCalledTimes(1);
  expect(JSON.parse(mockStored!).pending).toBe(false);
  expect(JSON.parse(mockStored!).accessToken).toBeUndefined();
});
it('never replays refresh after a lost response and clears credentials', async () => {
  jest.mocked(wire).mockRejectedValueOnce(new Error('Network lost'));
  const credential = new PairedCredentials(saved(), new CredentialVault());
  await expect(credential.token()).rejects.toBeInstanceOf(ApiError);
  await expect(credential.token()).rejects.toBeInstanceOf(ApiError);
  expect(wire).toHaveBeenCalledTimes(1);
  expect(mockStored).toBeNull();
});
it('logout fences an in-flight refresh response and cannot recreate secure credentials', async () => {
  let finish: (value: ReturnType<typeof pair>) => void = () => {};
  jest.mocked(wire).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const credential = new PairedCredentials(saved(), new CredentialVault());
  const pending = credential.token();
  while (jest.mocked(wire).mock.calls.length === 0) await Promise.resolve();
  await credential.clear();
  finish(pair());
  await expect(pending).rejects.toBeInstanceOf(ApiError);
  expect(mockStored).toBeNull();
});
it('serializes secure writes before deletion so delayed storage cannot resurrect a logout', async () => {
  const vault = new CredentialVault();
  let release: () => void = () => {};
  jest
    .mocked(SecureStore.setItemAsync)
    .mockImplementationOnce(async (_key, value) => {
      await new Promise<void>((r) => {
        release = r;
      });
      mockStored = value;
    });
  const saving = vault.save(saved());
  await Promise.resolve();
  await Promise.resolve();
  const clearing = vault.clear();
  release();
  await Promise.all([saving, clearing]);
  expect(mockStored).toBeNull();
});
