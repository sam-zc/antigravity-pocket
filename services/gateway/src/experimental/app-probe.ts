// Independently authored fixed read transport shared by the probe and opt-in reader.
import { request } from 'node:https';
import { z } from 'zod';
import {
  appSendTextSchema,
  appOrdinaryTextSchema,
  appAcknowledgementSchema,
  type AppAcknowledgement,
} from '@pocket/protocol';

export class ProbeError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'ProbeError';
  }
}

export const probeConfigSchema = z
  .object({
    enabled: z.literal(true),
    version: z.literal('2.29.0'),
    pid: z.number().int().positive(),
    port: z.number().int().min(1).max(65535),
    conversationId: z.string().uuid(),
  })
  .strict();
export type ProbeConfig = z.infer<typeof probeConfigSchema>;

const responseSchema = z.object({
  steps: z.array(z.record(z.string(), z.unknown())).max(100).default([]),
});

/** One fixed read, no routing, retries, redirects, polling or mutation methods.
 * Process ownership must be checked by the local entry point before and after.
 * Only a count escapes this diagnostic; upstream objects are never logged.
 */
export async function probeHistory(
  config: ProbeConfig,
  csrf: string,
  ca?: Buffer,
): Promise<{ stepCount: number; complete: false }> {
  const result = await readAppSteps(config, csrf, ca);
  return { stepCount: result.steps.length, complete: false };
}

export async function readAppSteps(
  config: ProbeConfig,
  csrf: string,
  ca?: Buffer,
  stepOffset = 0,
): Promise<z.infer<typeof responseSchema>> {
  if (!Number.isInteger(stepOffset) || stepOffset < 0 || stepOffset > 2000)
    throw new ProbeError('invalid_offset');
  return responseSchema.parse(
    await fixedRequest(config, csrf, ca, 'GetCascadeTrajectorySteps', {
      cascadeId: config.conversationId,
      stepOffset,
    }),
  );
}

export async function sendAppText(
  config: ProbeConfig,
  csrf: string,
  ca: Buffer,
  text: string,
  mode: 'fixture-text' | 'ordinary-text' = 'fixture-text',
): Promise<AppAcknowledgement> {
  const body = {
    cascadeId: config.conversationId,
    metadata: {
      ideName: 'antigravity-pocket-experimental',
      ideVersion: '0.1.0',
      extensionVersion: '0.1.0',
    },
    items: [
      {
        text: (mode === 'ordinary-text'
          ? appOrdinaryTextSchema
          : appSendTextSchema
        ).parse(text),
      },
    ],
  };
  const acknowledgement = appAcknowledgementSchema.parse(
    await fixedRequest(config, csrf, ca, 'SendUserCascadeMessage', body),
  );
  if (
    acknowledgement.cascadeId &&
    acknowledgement.cascadeId !== config.conversationId
  )
    throw new ProbeError('upstream_identity_changed');
  return acknowledgement;
}

async function fixedRequest(
  config: ProbeConfig,
  csrf: string,
  ca: Buffer | undefined,
  method: 'GetCascadeTrajectorySteps' | 'SendUserCascadeMessage',
  body: unknown,
): Promise<unknown> {
  if (
    !probeConfigSchema.safeParse(config).success ||
    !/^[\x21-\x7e]{1,4096}$/.test(csrf)
  )
    throw new ProbeError('invalid_configuration');
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: string, data?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      if (error) reject(new ProbeError(error));
      else resolve(data!);
    };
    const payload = JSON.stringify(body);
    const req = request(
      {
        hostname: '127.0.0.1',
        port: config.port,
        servername: 'localhost',
        rejectUnauthorized: true,
        ...(ca ? { ca } : {}),
        agent: false,
        method: 'POST',
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'Content-Length': Buffer.byteLength(payload),
          'x-codeium-csrf-token': csrf,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          finish(
            res.statusCode === 401 || res.statusCode === 403
              ? 'upstream_auth_rejected'
              : 'upstream_http_rejected',
          );
          res.destroy();
          return;
        }
        if (
          !res.headers['content-type']
            ?.toLowerCase()
            .startsWith('application/json')
        ) {
          finish('incompatible_response');
          res.destroy();
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 64 * 1024) {
            finish('response_limit');
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', () => finish('transport_failed'));
        res.on('aborted', () => finish('transport_failed'));
        res.on('end', () => {
          if (done) return;
          try {
            const parsed = (
              method === 'GetCascadeTrajectorySteps'
                ? responseSchema
                : appAcknowledgementSchema
            ).safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            if (!parsed.success) {
              finish('incompatible_response');
              return;
            }
            finish(undefined, parsed.data);
          } catch {
            finish('incompatible_response');
          }
        });
      },
    );
    const deadline = setTimeout(() => {
      finish('timeout');
      req.destroy();
    }, 3000);
    req.on('error', (error: NodeJS.ErrnoException) => {
      const tlsCodes = [
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'CERT_HAS_EXPIRED',
        'ERR_TLS_CERT_ALTNAME_INVALID',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      ];
      finish(
        tlsCodes.includes(error.code ?? '')
          ? 'tls_trust_failed'
          : 'transport_failed',
      );
    });
    req.end(payload);
  });
}
