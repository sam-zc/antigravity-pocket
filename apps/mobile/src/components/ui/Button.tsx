import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { CircleAlert, type LucideIcon } from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { thinBorderWidth, useTheme } from '../../theme/Theme';
import { Text } from './Text';
import { DrawnCheck } from './DrawnCheck';
import {
  easeOut,
  IconLayer,
  LabelChange,
  Spinner,
  useErrorShake,
  usePressMotion,
} from './Motion';
type ActionStatus = 'idle' | 'pending' | 'success' | 'error';
export function Button({
  label,
  accessibilityLabel,
  onPress,
  disabled = false,
  status = 'idle',
  pendingLabel = 'Working…',
  variant = 'primary',
  selected,
  expanded,
  align = 'center',
  size = 'regular',
  icon: Icon,
}: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  status?: ActionStatus;
  pendingLabel?: string;
  variant?:
    'primary' | 'outline' | 'ghost' | 'destructive' | 'danger' | 'navigation';
  selected?: boolean;
  expanded?: boolean;
  align?: 'left' | 'center';
  size?: 'regular' | 'compact';
  icon?: LucideIcon;
}) {
  const { colors, reduced } = useTheme();
  const [focused, setFocused] = useState(false);
  const [pressed, setPressed] = useState(false);
  const press = usePressMotion();
  const shake = useErrorShake(status === 'error');
  const compact = size === 'compact';
  const busy = status === 'pending';
  const inert = disabled || busy;
  const activeLabel = busy ? pendingLabel : label;
  const foreground =
    variant === 'primary'
      ? compact
        ? colors.onSolid
        : colors.onAccent
      : variant === 'danger'
        ? colors.onDestructive
        : variant === 'destructive'
          ? colors.error
          : compact && variant === 'ghost'
            ? colors.secondary
            : colors.text;
  const background =
    variant === 'primary'
      ? compact
        ? colors.solid
        : colors.accent
      : variant === 'danger'
        ? colors.destructive
        : pressed || selected || (variant === 'navigation' && focused)
          ? colors.elevated
          : variant === 'navigation' || (compact && variant === 'ghost')
            ? 'transparent'
            : colors.surface;
  const border = focused
    ? colors.focus
    : variant === 'navigation' || variant === 'danger'
      ? 'transparent'
      : variant === 'ghost'
        ? compact
          ? 'transparent'
          : colors.surface
        : colors.border;
  const surface = useAnimatedStyle(() => ({
    backgroundColor: withTiming(background, {
      duration: reduced ? 0 : 200,
      easing: easeOut,
    }),
    borderColor: withTiming(border, {
      duration: reduced ? 0 : 200,
      easing: easeOut,
    }),
    opacity: withTiming(inert ? (compact ? 0.35 : 0.55) : 1, {
      duration: reduced ? 0 : 200,
    }),
  }));
  const slot = useAnimatedStyle(() => ({
    width: withTiming(status === 'idle' ? 0 : 24, {
      duration: reduced ? 0 : 360,
      easing: easeOut,
    }),
  }));
  return (
    <Animated.View style={shake}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          busy ? activeLabel : (accessibilityLabel ?? activeLabel)
        }
        accessibilityState={{ disabled: inert, busy, selected, expanded }}
        disabled={inert}
        hitSlop={compact ? { top: 8, bottom: 8 } : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onPressIn={() => {
          setPressed(true);
          press.onPressIn();
        }}
        onPressOut={() => {
          setPressed(false);
          press.onPressOut();
        }}
        onPress={() => {
          if (!inert) onPress();
        }}
      >
        <Animated.View
          style={[
            compact ? s.compact : s.button,
            variant === 'navigation' && s.navigation,
            { alignItems: align === 'left' ? 'flex-start' : 'center' },
            surface,
            press.style,
          ]}
        >
          <View style={s.row}>
            {Icon && (
              <View style={{ marginRight: 14 }}>
                <Icon size={22} strokeWidth={1.65} color={foreground} />
              </View>
            )}
            <Animated.View
              accessible={false}
              style={[{ height: 18, overflow: 'hidden' }, slot]}
            >
              <View style={{ width: 16, height: 18 }}>
                <IconLayer active={busy}>
                  <Spinner active={busy} color={foreground} />
                </IconLayer>
                <IconLayer active={status === 'success'}>
                  <DrawnCheck
                    active={status === 'success'}
                    color={foreground}
                  />
                </IconLayer>
                <IconLayer active={status === 'error'}>
                  <CircleAlert size={16} color={foreground} />
                </IconLayer>
              </View>
            </Animated.View>
            <View style={{ flexShrink: 1 }}>
              <LabelChange value={activeLabel}>
                <Text
                  numberOfLines={variant === 'navigation' ? 1 : undefined}
                  style={{
                    color: foreground,
                    fontWeight:
                      variant === 'navigation'
                        ? '400'
                        : compact
                          ? '500'
                          : '600',
                    ...(compact ? { fontSize: 12.5, lineHeight: 18 } : {}),
                  }}
                >
                  {activeLabel}
                </Text>
              </LabelChange>
            </View>
          </View>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}
const s = StyleSheet.create({
  navigation: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 0,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  button: {
    minHeight: 48,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
  },
  compact: {
    minHeight: 32,
    minWidth: 48,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: thinBorderWidth,
    justifyContent: 'center',
  },
});
