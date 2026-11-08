import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { WORKSPACE_ID, type Snapshot } from '@pocket/protocol';
import { ChatScreen } from '../src/features/chat/ChatScreen';
import type { useChat } from '../src/features/chat/useChat';
let mockChat: ReturnType<typeof useChat>;
const mockReauthenticate = jest.fn();
jest.mock('../src/features/chat/useChat', () => ({ useChat: () => mockChat }));
jest.mock('../src/services/PocketProvider', () => ({
  usePocket: () => ({ reauthenticate: mockReauthenticate }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: jest.fn() }) }));
jest.mock('../src/features/sessions/DrawerScene', () => ({
  DrawerScene: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../src/features/sessions/SessionDrawer', () => ({
  SessionDrawer: () => null,
}));
const empty: Snapshot = {
  session: {
    id: 'a',
    title: 'Test',
    adapterId: 'mock',
    workspaceId: WORKSPACE_ID,
    revision: 1,
    createdAt: '2026-11-06T00:00:00Z',
    updatedAt: '2026-11-06T00:00:00Z',
  },
  streamId: 'session:a',
  through: 1,
  messages: [],
  runs: [],
  tools: [],
  historyBefore: null,
};
beforeEach(() => {
  jest.useFakeTimers();
  mockChat = {
    nextAppHistory: jest.fn(),
    historyLoading: false,
    appCommand: null,
    appPending: null,
    appResolving: false,
    refreshApp: jest.fn(),
    resolveApp: jest.fn(),
    state: 'offline',
    snapshot: null,
    draft: 'Saved draft',
    setDraft: jest.fn(),
    loaded: true,
    sending: false,
    stopping: false,
    error: '',
    run: undefined,
    terminal: undefined,
    send: jest.fn(),
    stop: jest.fn(),
    loadOlder: jest.fn(),
    messages: [],
    hasOlder: false,
    retry: jest.fn(),
  };
  mockReauthenticate.mockClear();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});
