import React, { useState } from 'react';
import { Pressable, StyleSheet, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { usePressMotion, easeOut } from './Motion';
import type { LucideIcon } from 'lucide-react-native';
import { useTheme } from '../../theme/Theme';

export function IconButton({
  label,
  children,
  icon: Icon,
  onPress,
  disabled,
  busy,
  selected,
  expanded,
  filled,
  muted,
  neutral,
  size = 20,
  style,
}: {
  children?: React.ReactNode;
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  selected?: boolean;
  expanded?: boolean;
  filled?: boolean;
  muted?: boolean;
  neutral?: boolean;
  size?: number;
  style?: ViewStyle;
}) {
  const { colors, reduced } = useTheme();
  const press = usePressMotion();
  const [pressed, setPressed] = useState(false);
  const background = neutral
    ? colors.elevated
    : filled
      ? colors.accent
      : pressed || selected
        ? colors.elevated
        : 'transparent';
  const surface = useAnimatedStyle(() => ({
    backgroundColor: withTiming(background, {
      duration: reduced ? 0 : 200,
      easing: easeOut,
    }),
    opacity: withTiming(disabled ? 0.4 : 1, { duration: reduced ? 0 : 200 }),
  }));
  return (
    <Animated.View style={press.style}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: !!disabled, selected, expanded, busy }}
        disabled={disabled}
        onPress={onPress}
        onPressIn={() => {
          setPressed(true);
          press.onPressIn();
        }}
        onPressOut={() => {
          setPressed(false);
          press.onPressOut();
        }}
      >
        <Animated.View style={[s.button, surface, style]}>
          {children ?? (
            <Icon
              size={size}
              strokeWidth={1.65}
              color={
                filled
                  ? colors.onAccent
                  : muted
                    ? colors.secondary
                    : colors.text
              }
            />
          )}
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}
const s = StyleSheet.create({
  button: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
