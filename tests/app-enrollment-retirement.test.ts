import { it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../services/gateway/src/db/store.js';
import {
  createEnrolledSources,
  type Enrollment,
} from '../services/gateway/src/experimental/app-enrollment.js';
import {
  readAppObservation,
  prepareAppSend,
} from '../services/gateway/src/experimental/app-runtime.js';
vi.mock('../services/gateway/src/experimental/app-runtime.js', () => ({
  readAppObservation: vi.fn(),
  prepareAppSend: vi.fn(),
}));

it('retires an in-flight send preflight without republishing obsolete capabilities or sending', async () => {
  const store = new Store(':memory:');
  const conversationId = randomUUID(),
    trajectoryId = randomUUID(),
    projectId = randomUUID();
  const record: Enrollment = {
    workspaceId: randomUUID(),
    projectId,
    conversationId,
    trajectoryId,
    title: 'Selected',
    observedAppUrl: `http://127.0.0.1:12345/c/${conversationId}?project=${projectId}`,
    disposable: true,
    sendMode: 'ordinary-text',
  };
  const observation = {
    conversationId,
    trajectoryId,
    steps: [
      {
        index: 0,
        executionId: randomUUID(),
        role: 'assistant' as const,
        text: 'Visible',
        done: true,
      },
    ],
  };
  vi.mocked(readAppObservation).mockResolvedValue(observation);
  let release!: () => void;
  const send = vi.fn(async () => ({}));
  vi.mocked(prepareAppSend).mockImplementation(async (_env, options) => {
    await new Promise<void>((r) => {
      release = r;
    });
    options.observe?.(observation);
    return send;
  });
  try {
    const source = (await createEnrolledSources(store, {}, [record]))[0]!;
    const preparing = source.prepareSend!();
    source.retire!();
    release();
    await expect(preparing).rejects.toThrow('source_disabled');
    await expect(source.read()).rejects.toThrow('source_disabled');
    expect(
      store.db.prepare('SELECT COUNT(*) n FROM external_sessions').get(),
    ).toEqual({ n: 0 });
    expect(send).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});