const advance = (ms: number) => act(() => jest.advanceTimersByTime(ms));
it('labels external history and refuses Send/Stop even with a populated draft and live transport', async () => {
  mockChat.state = 'live';
  mockChat.snapshot = {
    ...empty,
    session: {
      ...empty.session,
      adapterId: 'antigravity-experimental',
      external: {
        conversationId: 'fixture',
        trajectoryId: 'trajectory',
        stepCount: 2,
        observation: 'fresh',
        observedAt: '2026-11-07T00:00:00Z',
        historyComplete: false,
        turnState: 'unknown',
        readOnly: true,
      },
    },
  };
  await render(<ChatScreen id="a" />);
  expect(screen.getByText(/Antigravity/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
  expect(mockChat.send).not.toHaveBeenCalled();
  expect(screen.getByText(/Read-only · Recent history only/)).toBeTruthy();
});
it('enables the independent App send capability while Stop stays absent, and makes uncertainty resolution explicit', async () => {
  mockChat.state = 'live';
  mockChat.snapshot = {
    ...empty,
    session: {
      ...empty.session,
      adapterId: 'antigravity-experimental',
      external: {
        conversationId: 'fixture',
        trajectoryId: 'trajectory',
        stepCount: 2,
        observation: 'fresh',
        observedAt: '2026-11-07T00:00:00Z',
        historyComplete: false,
        turnState: 'unknown',
        readOnly: false,
        send: 'fixture-text',
      },
    },
  };
  const view = await render(<ChatScreen id="a" />);
  expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  mockChat.appPending = { text: 'pending', key: 'command' };
  await view.rerender(<ChatScreen id="a" />);
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(screen.getByText('Delivery uncertain')).toBeTruthy();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Resolve without resending' }),
  );
  expect(mockChat.resolveApp).not.toHaveBeenCalled();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Keep uncertain; do not resend' }),
  );
  expect(mockChat.resolveApp).toHaveBeenCalledTimes(1);
  expect(mockChat.send).not.toHaveBeenCalled();
});
it.each(['gap', 'unavailable'] as const)(
  'blocks sends and gives owner recovery guidance for App %s',
  async (observation) => {
    mockChat.state = 'live';
    mockChat.snapshot = {
      ...empty,
      session: {
        ...empty.session,
        adapterId: 'antigravity-experimental',
        external: {
          conversationId: 'fixture',
          trajectoryId: 'trajectory',
          stepCount: 2,
          observation,
          observedAt: '2026-11-07T00:00:00Z',
          historyComplete: false,
          turnState: 'unknown',
          readOnly: false,
          send: 'ordinary-text',
        },
      },
    };
    await render(<ChatScreen id="a" />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(
      screen.getByText(
        observation === 'gap' ? /check owner status/ : /check owner setup/,
      ),
    ).toBeTruthy();
  },
);
it('opens quietly, never flashes recovery or false empty history, and keeps sending gated until live', async () => {
  const view = await render(<ChatScreen id="a" />);
  expect(screen.queryByText('Recovering your conversation')).toBeNull();
  expect(screen.queryByText('Your conversation starts here.')).toBeNull();
  expect(screen.getByText('Loading…')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  mockChat.state = 'connecting';
  await view.rerender(<ChatScreen id="a" />);
  await advance(500);
  mockChat.state = 'live';
  mockChat.snapshot = empty;
  await view.rerender(<ChatScreen id="a" />);
  expect(screen.getByText('Your conversation starts here.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();
  await advance(3000);
  expect(screen.queryByText('Recovering your conversation')).toBeNull();
});
it('keeps slow initial connecting quiet, but exposes a sustained actual connection failure', async () => {
  mockChat.state = 'connecting';
  const view = await render(<ChatScreen id="a" />);
  await advance(3000);
  expect(screen.queryByText('Recovering your conversation')).toBeNull();
  mockChat.state = 'reconnecting';
  await view.rerender(<ChatScreen id="a" />);
  expect(screen.getByText('Recovering your conversation')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
  expect(mockChat.retry).toHaveBeenCalledTimes(1);
});
it('delays an outage banner across retry states, resets on live, and does not carry it to another chat', async () => {
  mockChat.state = 'live';
  mockChat.snapshot = empty;
  const view = await render(<ChatScreen id="a" />);
  mockChat.state = 'offline';
  await view.rerender(<ChatScreen id="a" />);
  await advance(1000);
  mockChat.state = 'reconnecting';
  await view.rerender(<ChatScreen id="a" />);
  await advance(999);
  expect(screen.queryByText('Recovering your conversation')).toBeNull();
  await advance(1);
  expect(screen.getByText('Recovering your conversation')).toBeTruthy();
  mockChat.snapshot = null;
  await view.rerender(<ChatScreen id="b" />);
  expect(screen.queryByText('Recovering your conversation')).toBeNull();
  mockChat.state = 'live';
  mockChat.snapshot = { ...empty, session: { ...empty.session, id: 'b' } };
  await view.rerender(<ChatScreen id="b" />);
  mockChat.state = 'reconnecting';
  await view.rerender(<ChatScreen id="b" />);
  await advance(500);
  expect(screen.queryByText('Recovering your conversation')).toBeNull();
  mockChat.state = 'live';
  await view.rerender(<ChatScreen id="b" />);
  await advance(3000);
  expect(screen.queryByText('Recovering your conversation')).toBeNull();
});
it('shows credential and protocol errors immediately instead of hiding them behind loading', async () => {
  mockChat.state = 'auth-required';
  const view = await render(<ChatScreen id="a" />);
  expect(
    screen.getByText('Reconnect with the current credential'),
  ).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
  expect(mockReauthenticate).toHaveBeenCalledTimes(1);
  mockChat.state = 'incompatible';
  await view.rerender(<ChatScreen id="a" />);
  expect(screen.getByText('Gateway update required')).toBeTruthy();
  expect(screen.queryByText('Loading…')).toBeNull();
});

it('presents coding activity and bounded history without enabling send or tool controls', async () => {
  mockChat.state = 'live';
  mockChat.snapshot = {
    ...empty,
    session: {
      ...empty.session,
      adapterId: 'antigravity-experimental',
      external: {
        conversationId: 'fixture',
        trajectoryId: 'trajectory',
        stepCount: 20,
        windowStart: 0,
        windowEnd: 20,
        observation: 'fresh',
        observedAt: '2026-11-07T00:00:00Z',
        historyComplete: false,
        turnState: 'unknown',
        readOnly: true,
        view: 'coding',
        laterHistory: 'unobserved',
      },
    },
  };
  mockChat.messages = [
    {
      id: 'activity',
      sessionId: 'a',
      runId: 'run',
      ordinal: 1,
      revision: 1,
      status: 'completed',
      role: 'activity',
      text: '',
      appStepType: 21,
      activity: {
        schemaVersion: 'app-2.29.0',
        kind: 'tool',
        label: 'Run command',
        upstreamType: 21,
        state: 'done',
        detailsOmitted: true,
      },
    },
  ];
  const view = await render(<ChatScreen id="a" />);
  expect(screen.getByText('Run command')).toBeTruthy();
  expect(screen.getByText(/does not establish execution success/)).toBeTruthy();
  expect(screen.getByText(/not a latest-activity view/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Next history window' }),
  );
  expect(mockChat.nextAppHistory).toHaveBeenCalledTimes(1);
  mockChat.state = 'offline';
  await view.rerender(<ChatScreen id="a" />);
  expect(
    screen.getByRole('button', { name: 'Next history window' }),
  ).toBeDisabled();
  expect(screen.getByText('Run command')).toBeTruthy();
});
