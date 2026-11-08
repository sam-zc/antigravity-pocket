import { request } from 'node:http';
import { lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { invitationSchema } from '@pocket/protocol';
import { appHelp, parseAppArgs } from './experimental/app-cli.js';
const require = createRequire(import.meta.url);
const qr = require('qrcode-terminal') as {
  generate: (value: string, options: { small: boolean }) => void;
};
const state = resolve(process.env.POCKET_STATE_DIR ?? '.state');
const socketPath = join(state, 'admin.sock');
function safePath() {
  if (!process.getuid) throw new Error('Unix owner IPC required');
  const dir = lstatSync(state),
    socket = lstatSync(socketPath);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    dir.uid !== process.getuid() ||
    (dir.mode & 0o077) !== 0 ||
    !socket.isSocket() ||
    socket.uid !== process.getuid() ||
    (socket.mode & 0o077) !== 0
  )
    throw new Error('Unsafe owner IPC permissions');
}
async function main() {
  const action = process.argv[2] ?? 'status';
  if (action === 'app' && process.argv[3] === 'help') {
    console.log(appHelp);
    return;
  }
  safePath();
  if (action === 'invite' && !process.stdout.isTTY)
    throw new Error(
      'Invitation QR may only be displayed in an interactive terminal; never redirect or record it',
    );
  const extra: unknown =
    action === 'app'
      ? parseAppArgs(process.argv.slice(3))
      : process.argv[3]
        ? JSON.parse(process.argv[3])
        : {};
  if (!extra || typeof extra !== 'object' || Array.isArray(extra))
    throw new Error('Expected JSON object');
  const body = JSON.stringify(action === 'app' ? extra : { ...extra, action });
  if (Buffer.byteLength(body) > 8192) throw new Error('Command too large');
  const value: unknown = await new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/admin',
        method: 'POST',
        headers: {
          Host: 'localhost',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
          if (data.length > 65536) req.destroy(new Error('Response too large'));
        });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              const failure = JSON.parse(data) as { code?: unknown };
              if (
                typeof failure.code === 'string' &&
                /^[a-z_]{1,80}$/.test(failure.code)
              )
                console.error(
                  `App setup: ${failure.code}. Run app help; inspect owner status and the local setup guide.`,
                );
              throw new Error('Administrative operation refused');
            }
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Admin request timed out')));
    req.on('error', reject);
    req.end(body);
  });
  if (action === 'invite') {
    const invitation = invitationSchema.parse(value);
    console.log(
      'Transient two-minute invitation. Do not capture or share this terminal. Verify hostname and exact comparison code on both devices.',
    );
    qr.generate(JSON.stringify(invitation), { small: true });
    console.log(
      'After scanning: rtk proxy pnpm admin status; confirm the exact claim/name/code/grants.',
    );
  } else console.log(JSON.stringify(value, null, 2));
}
main().catch(() => {
  console.error(
    'Admin command failed. Check app help or legacy command JSON, owner socket, reviewed TLS and current state. No secrets were logged.',
  );
  process.exitCode = 1;
});
