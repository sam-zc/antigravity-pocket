// App-owned native reveal navigation.
import React, { useEffect, useState } from 'react';
import {
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  GestureDetector,
  GestureHandlerRootView,
  GestureStateManager,
  usePanGesture,
} from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../../theme/Theme';

const spring = {
  stiffness: 310,
  damping: 34,
  mass: 0.85,
  overshootClamping: true,
};

export function DrawerScene({
  open,
  onOpenChange,
  drawer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  drawer: React.ReactNode;
  children: React.ReactNode;
}) {
  const { width } = useWindowDimensions();
  // Android reserves the outer edge for system Back; include an inner strip.
  const openingEdge = Platform.OS === 'android' ? 48 : 28;
  const { colors, reduced } = useTheme();
  const [dragging, setDragging] = useState(false);
  const position = useSharedValue(open ? width : 0);
  const target = useSharedValue(open);
  const extent = useSharedValue(width);
  const origin = useSharedValue(0);
  const begin = () => {
    Keyboard.dismiss();
    setDragging(true);
  };
  const finish = (next: boolean) => {
    setDragging(false);
    onOpenChange(next);
  };

  useEffect(() => {
    if (open) Keyboard.dismiss();
    // A gesture already started the spring with its release velocity. Do not
    // restart that spring when the semantic open state catches up on JS.
    if (target.value !== open || extent.value !== width) {
      target.value = open;
      extent.value = width;
      position.value = reduced
        ? withTiming(open ? width : 0, { duration: 140 })
        : withSpring(open ? width : 0, spring);
    }
  }, [open, width, reduced, position, target, extent]);
  useEffect(() => {
    if (!open && !dragging) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onOpenChange(false);
      return true;
    });
    return () => sub.remove();
  }, [open, dragging, onOpenChange]);

  const pan = usePanGesture({
    activeOffsetX: [-10, 10],
    failOffsetY: [-12, 12],
    maxPointers: 1,
    onTouchesDown: (event) => {
      'worklet';
      // Only an edge swipe may open a closed chat: code scrolling, text
      // selection and the composer retain their normal horizontal gestures.
      if (position.value < 1 && (event.allTouches[0]?.x ?? width) > openingEdge)
        GestureStateManager.fail(event.handlerTag);
    },
    onActivate: () => {
      'worklet';
      cancelAnimation(position);
      origin.value = position.value;
      runOnJS(begin)();
    },
    onUpdate: (event) => {
      'worklet';
      if (!reduced)
        position.value = Math.max(
          0,
          Math.min(width, origin.value + event.translationX),
        );
    },
    onDeactivate: (event) => {
      'worklet';
      const released = Math.max(
        0,
        Math.min(width, origin.value + event.translationX),
      );
      const next = event.canceled
        ? target.value
        : released + event.velocityX * 0.18 > width / 2;
      target.value = next;
      position.value = reduced
        ? withTiming(next ? width : 0, { duration: 140 })
        : withSpring(next ? width : 0, {
            ...spring,
            velocity: event.canceled ? 0 : event.velocityX,
          });
      runOnJS(finish)(next);
    },
  });
  const foreground = useAnimatedStyle(() => {
    const progress = Math.max(0, Math.min(1, position.value / width));
    return {
      transform: [{ translateX: reduced ? 0 : position.value }],
      opacity: reduced ? 1 - progress : 1,
      borderRadius: reduced
        ? 0
        : interpolate(progress, [0, 0.08, 1], [0, 48, 48], 'clamp'),
    };
  });
  const background = useAnimatedStyle(() => ({
    // Hidden underlays must not leak native accessibility nodes while closed.
    // Keep the React tree mounted; reveal it on the first UI-thread movement.
    display: position.value <= 0 ? 'none' : 'flex',
    transform: [
      {
        scale: reduced
          ? 1
          : 0.96 + 0.04 * Math.max(0, Math.min(1, position.value / width)),
      },
    ],
  }));
  const shade = useAnimatedStyle(() => ({
    opacity: reduced
      ? 0
      : 0.32 * (1 - Math.max(0, Math.min(1, position.value / width))),
  }));
  const covered = open || dragging;
  return (
    <GestureHandlerRootView style={s.fill}>
      <GestureDetector gesture={pan}>
        <View style={[s.fill, s.clip, { backgroundColor: colors.background }]}>
          <Animated.View style={[StyleSheet.absoluteFill, background]}>
            <View
              collapsable={false}
              style={s.fill}
              pointerEvents={open && !dragging ? 'auto' : 'none'}
              accessibilityViewIsModal={open}
              accessibilityElementsHidden={!open || dragging}
              importantForAccessibility={
                open && !dragging ? 'auto' : 'no-hide-descendants'
              }
              onAccessibilityEscape={() => onOpenChange(false)}
            >
              {drawer}
            </View>
          </Animated.View>
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: '#000' },
              shade,
            ]}
          />
          <Animated.View
            pointerEvents={covered ? 'none' : 'auto'}
            style={[
              s.fill,
              s.clip,
              { backgroundColor: colors.background },
              foreground,
            ]}
          >
            <View
              collapsable={false}
              style={s.fill}
              pointerEvents={covered ? 'none' : 'auto'}
              accessibilityElementsHidden={covered}
              importantForAccessibility={
                covered ? 'no-hide-descendants' : 'auto'
              }
            >
              {children}
            </View>
          </Animated.View>
          {/* The moving chat stays mounted, preserving scroll, draft and stream. */}
          {covered && !reduced && (
            <Animated.View
              style={[StyleSheet.absoluteFill, foreground]}
              pointerEvents="box-none"
            >
              <Pressable
                style={s.fill}
                accessible={false}
                onPress={() => onOpenChange(false)}
              />
            </Animated.View>
          )}
        </View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
}
const s = StyleSheet.create({
  fill: { flex: 1 },
  clip: { overflow: 'hidden' },
});
