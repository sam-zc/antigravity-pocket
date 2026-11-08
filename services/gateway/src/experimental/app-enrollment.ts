import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z, WORKSPACE_ID } from '@pocket/protocol';
import type { Store } from '../db/store.js';
import { APP_WORKSPACE, type AppSource } from './app-projection.js';
import {
  readAppObservation,
  readCodingObservation,
  prepareAppSend,
} from './app-runtime.js';
import { ProbeError } from './app-probe.js';

export const enrollmentSchema = z
  .object({
    version: z.literal(1),
    sources: z
      .array(
        z
          .object({
            workspaceId: z.string().uuid(),
            projectId: z.string().uuid(),
            conversationId: z.string().uuid(),
            trajectoryId: z.string().uuid(),
            title: z.string().min(1).max(80),
            marker: z
              .string()
              .regex(/^POCKET-[A-Z0-9-]{1,80}$/)
              .optional(),
            observedAppUrl: z.string().max(250),
            disposable: z.boolean(),
            initialOffset: z.number().int().min(0).max(1999).optional(),
            pairedReadOnly: z.boolean().optional(),
            pairedSend: z.boolean().optional(),
            readMode: z.literal('coding').optional(),
            sendMode: z.enum(['fixture-text', 'ordinary-text']).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict();
export type Enrollment = z.infer<typeof enrollmentSchema>['sources'][number];

/** Owner-local configuration only. There is no HTTP enrollment or discovery route. */
export async function readEnrollmentFile(path: string) {
  if (!isAbsolute(path) || (await realpath(path)) !== path)
    throw new ProbeError('invalid_enrollment_file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 16384
    )
      throw new ProbeError('invalid_enrollment_file');
    const bytes = Buffer.alloc(16385);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16384) throw new ProbeError('invalid_enrollment_file');
    return enrollmentSchema.parse(
      JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')),
    );
  } finally {
    await file.close();
  }
}

/** Pins cannot be silently repointed to another project, trajectory, or Pocket grant. */
export function validateEnrollment(source: Enrollment) {
  if (
    source.readMode &&
    (source.sendMode || (source.initialOffset ?? 0) > 1980)
  )
    throw new ProbeError('coding_read_only');
  const url = new URL(source.observedAppUrl);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== `/c/${source.conversationId}` ||
    url.search !== `?project=${source.projectId}` ||
    [WORKSPACE_ID, APP_WORKSPACE].includes(source.workspaceId)
  )
    throw new ProbeError('enrollment_identity_rejected');
}

export function persistEnrollment(store: Store, source: Enrollment) {
  validateEnrollment(source);
  // Project membership is owner-attested from visible App URL, not an invented RPC field.
  const pin = JSON.stringify({
    workspaceId: source.workspaceId,
    projectId: source.projectId,
    conversationId: source.conversationId,
    trajectoryId: source.trajectoryId,
    marker: source.marker,
  });
  store.db.transaction(() => {
    const key = `app-enrollment:${source.conversationId}`;
    const rows = store.db
      .prepare(
        "SELECT key,value FROM metadata WHERE key LIKE 'app-enrollment:%'",
      )
      .all() as { key: string; value: string }[];
    const old = rows.find((r) => r.key === key);
    if (old) {
      if (old.value !== pin)
        throw new ProbeError('enrollment_identity_changed');
      return;
    }
    if (
      rows.length >= 8 ||
      rows.some(
        (r) => JSON.parse(r.value).workspaceId === source.workspaceId,
      ) ||
      store.db
        .prepare('SELECT id FROM workspaces WHERE id=?')
        .get(source.workspaceId) ||
      store.db
        .prepare(
          'SELECT session_id FROM external_sessions WHERE conversation_id=?',
        )
        .get(source.conversationId)
    )
      throw new ProbeError('enrollment_conflict_or_limit');
    store.db.prepare('INSERT INTO metadata VALUES(?,?)').run(key, pin);
  })();
}

export async function enrolledSources(
  store: Store,
  env: NodeJS.ProcessEnv,
): Promise<AppSource[]> {
  if (!env.POCKET_APP_ENROLLMENTS_FILE)
    throw new ProbeError('enrollment_required');
  const { sources } = await readEnrollmentFile(env.POCKET_APP_ENROLLMENTS_FILE);
  return createEnrolledSources(store, env, sources);
}

export async function createEnrolledSources(
  store: Store,
  env: NodeJS.ProcessEnv,
  sources: Enrollment[],
): Promise<AppSource[]> {
  if (
    new Set(sources.map((s) => s.conversationId)).size !== sources.length ||
    new Set(sources.map((s) => s.workspaceId)).size !== sources.length
  )
    throw new ProbeError('duplicate_enrollment');
  const result: AppSource[] = [];
  for (const source of sources) {
    let active = true;
    const controller = new AbortController();
    validateEnrollment(source);
    const runtime = { ...env, POCKET_APP_FIXTURE_ID: source.conversationId };
    const offset = () => {
      const row = store.db
        .prepare(
          'SELECT session_id FROM external_sessions WHERE conversation_id=?',
        )
        .get(source.conversationId) as { session_id: string } | undefined;
      if (source.readMode && row)
        return (
          store.session(row.session_id).external?.windowStart ??
          source.initialOffset ??
          0
        );
      return row
        ? Math.max(
            0,
            (store.session(row.session_id).external?.windowEnd ??
              store.session(row.session_id).external?.stepCount ??
              0) - 4,
          )
        : (source.initialOffset ?? 0);
    };
    const read = async (requestedOffset?: number) => {
      if (!active) throw new ProbeError('source_disabled');
      const observation = source.readMode
        ? await readCodingObservation(
            runtime,
            requestedOffset ?? offset(),
            controller.signal,
          )
        : await readAppObservation(runtime, offset());
      if (!active) throw new ProbeError('source_disabled');
      if (observation.trajectoryId !== source.trajectoryId)
        throw new ProbeError('enrollment_identity_changed');
      return observation;
    };
    const first = await read();
    const existing = store.db
      .prepare('SELECT value FROM metadata WHERE key=?')
      .get(`app-enrollment:${source.conversationId}`);
    if (
      !existing &&
      source.marker &&
      !first.steps.some(
        (s) => s.role === 'assistant' && s.text === source.marker,
      )
    )
      throw new ProbeError('enrollment_marker_missing');
    persistEnrollment(store, source);
    result.push({
      ...source,
      read,
      retire: () => {
        active = false;
        controller.abort();
      },
      ...(source.sendMode
        ? {
            prepareSend: () =>
              prepareAppSend(runtime, {
                trajectoryId: source.trajectoryId,
                sendMode: source.sendMode!,
                offset: offset(),
                observe: (observation) => {
                  if (!active) throw new ProbeError('source_disabled');
                  store.projectExternal(
                    source.workspaceId,
                    observation,
                    source.sendMode!,
                    source,
                  );
                },
              }),
          }
        : {}),
    });
  }
  return result;
}
