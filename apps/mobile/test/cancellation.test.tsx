import React from 'react';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react-native';
import { type Snapshot, type Receipt, WORKSPACE_ID } from '@pocket/protocol';
import { useRunCancellation } from '../src/features/chat/useRunCancellation';
import { CancelResponseSheet } from '../src/features/chat/CancelResponseSheet';
import { MessageBubble } from '../src/features/chat/MessageBubble';

function snapshot(
  state: 'running' | 'cancelled' | 'completed' = 'running',
  sessionId = 'session',
): Snapshot {
  return {
    session: {
      id: sessionId,
      title: 'Test',
      workspaceId: WORKSPACE_ID,
      adapterId: 'mock',
      revision: 1,
      createdAt: '2026-11-06T00:00:00Z',
      updatedAt: '2026-11-06T00:00:00Z',
    },
    streamId: `session:${sessionId}`,
    through: 1,
    messages: [],
    tools: [],
    historyBefore: null,
    runs: [
      { id: 'run', sessionId, clientMessageId: 'command', state, reason: null },
    ],
  };
}
const receipt: Receipt = {
  accepted: true,
  commandId: 'command',
  sessionId: 'session',
  runId: 'run',
};
it('waits for durable terminal state after HTTP ack, prevents double cancel, and recovers across disconnect', async () => {
  const api = { cancel: jest.fn().mockResolvedValue(receipt) };
  const retry = jest.fn();
  const onError = jest.fn();
  const { result, rerender } = await renderHook(
    (props: { snapshot: Snapshot | null; live: boolean }) =>
      useRunCancellation({
        sessionId: 'session',
        api,
        retry,
        onError,
        ...props,
      }),
    { initialProps: { snapshot: snapshot(), live: true } },
  );
  await act(async () => {
    await Promise.all([result.current.stop('run'), result.current.stop('run')]);
  });
  expect(api.cancel).toHaveBeenCalledTimes(1);
  expect(result.current.stopping).toBe(true);
  await rerender({ snapshot: null, live: false });
  expect(result.current.stopping).toBe(true);
  await rerender({ snapshot: snapshot('cancelled'), live: true });
  expect(result.current.stopping).toBe(false);
  expect(onError).toHaveBeenLastCalledWith('');
});
it('does not cancel a replacement run or a run that finished while confirmation was open', async () => {
  const api = { cancel: jest.fn().mockResolvedValue(receipt) };
  const props = {
    sessionId: 'session',
    api,
    retry: jest.fn(),
    onError: jest.fn(),
    live: true,
  };
  const { result, rerender } = await renderHook(
    (s: Snapshot) => useRunCancellation({ ...props, snapshot: s }),
    { initialProps: snapshot('completed') },
  );
  await act(() => result.current.stop('run'));
  const next = snapshot();
  next.runs[0]!.id = 'replacement';
  await rerender(next);
  await act(() => result.current.stop('run'));
  expect(api.cancel).not.toHaveBeenCalled();
});
it('retains the idempotency key after uncertain cancellation delivery', async () => {
  const api = {
    cancel: jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(receipt),
  };
  const onError = jest.fn();
  const { result } = await renderHook(() =>
    useRunCancellation({
      sessionId: 'session',
      api,
      snapshot: snapshot(),
      live: true,
      retry: jest.fn(),
      onError,
    }),
  );
  await act(() => result.current.stop('run'));
  expect(result.current.stopping).toBe(false);
  expect(onError).toHaveBeenLastCalledWith(
    'Stop was not confirmed. Retry when connected.',
  );
  await act(() => result.current.stop('run'));
  expect(api.cancel.mock.calls[1]).toEqual(api.cancel.mock.calls[0]);
  expect(result.current.stopping).toBe(true);
});
it('ignores a late failure after terminal delivery or a session switch', async () => {
  let reject!: (error: Error) => void;
  const api = {
    cancel: jest.fn(
      () =>
        new Promise<Receipt>((_resolve, fail) => {
          reject = fail;
        }),
    ),
  };
  const onError = jest.fn();
  const { result, rerender } = await renderHook(
    (s: Snapshot) =>
      useRunCancellation({
        sessionId: s.session.id,
        api,
        snapshot: s,
        live: true,
        retry: jest.fn(),
        onError,
      }),
    { initialProps: snapshot() },
  );
  let request!: Promise<void>;
  await act(() => {
    request = result.current.stop('run');
  });
  await rerender(snapshot('completed', 'other-session'));
  onError.mockClear();
  await act(async () => {
    reject(new Error('late timeout'));
    await request;
  });
  expect(result.current.stopping).toBe(false);
  expect(onError).not.toHaveBeenCalled();
});
it('reconciles a missing stream event without inventing a terminal state', async () => {
  jest.useFakeTimers();
  try {
    const retry = jest.fn();
    const { result } = await renderHook(() =>
      useRunCancellation({
        sessionId: 'session',
        api: stableApi,
        snapshot: snapshot(),
        live: true,
        retry,
        onError: jest.fn(),
      }),
    );
    await act(() => result.current.stop('run'));
    await act(() => jest.advanceTimersByTime(5000));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.current.stopping).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});
const stableApi = { cancel: jest.fn().mockResolvedValue(receipt) };
it('No and backdrop dismiss without cancellation, while Yes explicitly confirms', async () => {
  const confirm = jest.fn();
  const close = jest.fn();
  await render(
    <CancelResponseSheet open onConfirm={confirm} onClose={close} />,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'No' }));
  await fireEvent.press(
    screen.getByRole('button', { name: 'Dismiss overlay' }),
  );
  expect(close).toHaveBeenCalledTimes(2);
  expect(confirm).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Yes, cancel' }));
  expect(confirm).toHaveBeenCalledTimes(1);
});
it('does not show ongoing activity or copy an empty answer after early cancellation', async () => {
  await render(
    <MessageBubble
      busy={false}
      message={{
        id: 'answer',
        sessionId: 'session',
        runId: 'run',
        ordinal: 2,
        role: 'assistant',
        status: 'cancelled',
        revision: 2,
        text: '',
      }}
    />,
  );
  expect(screen.getByText('Stopped')).toBeTruthy();
  expect(screen.queryByLabelText('Preparing response')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Copy answer' })).toBeNull();
});

it('clears uncertain-delivery feedback when replay subsequently confirms cancellation', async () => {
  const api = {
    cancel: jest.fn().mockRejectedValue(new Error('lost response')),
  };
  const onError = jest.fn();
  const { result, rerender } = await renderHook(
    (value: Snapshot) =>
      useRunCancellation({
        sessionId: 'session',
        api,
        snapshot: value,
        live: true,
        retry: jest.fn(),
        onError,
      }),
    { initialProps: snapshot() },
  );
  await act(() => result.current.stop('run'));
  expect(onError).toHaveBeenLastCalledWith(
    'Stop was not confirmed. Retry when connected.',
  );
  await rerender(snapshot('cancelled'));
  expect(onError).toHaveBeenLastCalledWith('');
  expect(result.current.stopping).toBe(false);
});
