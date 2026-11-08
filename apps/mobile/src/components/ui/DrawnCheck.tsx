import React, { useEffect } from 'react';
import Svg, { Path } from 'react-native-svg';
import Animated, {
  useAnimatedProps,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../../theme/Theme';
import { easeOut } from './Motion';
const AnimatedPath = Animated.createAnimatedComponent(Path);
export function DrawnCheck({
  active,
  color,
  size = 16,
}: {
  active: boolean;
  color: string;
  size?: number;
}) {
  const { reduced } = useTheme();
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withDelay(
      active && !reduced ? 100 : 0,
      withTiming(active ? 1 : 0, {
        duration: active && !reduced ? 420 : 0,
        easing: easeOut,
      }),
    );
  }, [active, reduced, progress]);
  const props = useAnimatedProps(() => ({
    strokeDashoffset: 14 * (1 - progress.value),
  }));
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <AnimatedPath
        d="M3.5 8.5 6.5 11.5 12.5 4.5"
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={14}
        animatedProps={props}
      />
    </Svg>
  );
}
