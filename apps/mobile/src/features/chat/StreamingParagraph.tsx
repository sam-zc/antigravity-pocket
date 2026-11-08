import React, { memo, useEffect, useRef, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Text } from '../../components/ui/Text';
import { useTheme } from '../../theme/Theme';
const Word = memo(function Word({ word }: { word: string }) {
  const { colors, reduced } = useTheme();
  const color = useSharedValue(reduced ? colors.text : `${colors.text}00`);
  useEffect(() => {
    color.value = withTiming(colors.text, {
      duration: reduced ? 0 : 420,
      easing: Easing.bezier(0, 0, 0.58, 1),
    });
  }, [colors.text, reduced, color]);
  const style = useAnimatedStyle(() => ({ color: color.value }));
  return <Animated.Text style={style}>{word}</Animated.Text>;
});
export const StreamingParagraph = memo(function StreamingParagraph({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}) {
  const { colors, reduced } = useTheme();
  // Keep the same text tree when a live paragraph settles; historical mounts
  // do not allocate a worklet for every word or replay arrival animations.
  const animateWords = useRef(streaming && !reduced).current;
  const [end, setEnd] = useState({ x: 0, y: 0, height: 20 });
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = 1;
    if (streaming && !reduced)
      opacity.value = withRepeat(
        withSequence(
          withDelay(500, withTiming(0, { duration: 0 })),
          withDelay(500, withTiming(1, { duration: 0 })),
        ),
        -1,
      );
    return () => cancelAnimation(opacity);
  }, [streaming, reduced, opacity]);
  const caret = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <View>
      <Text
        selectable
        style={s.answer}
        onTextLayout={
          streaming
            ? ({ nativeEvent }) => {
                const line = nativeEvent.lines.at(-1);
                if (!line) return;
                const x = line.x + line.width;
                const y = line.y + line.height * 0.15;
                const height = line.height * 0.75;
                setEnd((old) =>
                  old.x === x && old.y === y && old.height === height
                    ? old
                    : { x, y, height },
                );
              }
            : undefined
        }
      >
        {animateWords
          ? text
              .split(/(\s+)/)
              .map((word, index) =>
                /^\s+$/.test(word) ? word : <Word key={index} word={word} />,
              )
          : text}
      </Text>
      {streaming && (
        <Animated.View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            {
              position: 'absolute',
              left: end.x,
              top: end.y,
              width: 2,
              height: end.height,
              backgroundColor: colors.text,
            },
            caret,
          ]}
        />
      )}
    </View>
  );
});
const s = StyleSheet.create({ answer: { fontSize: 16, lineHeight: 26 } });
