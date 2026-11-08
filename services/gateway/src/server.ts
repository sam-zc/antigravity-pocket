import { writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './db/store.js';
import { buildApp } from './app.js';
import { networkProfile, verifyServe } from './security/network.js';
import { ownerDirectory, startAdmin } from './security/admin.js';
import { enrolledSources } from './experimental/app-enrollment.js';
import { appAccess } from './experimental/app-access.js';
import { AppOwner } from './experimental/app-owner.js';

process.umask(0o077);
const profile = networkProfile(process.env);
const access = appAccess(process.env, profile);
const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('PORT must be 1024–65535');
if (profile.mode === 'serve')
  await verifyServe(
    process.env.POCKET_TAILSCALE_BIN ?? 'tailscale',
    profile.origin,
    port,
  );
const state = resolve(process.env.POCKET_STATE_DIR ?? '.state');
ownerDirectory(state);
const store = new Store(resolve(state, 'gateway.sqlite'));
const experimental = process.env.POCKET_EXPERIMENTAL_APP_PROJECTION === '1';
const external =
  experimental && process.env.POCKET_APP_ENROLLMENTS_FILE
    ? await enrolledSources(store, process.env)
    : undefined;
const { app, auth, devices, workspaces, replaceExternal } = await buildApp({
  store,
  profile,
  external,
  appAccess: access,
});
// Legacy file enrollment remains readable, but is not mixed with live owner administration.
const appOwner =
  experimental && !process.env.POCKET_APP_ENROLLMENTS_FILE
    ? new AppOwner(store, replaceExternal, undefined, access)
    : undefined;
await appOwner?.restore();
const admin = await startAdmin(
  state,
  devices,
  workspaces,
  profile,
  process.env.POCKET_TLS_CA,
  appOwner,
);
const credentialPath = resolve(state, 'development-access.json');
try {
  await app.listen({
    host: profile.mode === 'lan' ? profile.host : '127.0.0.1',
    port,
  });
  if (profile.mode === 'development') {
    writeFileSync(
      `${credentialPath}.tmp`,
      JSON.stringify(
        {
          origin: `http://127.0.0.1:${port}`,
          token: auth.token,
          expiresAt: auth.expiresAt,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    renameSync(`${credentialPath}.tmp`, credentialPath);
    console.log(
      `Mock gateway listening on http://127.0.0.1:${port}. Development credential is in ${credentialPath}. It expires in 8 hours and rotates on restart. No LAN access.`,
    );
  } else {
    try {
      unlinkSync(credentialPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    console.log(
      `Mock gateway using explicit ${profile.mode} profile. Owner administration is available through local IPC.`,
    );
  }
} catch (error) {
  await admin.close();
  await app.close();
  store.close();
  throw error;
}
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await admin.close();
  await app.close();
  store.close();
  if (profile.mode === 'development') unlinkSync(credentialPath);
}
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
