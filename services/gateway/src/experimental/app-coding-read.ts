import { budgetActivityDetails } from './app-detail-budget.js';
import { request } from 'node:https';
import {
  ProbeError,
  probeConfigSchema,
  type ProbeConfig,
} from './app-probe.js';
import { StepWindowParser, encodeVarint } from './app-wire.js';
import { decodeCodingStep } from './app-coding-step.js';
import type { AppObservation } from './app-observation.js';

export interface CodingReadMetrics {
  bytes: number;
  elapsedMs: number;
  peakBuffered: number;
  rows: number;
  boundary: 'window' | 'end' | 'error';
}
/** Fixed App 2.29.0 read. No arbitrary method, retry, redirect, total-count query or automatic pagination. */
export function readCodingWindow(
  config: ProbeConfig,
  csrf: string,
  ca: Buffer,
  offset = 0,
  signal?: AbortSignal,
  measure?: (value: CodingReadMetrics) => void,
): Promise<AppObservation> {
  if (
    !probeConfigSchema.safeParse(config).success ||
    !/^[\x21-\x7e]{1,4096}$/.test(csrf) ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 1980 ||
    !ca.length
  )
    throw new ProbeError('invalid_configuration');
  if (signal?.aborted) return Promise.reject(new ProbeError('cancelled'));
  return new Promise((resolve, reject) => {
    const start = performance.now();
    let done = false,
      received = 0,
      trajectoryId = '';
    const parser = new StepWindowParser((raw, index) => {
      const step = decodeCodingStep(raw, config.conversationId, offset + index);
      if (trajectoryId && trajectoryId !== step.trajectoryId)
        throw new ProbeError('upstream_identity_or_gap');
      trajectoryId = step.trajectoryId;
      return {
        index: step.index,
        executionId: step.executionId,
        role: step.role,
        text: step.text,
        done: step.done,
        activity: step.activity,
        appStepType: step.appStepType,
        contentOmitted: step.contentOmitted,
      };
    });
    const finish = (
      boundary: CodingReadMetrics['boundary'],
      error?: string,
    ) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      measure?.({
        bytes: received,
        elapsedMs: Math.round(performance.now() - start),
        peakBuffered: parser.peakBuffered,
        rows: parser.rows.length,
        boundary,
      });
      if (error) reject(new ProbeError(error));
      else if (!parser.rows.length)
        reject(new ProbeError('history_limit_or_empty'));
      else
        resolve({
          conversationId: config.conversationId,
          trajectoryId,
          view: 'coding',
          laterHistory: boundary === 'end' ? 'observed_end' : 'unobserved',
          steps: budgetActivityDetails(parser.rows),
        });
    };
    const payload = Buffer.concat([
      Buffer.from([10, 36]),
      Buffer.from(config.conversationId),
      Buffer.from([16]),
      encodeVarint(offset),
      Buffer.from([32, 2]),
    ]);
    const req = request(
      {
        hostname: '127.0.0.1',
        port: config.port,
        servername: 'localhost',
        rejectUnauthorized: true,
        ca,
        agent: false,
        method: 'POST',
        path: '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps',
        headers: {
          'Content-Type': 'application/proto',
          'Connect-Protocol-Version': '1',
          'Connect-Timeout-Ms': '3000',
          'Content-Length': payload.length,
          'x-codeium-csrf-token': csrf,
        },
      },
      (res) => {
        if (
          res.statusCode !== 200 ||
          res.headers['content-type']?.split(';')[0] !== 'application/proto' ||
          res.headers['content-encoding']
        ) {
          finish(
            'error',
            res.statusCode === 401 || res.statusCode === 403
              ? 'upstream_auth_rejected'
              : 'incompatible_response',
          );
          req.destroy();
          return;
        }
        res.on('data', (chunk: Buffer) => {
          if (done) return;
          received += chunk.length;
          try {
            if (received > 2097152) throw new ProbeError('response_limit');
            if (parser.push(chunk)) {
              finish('window');
              req.destroy();
            }
          } catch (error) {
            finish(
              'error',
              error instanceof ProbeError
                ? error.code
                : 'incompatible_response',
            );
            req.destroy();
          }
        });
        res.on('end', () => {
          if (done) return;
          try {
            parser.finish();
            finish('end');
          } catch {
            finish('error', 'truncated_wire');
          }
        });
        res.on('error', () => finish('error', 'transport_failed'));
        res.on('aborted', () => finish('error', 'transport_failed'));
      },
    );
    const cancel = () => {
      finish('error', 'cancelled');
      req.destroy();
    };
    const timer = setTimeout(() => {
      finish('error', 'timeout');
      req.destroy();
    }, 3000);
    signal?.addEventListener('abort', cancel, { once: true });
    req.on('error', () => finish('error', 'tls_or_transport_failed'));
    req.end(payload);
  });
}
