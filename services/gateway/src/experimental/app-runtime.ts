import { readCodingWindow, type CodingReadMetrics } from './app-coding-read.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validateAppTrust } from './app-trust.js';
import {
  ProbeError,
  probeConfigSchema,
  readAppSteps,
  sendAppText,
  type ProbeConfig,
} from './app-probe.js';
import { normalizeAppSteps, type AppObservation } from './app-observation.js';

const exec = promisify(execFile);
const bundle = '/Applications/Antigravity.app';
const executable = `${bundle}/Contents/Resources/bin/language_server`;
async function command(file: string, args: string[]) {
  try {
    return (
      await exec(file, args, { timeout: 2000, maxBuffer: 65536 })
    ).stdout.trim();
  } catch {
    throw new ProbeError('runtime_inspection_failed');
  }
}

/** Inspect only the explicitly selected PID, never all process arguments. */
async function binding(config: ProbeConfig) {
  const ps = (fields: string) =>
    command('/bin/ps', ['-p', String(config.pid), '-o', fields]);
  if (
    process.platform !== 'darwin' ||
    !process.getuid ||
    (await ps('uid=')) !== String(process.getuid()) ||
    (await ps('comm=')) !== executable
  )
    throw new ProbeError('runtime_identity_rejected');
  const parent = await ps('ppid=');
  if (
    !/^\d+$/.test(parent) ||
    (await command('/bin/ps', ['-p', parent, '-o', 'comm='])) !==
      `${bundle}/Contents/MacOS/Antigravity` ||
    (await command('/bin/ps', ['-p', parent, '-o', 'uid='])) !==
      String(process.getuid())
  )
    throw new ProbeError('runtime_identity_rejected');
  const version = await command('/usr/bin/plutil', [
    '-extract',
    'CFBundleShortVersionString',
    'raw',
    '-o',
    '-',
    `${bundle}/Contents/Info.plist`,
  ]);
  if (version !== config.version) throw new ProbeError('unsupported_version');
  const listeners = await command('/usr/sbin/lsof', [
    '-nP',
    '-a',
    '-p',
    String(config.pid),
    '-iTCP',
    '-sTCP:LISTEN',
    '-Fn',
  ]);
  const addresses = listeners
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1));
  if (
    !addresses.includes(`127.0.0.1:${config.port}`) ||
    addresses.some(
      (address) =>
        address.endsWith(`:${config.port}`) &&
        address !== `127.0.0.1:${config.port}`,
    )
  )
    throw new ProbeError('endpoint_ownership_rejected');
  return `${config.pid}:${await ps('lstart=')}:${parent}:${version}:${config.port}`;
}

async function publicTrust(path: string): Promise<Buffer> {
  if (!isAbsolute(path) || (await realpath(path)) !== path)
    throw new ProbeError('invalid_trust_file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > 65536
    )
      throw new ProbeError('invalid_trust_file');
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const pem = bytes.subarray(0, bytesRead);
    if (
      bytesRead > 65536 ||
      !pem.includes('-----BEGIN CERTIFICATE-----') ||
      pem.includes('PRIVATE KEY')
    )
      throw new ProbeError('invalid_trust_file');
    return pem;
  } finally {
    await file.close();
  }
}

async function selectedRuntime(env: NodeJS.ProcessEnv) {
  if (env.POCKET_EXPERIMENTAL_APP_PROBE !== '1')
    throw new ProbeError('disabled');
  const parsed = probeConfigSchema.safeParse({
    enabled: true,
    version: env.POCKET_APP_VERSION,
    pid: Number(env.POCKET_APP_PID),
    port: Number(env.POCKET_APP_PORT),
    conversationId: env.POCKET_APP_FIXTURE_ID,
  });
  if (!parsed.success) throw new ProbeError('invalid_configuration');
  const config = parsed.data;
  const before = await binding(config);
  const args = await command('/bin/ps', [
    '-p',
    String(config.pid),
    '-o',
    'args=',
  ]);
  // Fixed flag names only; no host bridge/account credential is extracted.
  if (!/(?:^|\s)--app_data_dir(?:=|\s+)antigravity(?:\s|$)/.test(args))
    throw new ProbeError('wrong_namespace');
  if (
    args.match(/(?:^|\s)--override_ide_version(?:=|\s+)([^\s]+)/)?.[1] !==
    config.version
  )
    throw new ProbeError('unsupported_version');
  const matches = [...args.matchAll(/(?:^|\s)--csrf_token(?:=|\s+)([^\s]+)/g)];
  const csrf = matches.length === 1 ? matches[0]?.[1] : undefined;
  if (!csrf) throw new ProbeError('runtime_credential_unavailable');
  const ca = env.POCKET_APP_CA_FILE
    ? validateAppTrust(
        await publicTrust(env.POCKET_APP_CA_FILE),
        env.POCKET_APP_CERT_SHA256 ?? '',
      )
    : undefined;
  if ((await binding(config)) !== before)
    throw new ProbeError('runtime_changed');
  return { config, csrf, ca, before };
}
export async function readAppObservation(
  env: NodeJS.ProcessEnv,
  offset = 0,
): Promise<AppObservation> {
  const { config, csrf, ca, before } = await selectedRuntime(env);
  const result = await readAppSteps(config, csrf, ca, offset);
  if ((await binding(config)) !== before)
    throw new ProbeError('runtime_changed');
  return normalizeAppSteps(result.steps, config.conversationId, offset);
}

