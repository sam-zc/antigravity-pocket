import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from '../src/theme/Theme';
import { PocketProvider, usePocket } from '../src/services/PocketProvider';
import { ConnectScreen } from '../src/features/connections/ConnectScreen';
function Routes() {
  const { runtime } = usePocket();
  const { dark, colors, reduced } = useTheme();
  return (
    <>
      <StatusBar style={dark ? 'light' : 'dark'} />
      {runtime ? (
        <Stack
          key={`${runtime.gatewayId}:${runtime.epoch ?? 0}`}
          screenOptions={{
            headerShown: false,
            animation: reduced ? 'none' : 'fade',
            contentStyle: { backgroundColor: colors.background },
          }}
        />
      ) : (
        <ConnectScreen />
      )}
    </>
  );
}
export default function Layout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <PocketProvider>
          <Routes />
        </PocketProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
