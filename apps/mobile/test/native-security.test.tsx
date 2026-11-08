import {
  secureNativeAvailable,
  requireSecureNative,
} from '../src/services/native-security';
const mockConstants = { executionEnvironment: 'bare' };
const mockApplication = { nativeBuildVersion: '2' };
jest.mock('expo-application', () => ({
  get nativeBuildVersion() {
    return mockApplication.nativeBuildVersion;
  },
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  get default() {
    return mockConstants;
  },
  ExecutionEnvironment: { StoreClient: 'storeClient' },
}));
it('requires the installed native security policy and blocks Expo Go and stale APKs', () => {
  mockConstants.executionEnvironment = 'storeClient';
  expect(secureNativeAvailable()).toBe(false);
  expect(requireSecureNative).toThrow('native build');
  mockConstants.executionEnvironment = 'bare';
  mockApplication.nativeBuildVersion = '1';
  expect(secureNativeAvailable()).toBe(false);
  mockApplication.nativeBuildVersion = '2';
  expect(secureNativeAvailable()).toBe(true);
});
