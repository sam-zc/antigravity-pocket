import React from 'react';
import { Stack } from 'expo-router';
import { useTheme } from '../../src/theme/Theme';
export default function Layout() {
  const { reduced } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: reduced ? 'none' : 'fade',
      }}
    />
  );
}
