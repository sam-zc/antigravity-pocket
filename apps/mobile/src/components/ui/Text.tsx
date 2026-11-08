import React from 'react';
import { Text as NativeText, type TextProps, StyleSheet } from 'react-native';
import { useTheme } from '../../theme/Theme';
export function Text({
  style,
  muted,
  heading,
  ...props
}: TextProps & { muted?: boolean; heading?: boolean }) {
  const { colors } = useTheme();
  return (
    <NativeText
      {...props}
      style={[
        styles.text,
        { color: muted ? colors.secondary : colors.text },
        heading && styles.heading,
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  text: { fontSize: 16, lineHeight: 24 },
  heading: {
    fontSize: 26,
    lineHeight: 34,
    fontWeight: '600',
    letterSpacing: -0.5,
  },
});
