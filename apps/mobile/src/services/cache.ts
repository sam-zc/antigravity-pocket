import { StorageError } from './storage-error';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';
import {
  snapshotSchema,
  utf8Bytes,
  type DurableEvent,
  type Snapshot,
} from '@pocket/protocol';
import { applyEvent, ResyncError } from './reducer';
export interface SessionCache {
  load(id: string): Promise<Snapshot | null>;
  remove(id: string): Promise<void>;
  replace(snapshot: Snapshot): Promise<void>;
  apply(id: string, event: DurableEvent): Promise<Snapshot>;
  applyBatch?(id: string, events: DurableEvent[]): Promise<Snapshot>;
}
async function boundCache(tx: Pick<SQLiteDatabase, 'runAsync'>) {
  await tx.runAsync(
    'DELETE FROM snapshots WHERE rowid IN (SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (ORDER BY updated DESC, namespace ASC, id ASC) AS n, SUM(length(CAST(data AS BLOB))) OVER (ORDER BY updated DESC, namespace ASC, id ASC ROWS UNBOUNDED PRECEDING) AS bytes FROM snapshots) WHERE n>20 OR bytes>20971520)',
  );
  await tx.runAsync(
    'DELETE FROM seen WHERE NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.namespace=seen.namespace AND s.id=seen.id)',
  );
}
export class Cache implements SessionCache {
  // Every namespace/handle writes the same physical database. Expo exclusive
  // transactions use separate connections and competing writes can SQLITE_BUSY.
  private static writes: Promise<unknown> = Promise.resolve();
  private static installation = 0;
  private static blocked = new Set<string>();
  retire() {
    if (this.active()) Cache.epochs.set(this.namespace, this.epoch + 1);
  }
  private static epochs = new Map<string, number>();
  private installation = Cache.installation;
  private epoch: number;
  private retired = new Set<string>();
  private available(id: string) {
    return this.active() && !this.retired.has(id);
  }
  private active() {
    return (
      this.installation === Cache.installation &&
      this.epoch === (Cache.epochs.get(this.namespace) ?? 0)
    );
  }
  private static serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = Cache.writes.then(operation);
    // Preserve the rejection for this caller without poisoning future writes.
    Cache.writes = next.catch(() => undefined);
    return next;
  }
  private write(
    action: Parameters<SQLiteDatabase['withExclusiveTransactionAsync']>[0],
  ) {
    return Cache.serialize(async () => {
      if (!this.active()) throw new Error('Cache runtime retired');
      await this.db.withExclusiveTransactionAsync(action);
      if (!this.active()) throw new Error('Cache runtime retired');
    }).catch((error) => {
      if (error instanceof ResyncError) throw error;
      throw new StorageError(
        error instanceof Error ? error.message : 'Local persistence failed',
      );
    });
  }
  private constructor(
    private db: SQLiteDatabase,
    private namespace: string,
  ) {
    this.epoch = Cache.epochs.get(namespace) ?? 0;
  }
  static async open(namespace: string) {
    if (Cache.blocked.has(namespace))
      throw new StorageError(
        'Local cleanup failed; restart or clear Pocket test data before reconnecting',
      );
    const db = await Cache.serialize(async () => {
      const connection = await openDatabaseAsync('foundation.sqlite');
      const version = await connection.getFirstAsync<{ user_version: number }>(
        'PRAGMA user_version',
      );
      if ((version?.user_version ?? 0) > 1)
        throw new StorageError(
          'Cache schema is newer than this app; update Pocket',
        );
      await connection.execAsync(
        'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS snapshots(namespace TEXT,id TEXT,data TEXT,updated INTEGER,PRIMARY KEY(namespace,id)); CREATE TABLE IF NOT EXISTS seen(namespace TEXT,id TEXT,seq INTEGER,data TEXT,PRIMARY KEY(namespace,id,seq)); CREATE TABLE IF NOT EXISTS drafts(namespace TEXT,id TEXT,text TEXT,command TEXT,PRIMARY KEY(namespace,id)); PRAGMA user_version=1;',
      );
      return connection;
    });
    return new Cache(db, namespace);
  }
  async load(id: string) {
    if (!this.available(id)) return null;
    const row = await this.db.getFirstAsync<{ data: string }>(
      'SELECT data FROM snapshots WHERE namespace=? AND id=?',
      this.namespace,
      id,
    );
    if (!this.available(id) || !row) return null;
    try {
      const snapshot = snapshotSchema.parse(JSON.parse(row.data));
      if (snapshot.session.id !== id)
        throw new Error('Cache identity mismatch');
      return snapshot;
    } catch {
      // A disposable read projection is repairable. Never discard a draft or command barrier here.
      await this.write(async (tx) => {
        await tx.runAsync(
          'DELETE FROM snapshots WHERE namespace=? AND id=?',
          this.namespace,
          id,
        );
        await tx.runAsync(
          'DELETE FROM seen WHERE namespace=? AND id=?',
          this.namespace,
          id,
        );
      });
      return null;
    }
  }
  async remove(id: string) {
    this.retired.add(id); // Invalidate delayed reads/writes before waiting on SQLite.
    await this.write(async (tx) => {
      for (const table of ['snapshots', 'seen'])
        await tx.runAsync(
          `DELETE FROM ${table} WHERE namespace=? AND id=?`,
          this.namespace,
          id,
        );
      // Pending command intent is a no-resend barrier, not an evictable read cache.
      await tx.runAsync(
        'DELETE FROM drafts WHERE namespace=? AND id=? AND command IS NULL',
        this.namespace,
        id,
      );
    }).catch((error) => {
      Cache.blocked.add(this.namespace);
      throw new StorageError(
        error instanceof Error ? error.message : 'Local cleanup failed',
      );
    });
  }
  async replace(snapshot: Snapshot) {
    snapshotSchema.parse(snapshot);
    await this.write(async (tx) => {
      if (!this.available(snapshot.session.id))
        throw new Error('Source cache retired');
      await tx.runAsync(
        'INSERT OR REPLACE INTO snapshots VALUES(?,?,?,?)',
        this.namespace,
        snapshot.session.id,
        JSON.stringify(snapshot),
        Date.now(),
      );
      await tx.runAsync(
        'DELETE FROM seen WHERE namespace=? AND id=?',
        this.namespace,
        snapshot.session.id,
      );
      await boundCache(tx);
    });
  }
  async apply(id: string, event: DurableEvent) {
    return this.applyBatch(id, [event]);
  }
  async applyBatch(id: string, events: DurableEvent[]) {
    if (!events.length || events.length > 200)
      throw new ResyncError('Replay batch limit');
    let result: Snapshot | undefined;
    const digests = await Promise.all(
      events.map((event) =>
        digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify(event)),
      ),
    );
    await this.write(async (tx) => {
      if (!this.available(id)) throw new Error('Source cache retired');
      const row = await tx.getFirstAsync<{ data: string }>(
        'SELECT data FROM snapshots WHERE namespace=? AND id=?',
        this.namespace,
        id,
      );
      if (!row) throw new ResyncError('Missing snapshot');
      result = snapshotSchema.parse(JSON.parse(row.data));
      const rows = await tx.getAllAsync<{ seq: number; data: string }>(
        `SELECT seq,data FROM seen WHERE namespace=? AND id=? AND seq IN (${events.map(() => '?').join(',')})`,
        this.namespace,
        id,
        ...events.map((event) => event.sequence),
      );
      const seen = new Map(rows.map((row) => [row.seq, row.data]));
      for (const [index, event] of events.entries()) {
        const digest = digests[index]!;
        const prior = seen.get(event.sequence);
        if (prior && prior !== digest)
          throw new ResyncError('Conflicting duplicate');
        if (event.type === 'message.completed') {
          const message = result.messages.find(
            (m) => m.id === event.payload.messageId,
          );
          if (
            message &&
            (await digestStringAsync(
              CryptoDigestAlgorithm.SHA256,
              message.text,
            )) !== event.payload.hash
          )
            throw new ResyncError('Message hash mismatch');
        }
        result = applyEvent(result, event);
        seen.set(event.sequence, digest);
      }
      await tx.runAsync(
        'INSERT OR REPLACE INTO snapshots VALUES(?,?,?,?)',
        this.namespace,
        id,
        JSON.stringify(result),
        Date.now(),
      );
      await tx.runAsync(
        `INSERT OR IGNORE INTO seen VALUES ${events.map(() => '(?,?,?,?)').join(',')}`,
        ...events.flatMap((event, index) => [
          this.namespace,
          id,
          event.sequence,
          digests[index]!,
        ]),
      );
      await tx.runAsync(
        'DELETE FROM seen WHERE namespace=? AND id=? AND seq<?',
        this.namespace,
        id,
        result.through - 1000,
      );
      await boundCache(tx);
    });
    if (!this.available(id)) throw new Error('Source cache retired');
    return result!;
  }
  async draft(id: string) {
    if (!this.available(id)) return { text: '', command: null };
    const row = await this.db.getFirstAsync<{
      text: string;
      command: string | null;
    }>(
      'SELECT text,command FROM drafts WHERE namespace=? AND id=?',
      this.namespace,
      id,
    );
    if (!this.available(id) || !row) return { text: '', command: null };
    if (
      typeof row.text !== 'string' ||
      utf8Bytes(row.text) > 65536 ||
      (row.command !== null &&
        (typeof row.command !== 'string' || row.command.length > 128))
    )
      throw new Error('Draft/command record is corrupt; do not resend');
    return row;
  }
  async saveDraft(id: string, text: string, command: string | null = null) {
    if (command !== null && (!command || command.length > 128))
      throw new Error('Invalid command identity');
    if (utf8Bytes(text) > 65536) throw new Error('Draft exceeds 64 KiB');
    await this.write(async (tx) => {
      if (!this.available(id)) throw new Error('Source cache retired');
      if (!text && !command) {
        await tx.runAsync(
          'DELETE FROM drafts WHERE namespace=? AND id=?',
          this.namespace,
          id,
        );
        return;
      }
      const existing = await tx.getFirstAsync(
        'SELECT 1 FROM drafts WHERE namespace=? AND id=?',
        this.namespace,
        id,
      );
      const count = await tx.getFirstAsync<{ n: number }>(
        'SELECT count(*) AS n FROM drafts',
      );
      if (!existing && count!.n >= 100)
        throw new Error('Draft capacity reached; clear an old draft');
      await tx.runAsync(
        'INSERT OR REPLACE INTO drafts VALUES(?,?,?,?)',
        this.namespace,
        id,
        text,
        command,
      );
    });
  }
  static async purgeAll() {
    Cache.installation++;
    const cache = await Cache.open('cleanup');
    await Cache.serialize(() =>
      cache.db.withExclusiveTransactionAsync(async (tx) => {
        for (const table of ['snapshots', 'seen', 'drafts'])
          await tx.runAsync(`DELETE FROM ${table}`);
      }),
    );
  }
  async purge(preserveCommands = false) {
    if (!this.active()) return;
    Cache.epochs.set(
      this.namespace,
      (Cache.epochs.get(this.namespace) ?? 0) + 1,
    );
    await Cache.serialize(() =>
      this.db.withExclusiveTransactionAsync(async (tx) => {
        for (const table of ['snapshots', 'seen', 'drafts'])
          await tx.runAsync(
            `DELETE FROM ${table} WHERE namespace=?${table === 'drafts' && preserveCommands ? ' AND command IS NULL' : ''}`,
            this.namespace,
          );
      }),
    ).catch((error) => {
      Cache.blocked.add(this.namespace);
      throw new StorageError(
        error instanceof Error ? error.message : 'Local cleanup failed',
      );
    });
  }
}
