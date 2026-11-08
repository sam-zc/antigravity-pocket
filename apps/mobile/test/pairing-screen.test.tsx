import React from 'react';
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react-native';
import { PairingScreen } from '../src/features/connections/PairingScreen';
const mockPaired = jest.fn(async () => {}),
  mockExchange = jest.fn(async () => ({}));
let mockState = 'claimed';
jest.mock('../src/services/native-security', () => ({
  secureNativeAvailable: () => true,
}));
jest.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [
    { granted: false },
    async () => ({ granted: false }),
  ],
}));
jest.mock('../src/services/PocketProvider', () => ({
  usePocket: () => ({ paired: mockPaired }),
}));
jest.mock('../src/services/pairing', () => ({
  Pairing: class {
    invitation = { origin: 'https://desktop.example', gatewayId: 'gateway' };
    async start() {
      return { code: '123456', claimId: 'claim' };
    }
    async status() {
      return {
        state: mockState,
        grants: [{ workspaceId: 'workspace', scopes: ['session:read'] }],
      };
    }
    exchange = mockExchange;
  },
}));
beforeEach(() => {
  mockState = 'claimed';
  jest.clearAllMocks();
});
it('shows hostname and exact comparison, waits for owner, and displays grants before exchange', async () => {
  await render(<PairingScreen />);
  await fireEvent.changeText(
    screen.getByLabelText('Private invitation fallback'),
    'fixture',
  );
  await fireEvent.press(
    screen.getByRole('button', { name: 'Review invitation' }),
  );
  expect(screen.getByText('https://desktop.example')).toBeTruthy();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Trust this hostname and claim' }),
  );
  await waitFor(() =>
    expect(screen.getByText('Compare code: 123456')).toBeTruthy(),
  );
  await fireEvent.press(
    screen.getByRole('button', { name: 'Check desktop confirmation' }),
  );
  await waitFor(() =>
    expect(screen.getByText(/Waiting for the desktop owner/)).toBeTruthy(),
  );
  expect(mockExchange).not.toHaveBeenCalled();
  mockState = 'approved';
  await fireEvent.press(
    screen.getByRole('button', { name: 'Check desktop confirmation' }),
  );
  await waitFor(() =>
    expect(screen.getByText('workspace: session:read')).toBeTruthy(),
  );
  expect(mockExchange).not.toHaveBeenCalled();
  await fireEvent.press(
    screen.getByRole('button', { name: 'Complete pairing' }),
  );
  await waitFor(() => expect(mockPaired).toHaveBeenCalledTimes(1));
});
it('explains denied camera permission without starting a claim', async () => {
  await render(<PairingScreen />);
  await fireEvent.press(
    screen.getByRole('button', { name: 'Scan invitation QR' }),
  );
  await waitFor(() =>
    expect(screen.getByText(/Camera permission denied/)).toBeTruthy(),
  );
  expect(mockExchange).not.toHaveBeenCalled();
});
