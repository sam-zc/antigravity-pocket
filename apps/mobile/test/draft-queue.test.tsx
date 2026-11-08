import { act, renderHook } from '@testing-library/react-native';
import { useChat } from '../src/features/chat/useChat';
let mockRelease: () => void;
const mockPrompt = jest.fn(async () => ({}));
let mockFirst = true;
const mockSave = jest.fn(async () => {
  if (mockFirst) {
    mockFirst = false;
    await new Promise<void>((resolve) => {
      mockRelease = resolve;
    });
  }
});
const mockRuntime = {
  cache: {
    draft: async () => ({ text: '', command: null }),
    saveDraft: mockSave,
  },
  api: { prompt: mockPrompt },
};
const mockConnection = {
  state: 'live',
  snapshot: {
    session: { id: 'session' },
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
  useConnection: (select: (value: typeof mockConnection) => unknown) =>
    select(mockConnection),
}));
jest.mock('expo-crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000002',
}));
jest.mock('expo-router', () => ({ useFocusEffect: jest.fn() }));
beforeEach(() => {
  mockFirst = true;
  jest.clearAllMocks();
});
it('coalesces edits behind slow storage and durably saves the exact command before sending', async () => {
  const view = await renderHook(() => useChat('session'));
  await act(async () => {});
  await act(async () => view.result.current.setDraft('first'));
  await act(async () => {
    for (let i = 0; i < 100; i++) view.result.current.setDraft('edit ' + i);
  });
  let sent: Promise<boolean>;
  await act(async () => {
    sent = view.result.current.send('edit 99');
  });
  expect(mockPrompt).not.toHaveBeenCalled();
  await act(async () => {
    mockRelease();
    await sent;
  });
  expect(mockPrompt).toHaveBeenCalledTimes(1);
  expect(mockPrompt).toHaveBeenCalledWith(
    'session',
    'edit 99',
    expect.any(String),
  );
  expect(mockSave.mock.calls.length).toBeLessThanOrEqual(4);
  expect(mockSave).toHaveBeenCalledWith(
    'session',
    'edit 99',
    expect.any(String),
  );
});

it('does not send a command after its session changes while storage is pending', async () => {
  const view = await renderHook(({ id }: { id: string }) => useChat(id), {
    initialProps: { id: 'session' },
  });
  await act(async () => {});
  let sent: Promise<boolean>;
  await act(async () => {
    sent = view.result.current.send('Old session text');
  });
  await view.rerender({ id: 'other-session' });
  await act(async () => {
    mockRelease();
    await sent;
  });
  expect(mockPrompt).not.toHaveBeenCalled();
});
it('keeps the saved command immutable when editing or duplicate sending races a pending save', async () => {
  const view = await renderHook(() => useChat('session'));
  await act(async () => {});
  let sent: Promise<boolean>;
  await act(async () => {
    sent = view.result.current.send('Exact intent');
    view.result.current.setDraft('Unexpected replacement');
    await view.result.current.send('Duplicate intent');
  });
  await act(async () => {
    mockRelease();
    await sent;
  });
  expect(mockPrompt).toHaveBeenCalledTimes(1);
  expect(mockPrompt).toHaveBeenCalledWith(
    'session',
    'Exact intent',
    expect.any(String),
  );
});
