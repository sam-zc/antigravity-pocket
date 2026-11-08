import type Database from 'better-sqlite3';
export function migrate(db: Database.Database) {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > 4)
    throw new Error('Database schema is newer than this gateway');
  if (version === 4) return;
  if (version === 3) {
    commandMigration(db);
    return;
  }
  if (version === 2) {
    externalMigration(db);
    commandMigration(db);
    return;
  }
  if (version === 0) {
    db.transaction(() => {
      db.exec(`
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE streams(id TEXT PRIMARY KEY REFERENCES sessions(id), high INTEGER NOT NULL DEFAULT 0, minimum INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), client_id TEXT NOT NULL, prompt_hash TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(session_id,client_id));
      CREATE UNIQUE INDEX active_session ON runs(session_id) WHERE state IN ('queued','running');
      CREATE TABLE messages(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id), ordinal INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(session_id,ordinal));
      CREATE TABLE tools(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE events(session_id TEXT NOT NULL REFERENCES streams(id), sequence INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, PRIMARY KEY(session_id,sequence));
      CREATE TABLE receipts(kind TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,key));
      PRAGMA user_version = 1;
    `);
    })();
  }
  db.transaction(() => {
    db.exec(`
      CREATE TABLE workspaces(id TEXT PRIMARY KEY, root TEXT UNIQUE, name TEXT NOT NULL, dev TEXT, ino TEXT);
      INSERT INTO workspaces VALUES('00000000-0000-4000-8000-000000000001',NULL,'Synthetic sandbox',NULL,NULL);
      CREATE TABLE devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL);
      CREATE TABLE grants(device TEXT NOT NULL REFERENCES devices(id),workspace TEXT NOT NULL REFERENCES workspaces(id),scope TEXT NOT NULL,PRIMARY KEY(device,workspace,scope));
      CREATE TABLE invitations(id TEXT PRIMARY KEY,secret TEXT NOT NULL UNIQUE,state TEXT NOT NULL,expires INTEGER NOT NULL,claim TEXT UNIQUE,receipt TEXT UNIQUE,name TEXT,code TEXT,grants TEXT NOT NULL,device TEXT REFERENCES devices(id));
      CREATE TABLE families(id TEXT PRIMARY KEY,device TEXT NOT NULL REFERENCES devices(id),expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE credentials(hash TEXT PRIMARY KEY,device TEXT NOT NULL REFERENCES devices(id),family TEXT NOT NULL REFERENCES families(id),kind TEXT NOT NULL,expires INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE tickets(hash TEXT PRIMARY KEY,access TEXT NOT NULL REFERENCES credentials(hash),expires INTEGER NOT NULL);
      CREATE TABLE device_events(device TEXT NOT NULL REFERENCES devices(id),epoch INTEGER NOT NULL,sequence INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(device,epoch,sequence));
      CREATE TABLE security_audit(id TEXT PRIMARY KEY,action TEXT NOT NULL,object TEXT NOT NULL,at INTEGER NOT NULL);
      PRAGMA user_version=2;
    `);
  })();
  externalMigration(db);
  commandMigration(db);
}

function externalMigration(db: Database.Database) {
  db.transaction(() => {
    db.exec(`CREATE TABLE external_sessions(session_id TEXT PRIMARY KEY REFERENCES sessions(id), conversation_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    PRAGMA user_version=3;`);
  })();
}

function commandMigration(db: Database.Database) {
  db.transaction(() => {
    db.exec(`CREATE TABLE external_commands(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES external_sessions(session_id), actor TEXT NOT NULL, fingerprint TEXT NOT NULL, text TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX external_commands_session ON external_commands(session_id);
    PRAGMA user_version=4;`);
  })();
}
