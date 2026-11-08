import { z } from 'zod';
import { ProbeError } from './app-probe.js';
import type { AppActivity } from '@pocket/protocol';

const stepSchema = z.object({
  type: z.enum([
    'CORTEX_STEP_TYPE_USER_INPUT',
    'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
  ]),
  status: z.enum(['CORTEX_STEP_STATUS_DONE', 'CORTEX_STEP_STATUS_RUNNING']),
  metadata: z.object({
    executionId: z.string().uuid(),
    sourceTrajectoryStepInfo: z.object({
      cascadeId: z.string().uuid(),
      trajectoryId: z.string().uuid(),
      stepIndex: z.number().int().min(0).default(0),
    }),
  }),
  userInput: z
    .object({
      items: z.array(z.object({ text: z.string().max(8192) }).strict()).max(20),
      media: z.array(z.unknown()).max(0).optional(),
    })
    .optional(),
  plannerResponse: z
    .object({
      response: z.string().max(8192),
      modifiedResponse: z.string().max(8192).optional(),
      toolCalls: z.array(z.unknown()).max(0).optional(),
      items: z
        .array(z.object({ text: z.string().max(8192) }).strict())
        .max(20)
        .optional(),
    })
    .optional(),
});
export interface AppObservation {
  conversationId: string;
  trajectoryId: string;
  view?: 'coding';
  laterHistory?: 'unobserved' | 'observed_end';
  steps: {
    index: number;
    executionId: string;
    role: 'user' | 'assistant' | 'activity';
    text: string;
    done: boolean;
    activity?: AppActivity;
    appStepType?: number;
    contentOmitted?: boolean;
  }[];
}
export function normalizeAppSteps(
  raw: unknown[],
  conversationId: string,
  offset = 0,
): AppObservation {
  if (
    !raw.length ||
    raw.length > 20 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset + raw.length > 2000
  )
    throw new ProbeError('history_limit_or_empty');
  let trajectoryId = '';
  const steps = raw.map((value, index) => {
    const parsed = stepSchema.safeParse(value);
    if (!parsed.success) throw new ProbeError('unsupported_step_or_gap');
    const step = parsed.data,
      source = step.metadata.sourceTrajectoryStepInfo;
    if (
      source.cascadeId !== conversationId ||
      source.stepIndex !== offset + index ||
      (trajectoryId && trajectoryId !== source.trajectoryId)
    )
      throw new ProbeError('upstream_identity_or_gap');
    trajectoryId = source.trajectoryId;
    const role =
      step.type === 'CORTEX_STEP_TYPE_USER_INPUT'
        ? ('user' as const)
        : ('assistant' as const);
    const text =
      role === 'user'
        ? step.userInput?.items.map((item) => item.text).join('')
        : (step.plannerResponse?.modifiedResponse ??
          step.plannerResponse?.response);
    if (text === undefined || Buffer.byteLength(text) > 8192)
      throw new ProbeError('unsupported_step_or_gap');
    return {
      index: offset + index,
      executionId: step.metadata.executionId,
      role,
      text,
      done: step.status === 'CORTEX_STEP_STATUS_DONE',
    };
  });
  const result = { conversationId, trajectoryId, steps };
  if (Buffer.byteLength(JSON.stringify(result)) > 24000)
    throw new ProbeError('projection_limit');
  return result;
}
