import React, { useEffect, useState } from 'react';
import { Button, TextInput } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { WORKSPACE_ID as mockWorkspaceId } from '@pocket/protocol';
import { SessionDrawer } from '../src/features/sessions/SessionDrawer';
import { DrawerScene } from '../src/features/sessions/DrawerScene';

// Native recognition/frames are checked on Android, not simulated by Jest.
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: jest.requireActual('react-native').View,
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  usePanGesture: () => ({}),
}));

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockRefetch = jest.fn();
const mockCreate = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}));
jest.mock('../src/features/sessions/useSessions', () => ({
  useSessions: () => ({
    sessions: [
      {
        id: 'session-a',
        title: 'Transport checks',
        workspaceId: mockWorkspaceId,
        adapterId: 'mock',
        revision: 1,
        createdAt: '2026-11-06T00:00:00Z',
        updatedAt: '2026-11-06T00:00:00Z',
      },
    ],
    refetch: mockRefetch,
    create: mockCreate,
    creating: false,
    hasNextPage: false,
  }),
}));
beforeEach(() => jest.clearAllMocks());

it('hides covered controls and preserves the mounted conversation draft across navigation', async () => {
  const mounted = jest.fn();
  function Chat() {
    const [text, setText] = useState('Retained draft');
    useEffect(() => {
      mounted();
    }, []);
    return (
      <TextInput
        accessibilityLabel="Draft"
        value={text}
        onChangeText={setText}
      />
    );
  }
  function Scene() {
    const [open, setOpen] = useState(false);
    return (
      <DrawerScene
        open={open}
        onOpenChange={setOpen}
        drawer={<Button title="Close history" onPress={() => setOpen(false)} />}
      >
        <Chat />
        <Button title="Open history" onPress={() => setOpen(true)} />
      </DrawerScene>
    );
  }
  await render(<Scene />);
  expect(screen.queryByRole('button', { name: 'Close history' })).toBeNull();
  await fireEvent.changeText(screen.getByLabelText('Draft'), 'Still writing');
  await fireEvent.press(screen.getByRole('button', { name: 'Open history' }));
  expect(screen.queryByLabelText('Draft')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Close history' }));
  expect(screen.getByDisplayValue('Still writing')).toBeTruthy();
  expect(mounted).toHaveBeenCalledTimes(1);
});

it('opens search explicitly and clears its filter when it closes', async () => {
  await render(
    <SessionDrawer open onClose={jest.fn()} currentId="session-a" />,
  );
  expect(screen.queryByLabelText('Search sessions')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Transport checks' }),
  ).toBeSelected();
  await fireEvent.press(screen.getByRole('button', { name: 'Search history' }));
  await fireEvent.changeText(
    screen.getByLabelText('Search sessions'),
    'absent',
  );
  expect(screen.getByText('No loaded sessions match “absent”')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Close search' }));
  expect(screen.queryByLabelText('Search sessions')).toBeNull();
  expect(screen.getByRole('button', { name: 'Transport checks' })).toBeTruthy();
});
it('closes history and reopens an actual session without creating another', async () => {
  const close = jest.fn();
  await render(<SessionDrawer open onClose={close} />);
  await fireEvent.press(
    screen.getByRole('button', { name: 'Transport checks' }),
  );
  expect(close).toHaveBeenCalledTimes(1);
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: '/chat/[id]',
    params: { id: 'session-a' },
  });
  expect(mockCreate).not.toHaveBeenCalled();
});
it('keeps named creation explicit and settings reachable', async () => {
  const close = jest.fn();
  await render(<SessionDrawer open onClose={close} />);
  await fireEvent.press(screen.getByRole('button', { name: 'New session' }));
  expect(screen.getByText('Create a Mock session')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Create session' })).toBeDisabled();
  await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Settings' }));
  expect(close).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith('/settings');
  expect(mockCreate).not.toHaveBeenCalled();
});
