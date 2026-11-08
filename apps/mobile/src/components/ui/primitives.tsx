import React from 'react';
import { ScrollView, StyleSheet, View, type ViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { thinBorderWidth, useTheme } from '../../theme/Theme';
import { Overlay } from './Overlay';
import { Text } from './Text';
import { Button } from './Button';
export { Text } from './Text';
export { Button } from './Button';
export { Input } from './Input';
export { Tabs } from './Tabs';

export function Card({ style, ...props }: ViewProps) {
  const { colors } = useTheme();
  return (
    <View
      {...props}
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: colors.border },
        style,
      ]}
    />
  );
}
export function Badge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'success' | 'warning' | 'error';
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.badge, { backgroundColor: colors.elevated }]}>
      <Text
        style={{
          fontSize: 13,
          color: tone === 'neutral' ? colors.secondary : colors[tone],
        }}
      >
        {label}
      </Text>
    </View>
  );
}
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Overlay open={open} onClose={onClose} label={title}>
      <Text heading accessibilityRole="header">
        {title}
      </Text>
      <ScrollView keyboardShouldPersistTaps="handled">{children}</ScrollView>
      <Button variant="outline" label="Close" onPress={onClose} />
    </Overlay>
  );
}
export function Screen({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.screen, { backgroundColor: colors.background }]}
    >
      {children}
    </SafeAreaView>
  );
}
export const styles = StyleSheet.create({
  text: { fontSize: 16, lineHeight: 24 },
  heading: {
    fontSize: 26,
    lineHeight: 34,
    fontWeight: '600',
    letterSpacing: -0.5,
  },
  label: { fontSize: 13, fontWeight: '600' },
  card: {
    padding: 16,
    borderWidth: thinBorderWidth,
    borderRadius: 16,
    gap: 12,
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  scrim: { flex: 1, justifyContent: 'center', padding: 20 },
  dialog: {
    maxHeight: '85%',
    borderRadius: 22,
    padding: 20,
    gap: 16,
    borderWidth: 1,
  },
  screen: { flex: 1, paddingHorizontal: 16, gap: 16 },
  stack: { gap: 16, paddingBottom: 24 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
});
