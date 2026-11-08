import {
  bootstrapSchema,
  appCommandSchema,
  messagePageSchema,
  receiptSchema,
  sessionPageSchema,
  snapshotSchema,
  ticketSchema,
  WORKSPACE_ID,
  z,
  workspaceSchema,
  httpsOriginSchema,
} from '@pocket/protocol';
import { wire, ApiError } from './wire';
export { ApiError } from './wire';
export interface SessionCredential {
  token: () => Promise<string>;
  clear: () => Promise<void>;
}
export class Api {
  private workspaceId = WORKSPACE_ID;
  constructor(
    readonly origin: string,
    private token: string,
    readonly credential?: SessionCredential,
  ) {
    const url = new URL(origin);
    if (
      (credential
        ? !httpsOriginSchema.safeParse(origin).success
        : url.protocol !== 'http:' || url.hostname !== '127.0.0.1') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error(
        'Development credentials require loopback; pairing requires an exact HTTPS origin',
      );
    this.origin = url.origin;
  }
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    key?: string,
  ): Promise<T> {
    try {
      return await wire(
        this.origin,
        path,
        schema,
        body,
        this.credential ? await this.credential.token() : this.token,
        key,
      );
    } catch (error) {
      if (this.credential && error instanceof ApiError && error.status === 401)
        await this.invalidate(error.code);
      throw error;
    }
  }
  onInvalid: (code: string) => Promise<void> = async () => {};
  beforeSync: () => Promise<void> = async () => {};
  async invalidate(code: string) {
    try {
      await this.credential?.clear();
    } finally {
      await this.onInvalid(code);
    }
  }
  workspaces() {
    return this.request(
      '/v1/workspaces',
      z.object({ items: z.array(workspaceSchema).max(100) }).strict(),
    );
  }
  files(id: string, path = '') {
    return this.request(
      `/v1/workspaces/${id}/files?path=${encodeURIComponent(path)}`,
      z
        .object({
          entries: z
            .array(
              z
                .object({
                  path: z.string().max(1024),
                  kind: z.enum(['file', 'directory']),
                })
                .strict(),
            )
            .max(1000),
        })
        .strict(),
    );
  }
  readFile(id: string, path: string) {
    return this.request(
      `/v1/workspaces/${id}/read`,
      z
        .object({
          path: z.string(),
          text: z.string().max(65536),
          hash: z.string(),
        })
        .strict(),
      { path },
    );
  }
  git(id: string, operation: 'status' | 'diff', path?: string) {
    return this.request(
      `/v1/workspaces/${id}/git`,
      z.object({ text: z.string().max(262144) }).strict(),
      { operation, ...(path ? { path } : {}) },
    );
  }
  async bootstrap() {
    const result = await this.request('/v1/bootstrap', bootstrapSchema);
    if (result.device)
      this.workspaceId =
        result.device.grants.find(
          (g) =>
            g.scopes.includes('session:read') &&
            g.scopes.includes('session:write'),
        )?.workspaceId ?? '';
    return result;
  }
  sessions(cursor?: string) {
    return this.request(
      `/v1/sessions${cursor ? `?cursor=${cursor}` : ''}`,
      sessionPageSchema,
    );
  }
  snapshot(id: string) {
    return this.request(`/v1/sessions/${id}/snapshot`, snapshotSchema);
  }
  nextAppHistory(id: string, expectedEnd: number) {
    return this.request(`/v1/sessions/${id}/app-history/next`, snapshotSchema, {
      protocolVersion: 1,
      expectedEnd,
    });
  }
  history(id: string, before: number) {
    return this.request(
      `/v1/sessions/${id}/messages?before=${before}`,
      messagePageSchema,
    );
  }
  create(title: string, key: string) {
    if (!this.workspaceId)
      throw new ApiError(
        403,
        'scope_required',
        'The desktop owner has not granted chat creation for a workspace',
      );
    return this.request(
      '/v1/sessions',
      receiptSchema,
      {
        protocolVersion: 1,
        title,
        workspaceId: this.workspaceId,
        adapterId: 'mock',
      },
      key,
    );
  }
  prompt(id: string, text: string, key: string) {
    return this.request(
      `/v1/sessions/${id}/messages`,
      receiptSchema,
      { protocolVersion: 1, clientMessageId: key, text },
      key,
    );
  }
  appSend(id: string, text: string, key: string) {
    return this.request(
      `/v1/sessions/${id}/app-commands`,
      appCommandSchema,
      { protocolVersion: 1, clientMessageId: key, text },
      key,
    );
  }
  appCommand(id: string, key: string) {
    return this.request(
      `/v1/sessions/${id}/app-commands/${key}`,
      appCommandSchema,
    );
  }
  resolveAppCommand(id: string, text: string, key: string) {
    return this.request(
      `/v1/sessions/${id}/app-commands/${key}/resolve`,
      appCommandSchema,
      {
        protocolVersion: 1,
        clientMessageId: key,
        text,
        decision: 'reviewed_no_resend',
      },
    );
  }
  cancel(id: string, key: string) {
    return this.request(
      `/v1/runs/${id}/cancel`,
      receiptSchema,
      { protocolVersion: 1 },
      key,
    );
  }
  ticket() {
    return this.request('/v1/auth/ws-ticket', ticketSchema, {});
  }
}
