import mockSafeArea from 'react-native-safe-area-context/jest/mock';
jest.mock('react-native-safe-area-context', () => mockSafeArea);

// Native worklets/layout run on the emulator; Jest uses the upstream JS mock.
jest.mock('react-native-reanimated', () =>
  jest.requireActual('react-native-reanimated/mock'),
);
