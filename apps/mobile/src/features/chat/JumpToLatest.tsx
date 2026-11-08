import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import Motion from 'react-native-reanimated';
import { LabelChange, usePressMotion } from '../../components/ui/Motion';
import { ArrowDown } from 'lucide-react-native';
import { Text } from '../../components/ui/primitives';
import { thinBorderWidth, useTheme } from '../../theme/Theme';

export function JumpToLatest({
  visible,
  unread,
  streaming,
  onPress,
}: {
  visible: boolean;
  unread: boolean;
  streaming: boolean;
  onPress: () => void;
}) {
  const { colors, reduced } = useTheme();
  const press = usePressMotion(0.96);
  const entrance = useRef(new Animated.Value(0)).current;
  const shift = useRef(new Animated.Value(0)).current;
  const labelOpacity = useRef(new Animated.Value(0)).current;
  const expansion = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const [labelWidth, setLabelWidth] = useState(0);
  const label = streaming ? 'Writing' : 'New reply';
  useEffect(() => {
    const easing = Easing.bezier(0.23, 1, 0.32, 1);
    const motion = Animated.parallel([
      Animated.timing(entrance, {
        toValue: visible ? 1 : 0,
        duration: reduced ? 0 : 220,
        easing,
        useNativeDriver: true,
      }),
      Animated.timing(shift, {
        toValue: visible ? 1 : 0,
        duration: reduced ? 0 : 320,
        easing,
        useNativeDriver: true,
      }),
    ]);
    motion.start();
    return () => motion.stop();
  }, [visible, reduced, entrance, shift]);
  useEffect(() => {
    const motion = Animated.timing(expansion, {
      toValue: unread ? labelWidth : 0,
      duration: reduced ? 0 : 380,
      easing: Easing.bezier(0.23, 1, 0.32, 1),
      useNativeDriver: false,
    });
    motion.start();
    return () => motion.stop();
  }, [unread, labelWidth, reduced, expansion]);
  useEffect(() => {
    const motion = Animated.timing(labelOpacity, {
      toValue: unread ? 1 : 0,
      duration: reduced ? 0 : 260,
      easing: Easing.bezier(0.23, 1, 0.32, 1),
      useNativeDriver: true,
    });
    motion.start();
    return () => motion.stop();
  }, [unread, reduced, labelOpacity]);
  useEffect(() => {
    pulse.setValue(0);
    if (!visible || !unread || !streaming || reduced) return;
    const motion = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1400,
        easing: Easing.bezier(0, 0, 0.2, 1),
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    motion.start();
    return () => motion.stop();
  }, [visible, unread, streaming, reduced, pulse]);
  return (
    <View pointerEvents="box-none" style={s.position}>
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={s.measure}
        onLayout={(event) => setLabelWidth(event.nativeEvent.layout.width)}
      >
        <Text style={s.label}>{label}</Text>
        <View style={{ width: 26 }} />
      </View>
      <Animated.View
        pointerEvents={visible ? 'auto' : 'none'}
        accessibilityElementsHidden={!visible}
        importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
        style={{
          opacity: entrance,
          transform: reduced
            ? []
            : [
                {
                  translateY: shift.interpolate({
                    inputRange: [0, 1],
                    outputRange: [8, 0],
                  }),
                },
                {
                  scale: shift.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.92, 1],
                  }),
                },
              ],
        }}
      >
        <Motion.View style={press.style}>
          <Pressable
            onPressIn={press.onPressIn}
            onPressOut={press.onPressOut}
            accessible
            accessibilityRole="button"
            accessibilityLabel={
              unread
                ? `${streaming ? 'Still writing' : 'New reply'} below. Jump to latest`
                : 'Jump to latest'
            }
            onPress={onPress}
            disabled={!visible}
            style={[
              s.pill,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
              },
            ]}
          >
            <Animated.View style={{ width: expansion, overflow: 'hidden' }}>
              <Animated.View
                style={[
                  s.labelRow,
                  { width: labelWidth, opacity: labelOpacity },
                ]}
              >
                <View style={s.dot}>
                  {streaming && !reduced && (
                    <Animated.View
                      style={[
                        s.dot,
                        {
                          position: 'absolute',
                          backgroundColor: colors.focus,
                          opacity: pulse.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0.55, 0],
                          }),
                          transform: [
                            {
                              scale: pulse.interpolate({
                                inputRange: [0, 1],
                                outputRange: [1, 2.6],
                              }),
                            },
                          ],
                        },
                      ]}
                    />
                  )}
                  <View style={[s.dot, { backgroundColor: colors.focus }]} />
                </View>
                <LabelChange value={label}>
                  <Text
                    numberOfLines={1}
                    style={[
                      s.label,
                      { color: streaming ? colors.secondary : colors.text },
                    ]}
                  >
                    {label}
                  </Text>
                </LabelChange>
              </Animated.View>
            </Animated.View>
            <ArrowDown size={20} color={colors.text} />
          </Pressable>
        </Motion.View>
      </Animated.View>
    </View>
  );
}
const s = StyleSheet.create({
  position: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    right: 12,
    alignItems: 'center',
  },
  measure: { position: 'absolute', flexDirection: 'row', opacity: 0 },
  pill: {
    minWidth: 48,
    minHeight: 48,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: thinBorderWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: 12,
  },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '500' },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
