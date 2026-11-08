import Constants, { ExecutionEnvironment } from 'expo-constants';
import { nativeBuildVersion } from 'expo-application';
import { Platform } from 'react-native';
export function secureNativeAvailable() {
  return (
    Platform.OS !== 'web' &&
    Constants.executionEnvironment !== ExecutionEnvironment.StoreClient &&
    nativeBuildVersion === '2'
  );
}
export function requireSecureNative() {
  if (!secureNativeAvailable())
    throw new Error(
      'Secure pairing requires the Phase 2 native build. Expo Go and older builds support UI preview only.',
    );
}
