import { act, renderHook } from '@testing-library/react-native';
import { useChat } from '../src/features/chat/useChat';
import type { AppCommand } from '@pocket/protocol';
const text =
  'Reply with exactly POCKET-APP-NATIVE-TEST. Text only. Do not use tools, files, commands, or network.';
const key = '00000000-0000-4000-8000-000000000002';
let mockDraft = { text: '', command: null as string | null };
let mockCommand: AppCommand;
const mockSave = jest.fn(
  async (_id: string, text: string, command: string | null) => {
    mockDraft = { text, command };
  },
);
const mockSend = jest.fn(async () => {
  throw new Error('lost acknowledgement');
});
const mockRead = jest.fn(async () => mockCommand);
const mockResolve = jest.fn(async () => ({
  ...mockCommand,
  resolvedAt: '2026-11-07T00:00:00.000Z',
}));
const mockRuntime = {
  cache: { draft: async () => mockDraft, saveDraft: mockSave },
  api: {
    appSend: mockSend,
    appCommand: mockRead,
    resolveAppCommand: mockResolve,
  },
};
const mockConnection = {
  state: 'live',
  snapshot: {
    session: {
      id: 'session',
      adapterId: 'antigravity-experimental',
      external: { send: 'fixture-text', observation: 'fresh' },
    },
    runs: [],
    messages: [],
    historyBefore: null,
  },
};
const mockActivate = jest.fn();
jest.mock('../src/services/PocketProvider', () => ({
  usePocket: () => ({
    runtime: mockRuntime,
    activate: mockActivate,
    retry: jest.fn(),
  }),
  useConnection: (select: (s: typeof mockConnection) => unknown) =>
    select(mockConnection),
}));
jest.mock('expo-crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000002',
}));
jest.mock('expo-router', () => ({ useFocusEffect: jest.fn() }));
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockDraft = { text: '', command: null };
  mockConnection.state = 'live';
  mockConnection.snapshot.session.id = 'session';
  mockConnection.snapshot.session.external.send = 'fixture-text';
  mockCommand = {
    commandId: key,
    sessionId: 'session',
    conversationId: 'app',
    trajectoryId: 'trajectory',
    receivedAt: '2026-11-07T00:00:00.000Z',
    delivery: 'uncertain',
    observedResult: 'not_correlated',
  };
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});
it('persists before sending, guards duplicate taps, locks uncertain intent and only polls after remount; resolution never resends', async () => {
  const view = await renderHook(() => useChat('session'));
  await act(async () => {});
  await act(async () => {
    await Promise.all([
      view.result.current.send(text),
      view.result.current.send(text),
    ]);
  });
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSave.mock.invocationCallOrder[0]).toBeLessThan(
    mockSend.mock.invocationCallOrder[0]!,
  );
  expect(mockDraft).toEqual({ text, command: key });
  await act(async () =>
    view.result.current.setDraft('edited to evade uncertainty'),
  );
  expect(view.result.current.draft).toBe(text);
  await act(async () => jest.advanceTimersByTime(2100));
  expect(view.result.current.appCommand?.delivery).toBe('uncertain');
  expect(mockSend).toHaveBeenCalledTimes(1);
  await view.unmount();
  const next = await renderHook(() => useChat('session'));
  await act(async () => {});
  expect(next.result.current.appPending?.key).toBe(key);
  expect(mockSend).toHaveBeenCalledTimes(1);
  await act(async () => next.result.current.resolveApp());
  expect(mockResolve).toHaveBeenCalledWith('session', text, key);
  expect(next.result.current.appCommand?.delivery).toBe('uncertain');
  expect(next.result.current.appPending).toBeNull();
  expect(mockDraft).toEqual({ text: '', command: null });
  expect(mockSend).toHaveBeenCalledTimes(1);
});
it('restores an unknown local receipt using read-only lookup and does not silently resubmit a missing command', async () => {
  mockDraft = { text, command: key };
  mockRead.mockRejectedValueOnce(new Error('404'));
  const view = await renderHook(() => useChat('session'));
  await act(async () => {});
  expect(view.result.current.appPending?.key).toBe(key);
  expect(mockSend).not.toHaveBeenCalled();
  await act(async () => view.result.current.send(text));
  expect(mockSend).not.toHaveBeenCalled();
});

