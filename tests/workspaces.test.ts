import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  existsSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../services/gateway/src/db/store';
import {
  Workspaces,
  segments,
} from '../services/gateway/src/modules/workspaces';
import { secureFixture } from './secure-helpers';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-files-')),
    root = join(dir, 'checkout');
  mkdirSync(root);
  const store = new Store(join(dir, 'db.sqlite')),
    files = new Workspaces(store);
  const workspace = files.register(root, 'Fixture');
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', args, {
      cwd: root,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: dir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
      stdio: 'pipe',
    });
  return { dir, root, store, files, id: workspace.id, git };
}
it('reads only contained regular single-link bounded UTF-8 files and excludes credential stores', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'ok.txt'), 'hello');
  expect(f.files.read(f.id, 'ok.txt').text).toBe('hello');
  const paths = [
    '../outside',
    '/etc/passwd',
    'C:/secret',
    'C:\\secret',
    '\\server\\share',
    'file:stream',
    'a/../ok.txt',
    'a//b',
    'ok.txt/',
    'ok.txt.',
    'NUL',
    'CON.txt',
    'a\0b',
    '.git/config',
    '.env.local',
    '.git-credentials',
    '.pypirc',
    '.docker/config.json',
    '.kube/config',
    '.gnupg/private',
    '.npmrc',
    'id_ecdsa',
    'id_dsa',
    'key.pem',
    'node_modules/a',
  ];
  for (const path of paths) expect(() => segments(path)).toThrow();
  writeFileSync(join(f.dir, 'outside'), 'outside');
  symlinkSync(join(f.dir, 'outside'), join(f.root, 'escape'));
  linkSync(join(f.dir, 'outside'), join(f.root, 'hard'));
  for (const name of ['escape', 'hard'])
    expect(() => f.files.read(f.id, name)).toThrow();
  writeFileSync(join(f.root, 'huge'), 'x'.repeat(65537));
  writeFileSync(join(f.root, 'binary'), Buffer.from([0, 1]));
  expect(() => f.files.read(f.id, 'huge')).toThrow();
  expect(() => f.files.read(f.id, 'binary')).toThrow();
  renameSync(f.root, f.root + '-old');
  mkdirSync(f.root);
  writeFileSync(join(f.root, 'ok.txt'), 'replacement');
  expect(() => f.files.read(f.id, 'ok.txt')).toThrow();
});
it('bounds directory enumeration before collecting all entries', () => {
  const f = fixture();
  for (let i = 0; i < 1001; i++) writeFileSync(join(f.root, 'file' + i), '');
  expect(() => f.files.files(f.id)).toThrow('too many');
});
it('performs bounded read-only Git status and literal diff without hooks, textconv, external diff, filters or secret files', async () => {
  const f = fixture();
  f.git('init');
  writeFileSync(join(f.root, 'ok.txt'), 'base\n');
  writeFileSync(join(f.root, '-dash.txt'), 'base\n');
  f.git('add', '.');
  f.git('commit', '-m', 'base');
  writeFileSync(join(f.root, 'ok.txt'), 'changed\n');
  writeFileSync(join(f.root, '-dash.txt'), 'changed\n');
  writeFileSync(join(f.root, '.env'), 'SECRET_CANARY');
  const marker = join(f.dir, 'EXECUTED'),
    command = `touch ${marker}; cat`;
  f.git('config', 'core.fsmonitor', command);
  f.git('config', 'diff.external', command);
  f.git('config', 'diff.hostile.textconv', command);
  writeFileSync(join(f.root, '.gitattributes'), '*.txt diff=hostile\n');
  expect((await f.files.runGit(f.id, 'status')).text).toContain('ok.txt');
  expect((await f.files.runGit(f.id, 'diff', '-dash.txt')).text).toContain(
    '+changed',
  );
  expect(existsSync(marker)).toBe(false);
  await expect(f.files.runGit(f.id, 'diff', '.env')).rejects.toThrow();
  // Clean/process filters are distinct from textconv and execute on status/diff unless refused.
  for (const mode of ['clean', 'process']) {
    f.git('config', `filter.hostile.${mode}`, command);
    writeFileSync(join(f.root, '.gitattributes'), '*.txt filter=hostile\n');
    await expect(f.files.runGit(f.id, 'status')).rejects.toThrow('unsupported');
    await expect(f.files.runGit(f.id, 'diff', 'ok.txt')).rejects.toThrow(
      'unsupported',
    );
    expect(existsSync(marker)).toBe(false);
    f.git('config', '--unset', `filter.hostile.${mode}`);
  }
  f.git('config', 'remote.origin.promisor', 'true');
  await expect(f.files.runGit(f.id, 'status')).rejects.toThrow('unsupported');
});
it('rejects included hostile Git configuration, worktree indirection and alternates', async () => {
  const f = fixture();
  f.git('init');
  writeFileSync(join(f.root, 'ok.txt'), 'text');
  const config = join(f.dir, 'hostile.conf');
  writeFileSync(config, '[filter "evil"]\n clean = touch NEVER\n');
  f.git('config', 'include.path', config);
  await expect(f.files.runGit(f.id, 'status')).rejects.toThrow('unsupported');
  f.git('config', '--unset', 'include.path');
  mkdirSync(join(f.root, '.git', 'objects', 'info'), { recursive: true });
  writeFileSync(
    join(f.root, '.git', 'objects', 'info', 'alternates'),
    '/outside',
  );
  await expect(f.files.runGit(f.id, 'status')).rejects.toThrow();
});
it('requires opaque owner registration and current read scope over real HTTPS', async () => {
  const f = await secureFixture();
  cleanups.push(f.close);
  const root = join(f.directory, 'workspace');
  mkdirSync(root);
  writeFileSync(join(root, 'note.txt'), 'private fixture');
  const w = f.workspaces.register(root, 'Owner-selected');
  const a = await f.pair([{ workspaceId: w.id, scopes: ['workspace:read'] }]),
    b = await f.pair([]);
  expect(
    (
      await f.request(
        `/v1/workspaces/${w.id}/read`,
        { path: 'note.txt' },
        a.pair.accessToken,
      )
    ).body,
  ).toMatchObject({ text: 'private fixture' });
  expect(
    (
      await f.request(
        `/v1/workspaces/${w.id}/read`,
        { path: 'note.txt' },
        b.pair.accessToken,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await f.request(
        `/v1/workspaces/${w.id}/read`,
        { path: 'note.txt', root },
        a.pair.accessToken,
      )
    ).status,
  ).toBe(400);
  f.devices.reduce(a.pair.deviceId, []);
  expect(
    (
      await f.request(
        `/v1/workspaces/${w.id}/read`,
        { path: 'note.txt' },
        a.pair.accessToken,
      )
    ).status,
  ).toBe(404);
});
