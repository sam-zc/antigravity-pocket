// No provider activity or reasoning is inferred.
import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  cancelAnimation,
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../../theme/Theme';

export function GenerationBackdrop({ active }: { active: boolean }) {
  const { colors, reduced } = useTheme();
  const cycle = useSharedValue(0);
  const opacity = useSharedValue(0);
  useEffect(() => {
    opacity.value = withTiming(active && !reduced ? 1 : 0, {
      duration: reduced ? 0 : 500,
    });
    if (active && !reduced) {
      cycle.value = 0;
      cycle.value = withRepeat(
        withTiming(5, { duration: 10000, easing: Easing.linear }),
        -1,
      );
    }
    return () => cancelAnimation(cycle);
  }, [active, reduced, cycle, opacity]);
  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    backgroundColor: interpolateColor(
      cycle.value,
      [0, 1, 2, 3, 4, 5],
      [
        colors.ambientBlue,
        colors.ambientMint,
        colors.ambientYellow,
        colors.ambientPeach,
        colors.ambientLilac,
        colors.ambientBlue,
      ],
    ),
  }));
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[s.wash, style]}
    >
      <LinearGradient
        colors={[`${colors.background}00`, colors.background]}
        locations={[0, 1]}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}
const s = StyleSheet.create({
  wash: { position: 'absolute', top: 0, left: 0, right: 0, height: 340 },
});
