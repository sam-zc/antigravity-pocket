import { publicText as visible } from './app-public-text.js';
import { commandDetail } from './app-command-detail.js';
import { z, type AppActivity } from '@pocket/protocol';
import { ProbeError } from './app-probe.js';
import { selectedFields, single, bytes, integer, string } from './app-wire.js';
import { knownStepTypes } from './app-step-types.js';
import type { AppObservation } from './app-observation.js';

const labels: { [type: number]: string } = {
  5: 'Code action',
  7: 'Search code',
  8: 'Read file',
  9: 'List directory',
  13: 'Read code item',
  21: 'Run command',
  25: 'Find files',
  28: 'Command status',
  31: 'Read URL',
  32: 'Read content',
  33: 'Web search',
  38: 'External tool',
  47: 'Read file outline',
  65: 'Read terminal',
  73: 'Code search',
  82: 'User notification',
  86: 'File change',
  102: 'Wait',
};
const states: { [status: number]: AppActivity['state'] } = {
  1: 'pending',
  2: 'running',
  3: 'done',
  6: 'cancelled',
  7: 'failed',
  8: 'running',
  9: 'waiting',
  11: 'pending',
  12: 'unknown',
};
/** Decode only selected public fields. Tool arguments/results and reasoning are never decoded. */
export function decodeCodingStep(
  raw: Buffer,
  conversationId: string,
  expectedIndex: number,
): AppObservation['steps'][number] & { trajectoryId: string } {
  const step = selectedFields(raw, [1, 4, 5, 19, 20, 28]);
  const type = integer(single(step, 1)),
    status = integer(single(step, 4));
  const metadata = selectedFields(bytes(single(step, 5)), [12, 20, 39]);
  const sensitivity = integer(single(metadata, 39));
  if (sensitivity !== 0 && sensitivity !== 1)
    throw new ProbeError('unsafe_content');
  const source = selectedFields(bytes(single(metadata, 20)), [1, 2, 4]);
  const identity = z
    .object({
      executionId: z.string().uuid(),
      trajectoryId: z.string().uuid(),
      conversationId: z.literal(conversationId),
      index: z.literal(expectedIndex),
    })
    .safeParse({
      executionId: string(single(metadata, 12), 36),
      trajectoryId: string(single(source, 1), 36),
      conversationId: string(single(source, 4), 36),
      index: integer(single(source, 2)),
    });
  if (!identity.success) throw new ProbeError('upstream_identity_or_gap');
  const base = {
    index: expectedIndex,
    executionId: identity.data.executionId,
    trajectoryId: identity.data.trajectoryId,
    appStepType: type,
    done: status === 3,
  };
  if (type === 14) {
    const user = selectedFields(bytes(single(step, 19)), [3, 5, 9]);
    let text = '',
      omitted = user.has(5) || user.has(9);
    const items = user.get(3) ?? [];
    if (items.length > 100) throw new ProbeError('content_limit');
    for (const item of items) {
      const fields = selectedFields(bytes(item), [1, 2]);
      const value = single(fields, 1);
      if (value !== undefined) text += string(value, 262144);
      omitted ||= fields.has(2);
    }
    const part = visible(Buffer.from(text));
    if (part.text)
      return {
        ...base,
        role: 'user',
        text: part.text,
        contentOmitted: omitted || part.omitted,
      };
  } else if (type === 15) {
    const planner = selectedFields(bytes(single(step, 20)), [1, 8, 7, 20]);
    const part = visible(single(planner, 8) ?? single(planner, 1));
    if (part.text)
      return {
        ...base,
        role: 'assistant',
        text: part.text,
        contentOmitted: part.omitted || planner.has(7) || planner.has(20),
      };
  }
  const kind = labels[type]
    ? 'tool'
    : knownStepTypes.has(type)
      ? 'omitted'
      : 'unknown';
  return {
    ...base,
    role: 'activity',
    text: '',
    activity: {
      schemaVersion: 'app-2.29.0',
      kind,
      label:
        labels[type] ??
        (kind === 'unknown'
          ? 'Unrecognized App activity'
          : 'Other App activity'),
      upstreamType: type,
      state: states[status] ?? 'unknown',
      detailsOmitted: true,
      ...(type === 21 && step.has(28)
        ? { detail: commandDetail(bytes(single(step, 28))) }
        : {}),
    },
  };
}
