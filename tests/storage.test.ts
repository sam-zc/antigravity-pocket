import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../services/gateway/src/db/store';

it('migrates empty v0, reopens v4 without data loss and refuses newer schema', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-migration-'));
  const path = join(directory, 'db.sqlite');
  try {
    const initial = new Database(path);
    initial.close();
    const first = new Store(path);
    expect(first.db.pragma('user_version', { simple: true })).toBe(4);
    const key = randomUUID();
    const receipt = first.command('create', key, key, () =>
      first.create('Keep me'),
    );
    const gatewayId = first.gatewayId;
    first.close();
    const reopened = new Store(path);
    expect(reopened.gatewayId).toBe(gatewayId);
    expect(reopened.session(receipt.sessionId).title).toBe('Keep me');
    reopened.db.pragma('user_version=5');
    reopened.close();
    expect(() => new Store(path)).toThrow('newer');
    const raw = new Database(path);
    expect(raw.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
      n: 1,
    });
    raw.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
it('database constraint rejects a second active run independently of service checks', () => {
  const store = new Store(':memory:');
  try {
    const key = randomUUID();
    const c = store.command('create', key, key, () => store.create('Index'));
    store.command('prompt', key, key, () =>
      store.prompt(c.sessionId, {
        protocolVersion: 1,
        clientMessageId: key,
        text: 'Hello',
      }),
    );
    expect(() =>
      store.db
        .prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), c.sessionId, randomUUID(), 'hash', 'queued', '{}'),
    ).toThrow(/UNIQUE/);
  } finally {
    store.close();
  }
});
it('upgrades the Phase 2 schema with an owner-only backup while preserving sessions and security rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-v2-'));
  const path = join(dir, 'db.sqlite');
  try {
    const old = new Store(path);
    const receipt = old.create('Phase 2 retained');
    const gateway = old.gatewayId;
    const device = randomUUID();
    old.db
      .prepare("INSERT INTO devices VALUES(?,?,'active',1,0)")
      .run(device, 'Retained device');
    old.db.exec(
      'DROP TABLE external_commands; DROP TABLE external_sessions; PRAGMA user_version=2;',
    );
    old.close();
    const next = new Store(path);
    expect(next.gatewayId).toBe(gateway);
    expect(next.session(receipt.sessionId).title).toBe('Phase 2 retained');
    expect(
      next.db.prepare('SELECT name FROM devices WHERE id=?').get(device),
    ).toEqual({ name: 'Retained device' });
    expect(next.db.pragma('user_version', { simple: true })).toBe(4);
    next.close();
    const backups = readdirSync(dir).filter((name) =>
      name.startsWith('db.sqlite.pre-v4-'),
    );
    expect(backups).toHaveLength(1);
    expect(statSync(join(dir, backups[0]!)).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('upgrades an actual v1 database with a private pre-migration backup and preserved identity/history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-v1-upgrade-'));
  const path = join(directory, 'db.sqlite');
  try {
    // A v1 fixture has only the original eight data tables, no security tables.
    const v1 = new Database(path);
    v1.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE streams(id TEXT PRIMARY KEY REFERENCES sessions(id), high INTEGER NOT NULL DEFAULT 0, minimum INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), client_id TEXT NOT NULL, prompt_hash TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(session_id,client_id));
      CREATE UNIQUE INDEX active_session ON runs(session_id) WHERE state IN ('queued','running');
      CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), ordinal INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(session_id,ordinal));
      CREATE TABLE tools(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE events(session_id TEXT NOT NULL REFERENCES streams(id), sequence INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, PRIMARY KEY(session_id,sequence));
      CREATE TABLE receipts(kind TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,key));
      PRAGMA user_version=1;
    `);
    const gatewayId = randomUUID(),
      sessionId = randomUUID();
    const history = {
      id: sessionId,
      title: 'Original v1 history',
      workspaceId: '00000000-0000-4000-8000-000000000001',
      adapterId: 'mock',
      revision: 0,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    v1.prepare('INSERT INTO metadata VALUES(?,?)').run('gatewayId', gatewayId);
    v1.prepare('INSERT INTO sessions VALUES(?,?)').run(
      sessionId,
      JSON.stringify(history),
    );
    v1.close();
    const upgraded = new Store(path);
    try {
      expect(upgraded.gatewayId).toBe(gatewayId);
      expect(upgraded.session(sessionId).title).toBe('Original v1 history');
      expect(upgraded.db.pragma('user_version', { simple: true })).toBe(4);
      expect(
        upgraded.db.prepare('SELECT count(*) AS n FROM devices').get(),
      ).toEqual({ n: 0 });
    } finally {
      upgraded.close();
    }
    const backups = readdirSync(directory).filter((name) =>
      name.startsWith('db.sqlite.pre-v4-'),
    );
    expect(backups).toHaveLength(1);
    const backupPath = join(directory, backups[0]!);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    const backup = new Database(backupPath, { readonly: true });
    try {
      expect(backup.pragma('user_version', { simple: true })).toBe(1);
      expect(
        backup.prepare('SELECT data FROM sessions WHERE id=?').get(sessionId),
      ).toEqual({
        data: JSON.stringify(history),
      });
      expect(() => backup.prepare('SELECT * FROM devices')).toThrow();
    } finally {
      backup.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('upgrades a schema 3 App projection without changing upstream mapping, Pocket message identity or replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-v3-')),
    path = join(dir, 'db.sqlite');
  try {
    const old = new Store(path),
      conversationId = randomUUID(),
      trajectoryId = randomUUID();
    const sid = old.projectExternal('00000000-0000-4000-8000-000000000001', {
      conversationId,
      trajectoryId,
      steps: [
        {
          index: 0,
          executionId: randomUUID(),
          role: 'user',
          text: 'Existing external fixture',
          done: true,
        },
      ],
    });
    const before = old.snapshot(sid);
    old.db.exec('DROP TABLE external_commands; PRAGMA user_version=3;');
    old.close();
    const upgraded = new Store(path);
    expect(upgraded.snapshot(sid)).toEqual(before);
    expect(
      upgraded.db
        .prepare(
          'SELECT conversation_id FROM external_sessions WHERE session_id=?',
        )
        .get(sid),
    ).toEqual({ conversation_id: conversationId });
    expect(
      upgraded.db.prepare('SELECT count(*) AS n FROM external_commands').get(),
    ).toEqual({ n: 0 });
    upgraded.close();
    expect(
      readdirSync(dir).filter((name) => name.startsWith('db.sqlite.pre-v4-')),
    ).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
