import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../../theme/Theme';

export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeSize = Easing.bezier(0.23, 1, 0.32, 1);
export const easeThrow = Easing.bezier(0.34, 1.36, 0.64, 1);

export function usePressMotion(amount = 0.97) {
  const { reduced } = useTheme();
  const down = useSharedValue(1);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: down.value }],
  }));
  useEffect(() => {
    if (reduced) down.value = 1;
  }, [reduced, down]);
  return {
    style,
    onPressIn: () => {
      down.value = withTiming(reduced ? 1 : amount, {
        duration: 200,
        easing: easeOut,
      });
    },
    onPressOut: () => {
      down.value = withTiming(1, {
        duration: reduced ? 0 : 200,
        easing: easeOut,
      });
    },
  };
}

export function useErrorShake(error: string | boolean) {
  const { reduced } = useTheme();
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = 0;
    if (error && !reduced)
      progress.value = withTiming(1, {
        duration: 380,
        easing: Easing.bezier(0, 0, 0.58, 1),
      });
    return () => cancelAnimation(progress);
  }, [error, reduced, progress]);
  return useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          progress.value,
          [0, 0.25, 0.5, 0.75, 1],
          [0, -4, 4, -2, 0],
        ),
      },
    ],
  }));
}

/** Keeps the outgoing contents while closing, but removes their interaction. */
export function Reveal({
  open,
  children,
  duration = 320,
  easing = easeOut,
  fadeIn = 280,
  fadeOut = 140,
  style,
}: {
  open: boolean;
  children: React.ReactNode;
  duration?: number;
  easing?: typeof easeOut;
  fadeIn?: number;
  fadeOut?: number;
  style?: ViewStyle;
}) {
  const { reduced } = useTheme();
  const kept = useRef(children);
  if (open) kept.current = children;
  const [height, setHeight] = useState<number>();
  const initialized = useRef(false);
  const size = useSharedValue(0);
  const opacity = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    if (height === undefined) return;
    const immediate = reduced || !initialized.current;
    initialized.current = true;
    size.value = withTiming(open ? height : 0, {
      duration: immediate ? 0 : duration,
      easing,
    });
    opacity.value = withTiming(open ? 1 : 0, {
      duration: reduced ? 0 : open ? fadeIn : fadeOut,
      easing: easeOut,
    });
  }, [height, open, reduced, duration, easing, fadeIn, fadeOut, size, opacity]);
  const animated = useAnimatedStyle(() => ({
    height: size.value,
    opacity: opacity.value,
  }));
  return (
    <Animated.View
      pointerEvents={open ? 'auto' : 'none'}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      style={[{ overflow: 'hidden' }, animated, style]}
    >
      <View
        style={{ position: 'absolute', top: 0, left: 0, right: 0 }}
        onLayout={({ nativeEvent }) => setHeight(nativeEvent.layout.height)}
      >
        {open ? children : kept.current}
      </View>
    </Animated.View>
  );
}

/** Native whole-label fade. */
export function LabelChange({
  value,
  children,
}: {
  value: string;
  children: React.ReactNode;
}) {
  const { reduced } = useTheme();
  return (
    <Animated.View
      key={value}
      entering={FadeIn.duration(reduced ? 0 : 220).easing(easeOut)}
    >
      {children}
    </Animated.View>
  );
}

export function IconLayer({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  const { reduced } = useTheme();
  const style = useAnimatedStyle(() => ({
    opacity: withTiming(active ? 1 : 0, {
      duration: reduced ? 0 : 260,
      easing: easeOut,
    }),
    transform: [
      {
        scale: withTiming(active || reduced ? 1 : 0.6, {
          duration: reduced ? 0 : 380,
          easing: easeOut,
        }),
      },
    ],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { alignItems: 'center', justifyContent: 'center' },
        style,
      ]}
    >
      {children}
    </Animated.View>
  );
}

export function Spinner({
  active,
  color,
  size = 16,
}: {
  active: boolean;
  color: string;
  size?: number;
}) {
  const { reduced } = useTheme();
  const turn = useSharedValue(0);
  useEffect(() => {
    turn.value = 0;
    if (active && !reduced)
      turn.value = withRepeat(
        withTiming(360, { duration: 1000, easing: Easing.linear }),
        -1,
      );
    return () => cancelAnimation(turn);
  }, [active, reduced, turn]);
  const style = useAnimatedStyle(() => ({
    transform: [{ rotate: `${turn.value}deg` }],
  }));
  return (
    <Animated.View
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1.5,
          borderColor: color,
          borderTopColor: 'transparent',
        },
        style,
      ]}
    />
  );
}

export function Blink({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  const { reduced } = useTheme();
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = 1;
    if (active && !reduced)
      opacity.value = withRepeat(
        withSequence(
          withDelay(500, withTiming(0, { duration: 0 })),
          withDelay(500, withTiming(1, { duration: 0 })),
        ),
        -1,
      );
    return () => cancelAnimation(opacity);
  }, [active, reduced, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View accessible={false} pointerEvents="none" style={style}>
      {children}
    </Animated.View>
  );
}
