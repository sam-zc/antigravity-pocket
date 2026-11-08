import React from 'react';
import {
  render,
  act,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react-native';
import { Button, Text } from '../src/components/ui/primitives';
import {
  PocketProvider,
  usePocket,
  useConnection,
} from '../src/services/PocketProvider';
let mockBootstrap = async () => ({ gatewayId: 'gateway' });
let mockPocket: ReturnType<typeof usePocket>;
const mockPurge = jest.fn(async () => {});
jest.mock('../src/services/api', () => ({
  Api: class {
    async bootstrap() {
      return mockBootstrap();
    }
  },
}));
jest.mock('../src/services/cache', () => ({
  Cache: { open: async () => ({ purge: mockPurge, retire: jest.fn() }) },
}));
function Controls() {
  const pocket = usePocket();
  mockPocket = pocket;
  return (
    <>
      <Text>{pocket.runtime ? 'Connected' : 'Credential entry'}</Text>
      <Button
        label="Connect"
        onPress={() => {
          void pocket.connect('http://127.0.0.1:4317', 'test-token');
        }}
      />
      <Button label="Update credential" onPress={pocket.reauthenticate} />
      <Button
        label="Clear connection"
        onPress={() => {
          void pocket.disconnect();
        }}
      />
    </>
  );
}
it('retains cache/drafts when rotating development credentials and purges only on explicit disconnect', async () => {
  await render(
    <PocketProvider>
      <Controls />
    </PocketProvider>,
  );
  await fireEvent.press(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
  await fireEvent.press(
    screen.getByRole('button', { name: 'Update credential' }),
  );
  expect(screen.getByText('Credential entry')).toBeTruthy();
  expect(mockPurge).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy());
  await fireEvent.press(
    screen.getByRole('button', { name: 'Clear connection' }),
  );
  await waitFor(() => expect(mockPurge).toHaveBeenCalledTimes(1));
});

it('clears the visible projection immediately on lost authority while retaining it during ordinary reconnect', () => {
  const sentinel = {
    session: { id: 'selected' },
  } as import('@pocket/protocol').Snapshot;
  useConnection.getState().setSnapshot(sentinel);
  useConnection.getState().setState('reconnecting');
  expect(useConnection.getState().snapshot).toBe(sentinel);
  useConnection.getState().setState('auth-required');
  expect(useConnection.getState().snapshot).toBeNull();
});

it('does not install a delayed development bootstrap after logout or a newer gateway connection', async () => {
  await render(
    <PocketProvider>
      <Controls />
    </PocketProvider>,
  );
  let release!: (value: { gatewayId: string }) => void;
  mockBootstrap = () =>
    new Promise((r) => {
      release = r;
    });
  let old!: Promise<void>;
  await act(async () => {
    old = mockPocket.connect('http://127.0.0.1:4317', 'old');
  });
  mockBootstrap = async () => ({ gatewayId: 'new-gateway' });
  await act(async () => {
    await mockPocket.connect('http://127.0.0.1:4318', 'new');
  });
  expect(mockPocket.runtime?.gatewayId).toBe('new-gateway');
  await act(async () => {
    release({ gatewayId: 'old-gateway' });
    await old;
  });
  expect(mockPocket.runtime?.gatewayId).toBe('new-gateway');
  mockBootstrap = () =>
    new Promise((r) => {
      release = r;
    });
  await act(async () => {
    old = mockPocket.connect('http://127.0.0.1:4317', 'late');
  });
  await act(async () => {
    await mockPocket.disconnect();
    release({ gatewayId: 'old-gateway' });
    await old;
  });
  expect(mockPocket.runtime).toBeNull();
  mockBootstrap = async () => ({ gatewayId: 'gateway' });
});
