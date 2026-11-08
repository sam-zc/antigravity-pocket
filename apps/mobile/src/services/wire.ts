import { transportFetch } from './transport-fetch';
import { errorSchema, type z } from '@pocket/protocol';
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterMs = 0,
  ) {
    super(message);
  }
}
export async function wire<T>(
  origin: string,
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  token?: string,
  key?: string,
): Promise<T> {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await transportFetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
    }).catch(() => {
      throw new ApiError(
        0,
        'network_unavailable',
        'Gateway connection unavailable. Check network and trusted setup.',
      );
    });
    if (
      response.redirected ||
      (response.url && new URL(response.url).origin !== origin)
    )
      throw new ApiError(0, 'transport', 'Gateway redirects are refused');
    const limit = 4 * 1024 * 1024;
    if (
      Number(response.headers.get('content-length') ?? 0) > limit ||
      !response.body
    )
      throw new ApiError(
        413,
        'response_limit',
        'Gateway response exceeded the client limit',
      );
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let text = '',
      bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > limit) {
          controller.abort();
          throw new ApiError(
            413,
            'response_limit',
            'Gateway response exceeded the client limit',
          );
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    const data: unknown = JSON.parse(text);
    if (!response.ok) {
      const e = errorSchema.safeParse(data);
      throw new ApiError(
        response.status,
        e.success ? e.data.code : 'request_failed',
        e.success ? e.data.message : 'Gateway request failed',
        Number(response.headers.get('retry-after') ?? 0) * 1000,
      );
    }
    return schema.parse(data);
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
