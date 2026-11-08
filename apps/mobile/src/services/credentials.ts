import * as SecureStore from 'expo-secure-store';
import { openDatabaseAsync } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import {
  httpsOriginSchema,
  secretSchema,
  tokenPairSchema,
  z,
  type TokenPair,
} from '@pocket/protocol';
import { wire, ApiError } from './wire';
const recordSchema = z
  .object({
    origin: httpsOriginSchema,
    gatewayId: z.string().uuid(),
    deviceId: z.string().uuid(),
    refresh: secretSchema,
    installation: z.string().uuid(),
    pending: z.boolean(),
    grantRevision: z.number().int().positive(),
  })
  .strict();
export type SavedCredential = z.infer<typeof recordSchema>;
const KEY = 'pocket.paired.v1';
const options = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};
export class CredentialVault {
  resetRequired = false;
  private static writes: Promise<unknown> = Promise.resolve();
  private serial<T>(action: () => Promise<T>) {
    const next = CredentialVault.writes.then(action);
    CredentialVault.writes = next.catch(() => undefined);
    return next;
  }

  async marker() {
    const db = await openDatabaseAsync('installation.sqlite');
    await db.execAsync(
      'CREATE TABLE IF NOT EXISTS installation(id TEXT NOT NULL)',
    );
    const row = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM installation LIMIT 1',
    );
    if (row) return row.id;
    this.resetRequired = !!(await SecureStore.getItemAsync(KEY));
    // iOS Keychain can outlive reinstall. Unknown leftovers never restore identity.
    await this.clear();
    const id = randomUUID();
    await db.runAsync('INSERT INTO installation VALUES(?)', id);
    return id;
  }
  async load() {
    const marker = await this.marker(),
      raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.resetRequired = true;
      await this.clear();
      return null;
    }
    const result = recordSchema.safeParse(parsed);
    if (
      !result.success ||
      result.data.installation !== marker ||
      result.data.pending
    ) {
      this.resetRequired = true;
      await this.clear();
      return null;
    }
    return result.data;
  }
  async save(value: SavedCredential) {
    const serialized = JSON.stringify(recordSchema.parse(value));
    await this.serial(() => SecureStore.setItemAsync(KEY, serialized, options));
  }
  async clearFor(deviceId: string) {
    await this.serial(async () => {
      const raw = await SecureStore.getItemAsync(KEY);
      if (!raw) return;
      try {
        if ((JSON.parse(raw) as { deviceId?: string }).deviceId !== deviceId)
          return;
      } catch {
        return;
      }
      await SecureStore.deleteItemAsync(KEY);
    });
  }
  async clear() {
    await this.serial(() => SecureStore.deleteItemAsync(KEY));
  }
}
export class PairedCredentials {
  private pair?: TokenPair;
  private flight?: Promise<string>;
  private closed = false;
  constructor(
    readonly saved: SavedCredential,
    private vault: CredentialVault,
  ) {}
  seed(pair: TokenPair) {
    this.pair = pair;
  }
  async revision(value: number) {
    if (this.flight) await this.flight;
    if (this.closed) throw new Error('Closed credential');
    this.saved.grantRevision = value;
    await this.vault.save({ ...this.saved, pending: false });
    if (this.closed) {
      await this.vault.clearFor(this.saved.deviceId);
      throw new Error('Closed credential');
    }
  }
  async token() {
    if (this.closed)
      throw new ApiError(
        401,
        'session_expired',
        'Pair again with the desktop owner',
      );
    if (this.pair && this.pair.accessExpiresAt > Date.now() + 10000)
      return this.pair.accessToken;
    if (this.flight) return this.flight;
    this.flight = this.rotate();
    try {
      return await this.flight;
    } finally {
      this.flight = undefined;
    }
  }
  private async rotate() {
    try {
      // Persist ambiguity BEFORE dispatch. A crash/lost response cannot replay a consumed refresh.
      await this.vault.save({ ...this.saved, pending: true });
      const pair = await wire(
        this.saved.origin,
        '/v1/auth/refresh',
        tokenPairSchema,
        { refreshToken: this.saved.refresh },
      );
      if (this.closed) throw new Error('Logged out during refresh');
      if (pair.deviceId !== this.saved.deviceId)
        throw new Error('Device mismatch');
      this.saved.refresh = pair.refreshToken;
      await this.vault.save({ ...this.saved, pending: false });
      if (this.closed) {
        await this.vault.clearFor(this.saved.deviceId);
        throw new Error('Logged out');
      }
      this.pair = pair;
      return pair.accessToken;
    } catch (error) {
      await this.clear();
      throw new ApiError(
        401,
        error instanceof ApiError ? error.code : 'refresh_uncertain',
        'Session renewal was not confirmed. Revoke this device on desktop and pair again.',
      );
    }
  }
  async clear() {
    this.closed = true;
    this.pair = undefined;
    await this.vault.clearFor(this.saved.deviceId);
  }
}