/** Validate an explicitly selected runtime and reviewed public trust without reading a chat. */
export async function verifyAppRuntime(env: NodeJS.ProcessEnv) {
  const runtime = await selectedRuntime({
    ...env,
    POCKET_APP_FIXTURE_ID: '00000000-0000-4000-8000-000000000001',
  });
  if (!runtime.ca) throw new ProbeError('invalid_configuration');
}

/** Bounded diagnostic: only enum names escape, never tool payloads or private reasoning. */
export async function inspectAppStepTypes(env: NodeJS.ProcessEnv, offset = 0) {
  const { config, csrf, ca, before } = await selectedRuntime(env);
  const result = await readAppSteps(config, csrf, ca, offset);
  if ((await binding(config)) !== before)
    throw new ProbeError('runtime_changed');
  return {
    returnedSteps: result.steps.length,
    types: [
      ...new Set(
        result.steps.map((s) =>
          typeof s.type === 'string' &&
          /^CORTEX_STEP_TYPE_[A-Z_]{1,80}$/.test(s.type)
            ? s.type
            : 'UNKNOWN',
        ),
      ),
    ],
  };
}

/** Preparation is read-only. The caller must journal dispatch and reauthorize before invoking the returned function. */
export async function prepareAppSend(
  env: NodeJS.ProcessEnv,
  enrollment: {
    trajectoryId: string;
    sendMode: 'fixture-text' | 'ordinary-text';
    offset: number;
    observe?: (value: AppObservation) => void;
  },
) {
  const { config, csrf, ca, before } = await selectedRuntime(env);
  if (!ca) throw new ProbeError('invalid_configuration');
  const observation = normalizeAppSteps(
    (await readAppSteps(config, csrf, ca, enrollment.offset)).steps,
    config.conversationId,
    enrollment.offset,
  );
  if (
    observation.trajectoryId !== enrollment.trajectoryId ||
    observation.steps.length > 16 ||
    observation.steps.at(-1)!.index >= 1996
  )
    throw new ProbeError('identity_or_history_limit');
  enrollment.observe?.(observation);
  if ((await binding(config)) !== before)
    throw new ProbeError('runtime_changed');
  return async (text: string) => {
    const ack = await sendAppText(config, csrf, ca, text, enrollment.sendMode);
    if ((await binding(config)) !== before)
      throw new ProbeError('runtime_changed');
    return ack;
  };
}

export async function runAppProbe(env: NodeJS.ProcessEnv) {
  if (env.POCKET_EXPERIMENTAL_APP_PROBE !== '1') return { status: 'disabled' };
  const result = await readAppObservation(env);
  return {
    status: 'read_only_probe_passed',
    stepCount: result.steps.length,
    complete: false,
    conversationId: result.conversationId,
    trajectoryId: result.trajectoryId,
    fixtureMarkerMatched: result.steps.some(
      (step) =>
        step.role === 'assistant' && step.text === 'POCKET-APP-20261107-READY',
    ),
  };
}

/** Fixed read-only binary window, with the same runtime/trust validation as the text connector. */
export async function readCodingObservation(
  env: NodeJS.ProcessEnv,
  offset = 0,
  signal?: AbortSignal,
  measure?: (value: CodingReadMetrics) => void,
): Promise<AppObservation> {
  const { config, csrf, ca, before } = await selectedRuntime(env);
  if (!ca) throw new ProbeError('invalid_configuration');
  const result = await readCodingWindow(
    config,
    csrf,
    ca,
    offset,
    signal,
    measure,
  );
  if ((await binding(config)) !== before)
    throw new ProbeError('runtime_changed');
  if (signal?.aborted) throw new ProbeError('cancelled');
  return result;
}
