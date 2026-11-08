import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { thinBorderWidth, useTheme } from '../../theme/Theme';
import { Text } from './Text';
import { easeOut, easeThrow } from './Motion';
export function Tabs({
  items,
  value,
  onValueChange,
  label,
}: {
  items: { value: string; label: string }[];
  value: string;
  onValueChange: (value: string) => void;
  label: string;
}) {
  const { colors, reduced } = useTheme();
  const [bounds, setBounds] = useState<
    Record<string, { x: number; width: number }>
  >({});
  const ready = useRef(false);
  const x = useSharedValue(0);
  const width = useSharedValue(0);
  useEffect(() => {
    const target = bounds[value];
    if (!target) return;
    const immediate = reduced || !ready.current;
    ready.current = true;
    x.value = withTiming(target.x, {
      duration: immediate ? 0 : 440,
      easing: easeThrow,
    });
    width.value = withTiming(target.width, {
      duration: immediate ? 0 : 400,
      easing: easeOut,
    });
  }, [bounds, value, reduced, x, width]);
  const indicator = useAnimatedStyle(() => ({
    width: width.value,
    transform: [{ translateX: x.value }],
  }));
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      style={[
        s.tabs,
        { borderColor: colors.border, backgroundColor: colors.surface },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[s.indicator, { backgroundColor: colors.text }, indicator]}
      />
      {items.map((item) => (
        <Pressable
          key={item.value}
          accessibilityRole="tab"
          accessibilityState={{ selected: item.value === value }}
          accessibilityLabel={item.label}
          onLayout={({ nativeEvent: { layout } }) =>
            setBounds((old) =>
              old[item.value]?.x === layout.x &&
              old[item.value]?.width === layout.width
                ? old
                : {
                    ...old,
                    [item.value]: { x: layout.x, width: layout.width },
                  },
            )
          }
          onPress={() => onValueChange(item.value)}
          style={s.tab}
        >
          <Text style={{ fontWeight: item.value === value ? '700' : '400' }}>
            {item.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
const s = StyleSheet.create({
  tabs: { flexDirection: 'row', borderTopWidth: thinBorderWidth },
  tab: {
    flex: 1,
    minHeight: 52,
    padding: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  indicator: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    height: 2,
    borderRadius: 1,
  },
});
