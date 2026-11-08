import React, { useRef, useState } from 'react';
import { TextInput, View, StyleSheet, type TextInputProps } from 'react-native';
import { X } from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { Text } from './Text';
import { IconButton } from './IconButton';
import { easeOut, Reveal, useErrorShake } from './Motion';
import { useTheme } from '../../theme/Theme';
export function Input({
  label,
  hint,
  error,
  clearable,
  hideLabel = false,
  ...props
}: TextInputProps & {
  label: string;
  hint?: string;
  error?: string;
  clearable?: boolean;
  hideLabel?: boolean;
}) {
  const { colors, reduced } = useTheme();
  const ref = useRef<React.ComponentRef<typeof TextInput>>(null);
  const [focused, setFocused] = useState(false);
  const showClear =
    !!clearable && (props.value?.length ?? 0) > 0 && props.editable !== false;
  const shake = useErrorShake(error ?? '');
  const border = error ? colors.error : focused ? colors.focus : colors.border;
  const surface = useAnimatedStyle(() => ({
    borderColor: withTiming(border, {
      duration: reduced ? 0 : 200,
      easing: easeOut,
    }),
  }));
  const clear = useAnimatedStyle(() => ({
    width: withTiming(showClear ? 48 : 0, {
      duration: reduced ? 0 : 320,
      easing: easeOut,
    }),
    opacity: withTiming(showClear ? 1 : 0, {
      duration: reduced ? 0 : 220,
      easing: easeOut,
    }),
  }));
  return (
    <View style={s.field}>
      {!hideLabel && <Text style={s.label}>{label}</Text>}
      <Animated.View
        style={[s.row, { backgroundColor: colors.surface }, surface, shake]}
      >
        <TextInput
          ref={ref}
          {...props}
          accessibilityLabel={label}
          accessibilityHint={error ?? hint}
          placeholderTextColor={colors.secondary}
          onFocus={(event) => {
            setFocused(true);
            props.onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            props.onBlur?.(event);
          }}
          style={[s.input, { color: colors.text }, props.style]}
        />
        {clearable && (
          <Animated.View
            pointerEvents={showClear ? 'auto' : 'none'}
            accessibilityElementsHidden={!showClear}
            importantForAccessibility={
              showClear ? 'auto' : 'no-hide-descendants'
            }
            style={[{ overflow: 'hidden' }, clear]}
          >
            <IconButton
              icon={X}
              size={16}
              label={`Clear ${label}`}
              disabled={!showClear}
              onPress={() => {
                props.onChangeText?.('');
                ref.current?.focus();
              }}
            />
          </Animated.View>
        )}
      </Animated.View>
      <Reveal open={!!(error || hint)}>
        <Text
          accessibilityRole={error ? 'alert' : undefined}
          muted={!error}
          style={error ? { color: colors.error } : undefined}
        >
          {error ?? hint}
        </Text>
      </Reveal>
    </View>
  );
}
const s = StyleSheet.create({
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: 16,
    alignItems: 'center',
  },
  input: { flex: 1, minHeight: 48, padding: 12, fontSize: 16 },
});