it('does not downgrade a reconciled acknowledgement when a delayed local receipt arrives', async () => {
  let release!: (value: never) => void;
  mockSend.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  mockCommand = {
    ...mockCommand,
    delivery: 'acknowledged',
    acknowledgement: {},
    acknowledgedAt: '2026-11-07T00:00:01.000Z',
  };
  const view = await renderHook(() => useChat('session'));
  await act(async () => {});
  let sending!: Promise<boolean>;
  await act(async () => {
    sending = view.result.current.send(text);
  });
  await act(async () => {});
  expect(view.result.current.appCommand?.delivery).toBe('acknowledged');
  await act(async () => {
    release({ ...mockCommand, delivery: 'received' } as never);
    await sending;
  });
  expect(view.result.current.appCommand?.delivery).toBe('acknowledged');
  expect(view.result.current.appPending).toBeNull();
});

it('accepts ordinary text only with that capability and rejects oversized UTF-8 without dispatch', async () => {
  mockConnection.snapshot.session.external.send = 'ordinary-text';
  const view = await renderHook(() => useChat('session'));
  await act(async () => {});
  await act(async () => {
    await view.result.current.send('🙂'.repeat(513));
  });
  expect(mockSend).not.toHaveBeenCalled();
  expect(view.result.current.error).toContain('2048');
  await act(async () => {
    await view.result.current.send('Please say hello, using text only.');
  });
  expect(mockSend).toHaveBeenCalledWith(
    'session',
    'Please say hello, using text only.',
    key,
  );
});
it('ignores a delayed old receipt after switching conversation and keeps the new draft isolated', async () => {
  let release!: (value: never) => void;
  mockSend.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const view = await renderHook<ReturnType<typeof useChat>, { id: string }>(
    ({ id }) => useChat(id),
    {
      initialProps: { id: 'session' },
    },
  );
  await act(async () => {});
  let sending!: Promise<boolean>;
  await act(async () => {
    sending = view.result.current.send(text);
  });
  mockDraft = { text: 'New conversation draft', command: null };
  mockConnection.snapshot.session.id = 'session-b';
  await view.rerender({ id: 'session-b' });
  await act(async () => {});
  await act(async () => {
    release({ ...mockCommand, delivery: 'acknowledged' } as never);
    await sending;
  });
  expect(view.result.current.draft).toBe('New conversation draft');
  expect(view.result.current.appCommand).toBeNull();
  expect(view.result.current.appPending).toBeNull();
  expect(mockSend).toHaveBeenCalledTimes(1);
});

it('does not dispatch after going offline during intent persistence and restores the same protected ID', async () => {
  let release!: () => void;
  mockSave.mockImplementationOnce(async (_id, text, command) => {
    await new Promise<void>((r) => {
      release = r;
    });
    mockDraft = { text, command };
  });
  const view = await renderHook(() => useChat('session'));
  await act(async () => {});
  let sending!: Promise<boolean>;
  await act(async () => {
    sending = view.result.current.send(text);
  });
  mockConnection.state = 'reconnecting';
  await view.rerender(undefined);
  await act(async () => {
    release();
    await sending;
  });
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockDraft.command).toBe(key);
  await view.unmount();
  const next = await renderHook(() => useChat('session'));
  await act(async () => {});
  expect(next.result.current.appPending?.key).toBe(key);
  await act(async () => next.result.current.setDraft('new intent'));
  expect(mockDraft.command).toBe(key);
  expect(mockSend).not.toHaveBeenCalled();
});
it('hides drafts and ignores delayed receipt after authority is withdrawn', async () => {
  let release!: (value: never) => void;
  mockSend.mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const view = await renderHook(() => useChat('session'));
  await act(async () => {});
  let sending!: Promise<boolean>;
  await act(async () => {
    sending = view.result.current.send(text);
  });
  mockConnection.state = 'auth-required';
  await view.rerender(undefined);
  await act(async () => {
    release({ ...mockCommand, delivery: 'acknowledged' } as never);
    await sending;
  });
  expect(view.result.current.draft).toBe('');
  expect(view.result.current.appCommand).toBeNull();
  expect(view.result.current.loaded).toBe(false);
  expect(mockDraft.command).toBe(key);
});

it('keeps receipt protection but denies resolution and sends after effective write capability is withdrawn', async () => {
  mockDraft = { text, command: key };
  const view = await renderHook(() => useChat('session'));
  await act(async () => {});
  mockConnection.snapshot.session.external.send = '';
  await view.rerender(undefined);
  await act(async () => {
    await view.result.current.resolveApp();
    await view.result.current.send('New text');
  });
  expect(mockResolve).not.toHaveBeenCalled();
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockRead).toHaveBeenCalled();
  expect(mockDraft.command).toBe(key);
});
