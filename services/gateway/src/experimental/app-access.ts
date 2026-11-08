import type { DurableEvent, Session } from '@pocket/protocol';
import type { NetworkProfile } from '../security/network.js';
import type { AppSource } from './app-projection.js';

export type AppAccess = 'local' | 'paired-read-only' | 'paired-send';

/** Startup policy is independent of network membership and local send opt-in. */
export function appAccess(
  env: NodeJS.ProcessEnv,
  profile: NetworkProfile,
): AppAccess {
  const selected = env.POCKET_APP_ACCESS ?? 'local';
  if (!['local', 'paired-read-only', 'paired-send'].includes(selected))
    throw new Error('Invalid App access mode');
  if (
    selected !== 'local' &&
    (profile.mode === 'development' ||
      env.POCKET_EXPERIMENTAL_APP_PROJECTION !== '1' ||
      env.POCKET_APP_ENROLLMENTS_FILE)
  )
    throw new Error(
      'Paired App reads require explicit experimental enablement, trusted paired profile and owner IPC enrollment',
    );
  if (
    selected === 'local' &&
    env.POCKET_EXPERIMENTAL_APP_PROJECTION === '1' &&
    profile.mode !== 'development'
  )
    throw new Error(
      'Local App projection requires authenticated loopback development',
    );
  return selected as AppAccess;
}

export function readOnlySource(source: AppSource): AppSource {
  const read = { ...source };
  delete read.prepareSend;
  delete read.sendMode;
  return read;
}

/** Old durable replay may predate this profile. Never advertise its write capability. */
export function readOnlySession(session: Session): Session {
  if (!session.external) return session;
  const external = { ...session.external };
  delete external.send;
  return { ...session, external: { ...external, readOnly: true } };
}
export function readOnlyEvent(event: DurableEvent): DurableEvent {
  if (event.type === 'external.snapshot')
    return {
      ...event,
      payload: {
        ...event.payload,
        session: readOnlySession(event.payload.session),
      },
    };
  if (event.type === 'session.created')
    return { ...event, payload: readOnlySession(event.payload) };
  return event;
}
