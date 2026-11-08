// Observable run feedback using the shared label fade.
import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Text } from '../../components/ui/primitives';
import { LabelChange } from '../../components/ui/Motion';
import { useTheme } from '../../theme/Theme';

function Dot({ index }: { index: number }) {
  const { colors, reduced } = useTheme();
  const phase = useSharedValue(0);
  useEffect(() => {
    if (!reduced)
      phase.value = withRepeat(
        withTiming(Math.PI * 2, { duration: 1200, easing: Easing.linear }),
        -1,
      );
    else phase.value = 0;
    return () => cancelAnimation(phase);
  }, [phase, reduced]);
  const style = useAnimatedStyle(() => ({
    opacity: reduced
      ? 0.7
      : 0.55 + (0.45 * (Math.sin(phase.value - index * 1.1) + 1)) / 2,
    transform: [
      { translateY: reduced ? 0 : Math.sin(phase.value - index * 1.1) * 2.5 },
    ],
  }));
  return (
    <Animated.View style={[s.dot, { backgroundColor: colors.text }, style]} />
  );
}
export function GenerationActivity({ receiving }: { receiving: boolean }) {
  const label = receiving ? 'Writing response' : 'Preparing response';
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={s.row}
    >
      <View
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={s.dots}
      >
        <Dot index={0} />
        <Dot index={1} />
        <Dot index={2} />
      </View>
      <LabelChange value={label}>
        <Text style={s.label}>{label}</Text>
      </LabelChange>
    </View>
  );
}
const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 32 },
  dots: { flexDirection: 'row', gap: 3, alignItems: 'center', height: 20 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  label: { fontSize: 14, lineHeight: 22 },
});
