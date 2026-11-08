import {
  constants,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  opendirSync,
} from 'node:fs';
import { join, relative, isAbsolute, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../db/store.js';
import { DomainError } from '../errors.js';
const unavailable = () =>
  new DomainError(
    404,
    'file_unavailable',
    'File is unavailable or excluded by workspace policy',
  );
// Explicit control-byte rejection is intentional at this trust boundary.
/* eslint-disable no-control-regex */
const excluded =
  /^(?:\.git|\.env.*|\.ssh|\.aws|\.azure|\.gcloud|\.config|node_modules|vendor|build|dist|\.state|\.npmrc|\.netrc|\.git-credentials|\.pypirc|\.docker|\.kube|\.gnupg|credentials.*|secrets?.*|id_rsa.*|id_ed25519.*|id_ecdsa.*|id_dsa.*|.*\.(?:pem|key|p12|pfx|keystore))$/i;
export function segments(path: string) {
  if (
    !path ||
    path.length > 1024 ||
    /[\\:\x00-\x1f\x7f]/.test(path) ||
    isAbsolute(path)
  )
    throw unavailable();
  const parts = path.split('/');
  if (
    parts.length > 32 ||
    parts.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        p.endsWith('.') ||
        p.endsWith(' ') ||
        excluded.test(p) ||
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p),
    )
  )
    throw unavailable();
  return parts;
}
type Root = {
  id: string;
  root: string;
  name: string;
  dev: string;
  ino: string;
};
export class Workspaces {
  private running = 0;
  constructor(
    private store: Store,
    private git = '/usr/bin/git',
  ) {}
  register(path: string, name: string) {
    if (process.platform === 'win32')
      throw new DomainError(
        503,
        'platform_unverified',
        'Windows workspace registration remains gated pending junction tests',
      );
    const root = realpathSync(path),
      stat = lstatSync(root);
    if (
      !stat.isDirectory() ||
      root === sep ||
      root === process.env.HOME ||
      name.length < 1 ||
      name.length > 120 ||
      /[\x00-\x1f]/.test(name)
    )
      throw unavailable();
    const id = randomUUID();
    this.store.db
      .prepare('INSERT INTO workspaces VALUES(?,?,?,?,?)')
      .run(id, root, name, String(stat.dev), String(stat.ino));
    return { id, name };
  }
  list() {
    return this.store.db
      .prepare('SELECT id,name FROM workspaces ORDER BY name LIMIT 100')
      .all() as { id: string; name: string }[];
  }
  private root(id: string) {
    const row = this.store.db
      .prepare('SELECT * FROM workspaces WHERE id=? AND root IS NOT NULL')
      .get(id) as Root | undefined;
    if (!row) throw unavailable();
    const stat = lstatSync(row.root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      String(stat.dev) !== row.dev ||
      String(stat.ino) !== row.ino ||
      realpathSync(row.root) !== row.root
    )
      throw unavailable();
    return row;
  }
  private path(root: Root, path: string) {
    let current = root.root;
    for (const part of segments(path)) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (
        stat.isSymbolicLink() ||
        (!stat.isDirectory() && !stat.isFile()) ||
        (stat.isFile() && stat.nlink !== 1)
      )
        throw unavailable();
    }
    const rel = relative(root.root, realpathSync(current));
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
      throw unavailable();
    return current;
  }
  read(id: string, path: string) {
    try {
      const root = this.root(id),
        file = this.path(root, path),
        before = lstatSync(file);
      if (!before.isFile() || before.size > 65536) throw unavailable();
      const fd = openSync(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened = fstatSync(fd);
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size > 65536
        )
          throw unavailable();
        const buffer = Buffer.alloc(65537);
        let n = 0,
          count = 0;
        do {
          count = readSync(fd, buffer, n, buffer.length - n, null);
          n += count;
        } while (count && n < buffer.length);
        const after = fstatSync(fd),
          atPath = lstatSync(this.path(this.root(id), path));
        if (
          n > 65536 ||
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs ||
          after.ctimeMs !== opened.ctimeMs ||
          atPath.ino !== opened.ino ||
          atPath.dev !== opened.dev ||
          buffer.subarray(0, n).includes(0)
        )
          throw unavailable();
        const content = buffer.subarray(0, n),
          text = new TextDecoder('utf-8', { fatal: true }).decode(content);
        return {
          path,
          text,
          hash: createHash('sha256').update(content).digest('hex'),
        };
      } finally {
        closeSync(fd);
      }
    } catch {
      throw unavailable();
    }
  }
  files(id: string, path = '') {
    try {
      const root = this.root(id),
        dir = path ? this.path(root, path) : root.root;
      const handle = opendirSync(dir),
        names = [];
      try {
        let next;
        while ((next = handle.readSync())) {
          if (names.length >= 1000)
            throw new DomainError(
              413,
              'directory_limit',
              'Directory has too many entries',
            );
          names.push(next);
        }
      } finally {
        handle.closeSync();
      }
      const entries = names
        .filter(
          (n) =>
            !excluded.test(n.name) &&
            !n.isSymbolicLink() &&
            (n.isFile() || n.isDirectory()),
        )
        .flatMap((n) => {
          const p = path ? path + '/' + n.name : n.name;
          try {
            this.path(root, p);
            return [
              {
                path: p,
                kind: n.isDirectory()
                  ? ('directory' as const)
                  : ('file' as const),
              },
            ];
          } catch {
            return [];
          }
        });
      this.root(id);
      return { entries };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw unavailable();
    }
  }
  async runGit(id: string, operation: 'status' | 'diff', path?: string) {
    if (this.running >= 2)
      throw new DomainError(429, 'git_capacity', 'Git service is busy');
    const root = this.root(id),
      gitDir = join(root.root, '.git');
    try {
      if (!lstatSync(gitDir).isDirectory() || realpathSync(gitDir) !== gitDir)
        throw unavailable();
      for (const name of ['config', 'index', 'HEAD', 'objects', 'refs']) {
        const p = join(gitDir, name);
        try {
          const s = lstatSync(p);
          if (s.isSymbolicLink() || (s.isFile() && s.nlink !== 1))
            throw unavailable();
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
      for (const name of [
        'objects/info/alternates',
        'objects/info/http-alternates',
        'info/grafts',
        'commondir',
      ]) {
        try {
          lstatSync(join(gitDir, name));
          throw unavailable();
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
      if (operation === 'diff') {
        if (!path) throw unavailable();
        this.read(id, path);
      }
    } catch {
      throw unavailable();
    }
    const args = [
      '--no-pager',
      '--git-dir=' + gitDir,
      '--work-tree=' + root.root,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'core.quotePath=true',
      '-c',
      'core.bare=false',
      '-c',
      'diff.external=',
      '-c',
      'diff.trustExitCode=false',
      '-c',
      'core.pager=cat',
      '-c',
      'submodule.recurse=false',
      ...(operation === 'status'
        ? [
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=no',
            '--ignore-submodules=all',
          ]
        : [
            'diff',
            '--no-ext-diff',
            '--no-textconv',
            '--no-renames',
            '--ignore-submodules=all',
            '--no-color',
            '--',
            path!,
          ]),
    ];
    this.running++;
    try {
      const execute = (argv: string[]) =>
        new Promise<string>((resolve, reject) =>
          execFile(
            this.git,
            argv,
            {
              cwd: root.root,
              env: {
                PATH: '/usr/bin:/bin',
                HOME: '/nonexistent',
                LANG: 'C',
                LC_ALL: 'C',
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_TERMINAL_PROMPT: '0',
                GIT_OPTIONAL_LOCKS: '0',
                GIT_LITERAL_PATHSPECS: '1',
                GIT_NO_LAZY_FETCH: '1',
              },
              timeout: 3000,
              maxBuffer: 262144,
              killSignal: 'SIGKILL',
              encoding: 'utf8',
            },
            (error, stdout) =>
              error
                ? reject(
                    new DomainError(
                      422,
                      'git_unavailable',
                      'Git failed or exceeded its time/output limit',
                    ),
                  )
                : resolve(stdout),
          ),
        );
      const prefix = args.slice(0, args.indexOf(operation));
      const config = await execute([
        ...prefix,
        'config',
        '--null',
        '--list',
        '--includes',
      ]);
      for (const entry of config.split('\0').filter(Boolean)) {
        const key = entry.split('\n', 1)[0]!.toLowerCase();
        if (
          key.startsWith('filter.') ||
          key === 'extensions.partialclone' ||
          /^remote\..*\.promisor$/.test(key) ||
          key === 'extensions.worktreeconfig'
        )
          throw new DomainError(
            422,
            'git_configuration',
            'Repository filters, partial clones and worktree config are unsupported',
          );
      }
      const output = await execute(args);
      this.root(id);
      if (operation === 'diff') {
        this.read(id, path!);
        return { text: output };
      }
      // Parse NUL porcelain; rename source paths are separate records, never exposed.
      const records = output.split('\0'),
        safe: string[] = [];
      for (let i = 0; i < records.length; i++) {
        const record = records[i]!;
        if (!record) continue;
        const name = record.slice(3);
        if (/[RC]/.test(record.slice(0, 2))) i++;
        try {
          segments(name);
          this.path(root, name);
          safe.push(record);
        } catch {
          /* Excluded/unavailable names carry no authority. */
        }
      }
      return { text: safe.join('\n') };
    } finally {
      this.running--;
    }
  }
}
