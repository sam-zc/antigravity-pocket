import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Copy } from 'lucide-react-native';
import Svg, { Path } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../../theme/Theme';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const ease = Easing.bezier(0.16, 1, 0.3, 1);
export function CopyGlyph({ copied, size }: { copied: boolean; size: number }) {
  const { colors, reduced } = useTheme();
  const progress = useSharedValue(0);
  const opacity = useSharedValue(0);
  const stroke = useSharedValue(0);
  useEffect(() => {
    opacity.value = withTiming(copied ? 1 : 0, {
      duration: reduced ? 0 : 260,
      easing: ease,
    });
    progress.value = withTiming(copied ? 1 : 0, {
      duration: reduced ? 0 : 380,
      easing: ease,
    });
    stroke.value = withDelay(
      copied && !reduced ? 100 : 0,
      withTiming(copied ? 1 : 0, {
        duration: copied && !reduced ? 380 : 0,
        easing: ease,
      }),
    );
  }, [copied, progress, opacity, reduced, stroke]);
  const oldStyle = useAnimatedStyle(() => ({
    opacity: 1 - opacity.value,
    transform: [{ scale: reduced ? 1 : 1 - 0.4 * progress.value }],
  }));
  const newStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: reduced ? 1 : 0.6 + 0.4 * progress.value }],
  }));
  const path = useAnimatedProps(() => ({
    strokeDashoffset: 14 * (1 - stroke.value),
  }));
  return (
    <View
      style={{ width: size, height: size }}
      pointerEvents="none"
      accessible={false}
    >
      <Animated.View style={[StyleSheet.absoluteFill, oldStyle]}>
        <Copy size={size} strokeWidth={1.65} color={colors.secondary} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, newStyle]}>
        <Svg width={size} height={size} viewBox="0 0 16 16">
          <AnimatedPath
            d="M3.5 8.5 6.5 11.5 12.5 4.5"
            fill="none"
            stroke={colors.text}
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={14}
            animatedProps={path}
          />
        </Svg>
      </Animated.View>
    </View>
  );
}
