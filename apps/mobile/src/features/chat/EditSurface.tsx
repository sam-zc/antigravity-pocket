import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  withDelay,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { ChevronDown } from 'lucide-react-native';
import { IconButton } from '../../components/ui/IconButton';
import { Text } from '../../components/ui/primitives';
import { useTheme } from '../../theme/Theme';

const ease = Easing.bezier(0.23, 1, 0.32, 1);
export function EditSurface({
  editing,
  text,
  children,
  onDisclosure,
}: {
  editing: boolean;
  text: string;
  children: React.ReactNode;
  onDisclosure?: () => void;
}) {
  const { colors, reduced } = useTheme();
  const [available, setAvailable] = useState(0);
  const [rest, setRest] = useState({ width: 0, height: 0 });
  const [expanded, setExpanded] = useState(false);
  const [foldedHeight, setFoldedHeight] = useState<number | null>(null);
  const foldable = foldedHeight !== null;
  const [editHeight, setEditHeight] = useState(0);
  const measured = useRef(false);
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  const progress = useSharedValue(editing ? 1 : 0);
  useEffect(() => {
    if (!rest.width || !available) return;
    const nextWidth = editing ? available : rest.width;
    const promptHeight =
      !expanded && foldedHeight !== null ? foldedHeight : rest.height;
    const nextHeight = editing
      ? editHeight || rest.height
      : promptHeight + (foldable && expanded ? 40 : 0);
    const immediate = reduced || !measured.current;
    measured.current = true;
    const config = { duration: immediate ? 0 : 380, easing: ease };
    // Assigning a new timing animation starts at the presentation value, so
    // cancelling/reopening during the morph never jumps to its previous target.
    width.value = withTiming(nextWidth, config);
    height.value = withTiming(nextHeight, config);
    progress.value = withTiming(editing ? 1 : 0, {
      duration: immediate ? 0 : 300,
      easing: ease,
    });
  }, [
    available,
    editHeight,
    editing,
    height,
    progress,
    reduced,
    rest,
    width,
    expanded,
    foldedHeight,
    foldable,
  ]);
  const editorOpacity = useSharedValue(0);
  useEffect(() => {
    editorOpacity.value = editing
      ? withDelay(
          reduced ? 0 : 100,
          withTiming(1, {
            duration: reduced ? 0 : 220,
            easing: Easing.bezier(0, 0, 0.58, 1),
          }),
        )
      : withTiming(0, { duration: 0 });
  }, [editing, editorOpacity, reduced]);
  const editorStyle = useAnimatedStyle(() => ({
    opacity: editorOpacity.value,
  }));
  const surface = useAnimatedStyle(() => ({
    width: width.value,
    height: height.value,
    backgroundColor: interpolateColor(
      progress.value,
      [0, 1],
      [colors.elevated, colors.surface],
    ),
    borderColor: interpolateColor(
      progress.value,
      [0, 1],
      [colors.elevated, colors.border],
    ),
  }));
  const fullStyle = useAnimatedStyle(() => ({
    opacity: withTiming(expanded || !foldable ? 1 : 0, {
      duration: reduced ? 0 : 180,
    }),
  }));
  const foldedStyle = useAnimatedStyle(() => ({
    opacity: withTiming(!expanded && foldable ? 1 : 0, {
      duration: reduced ? 0 : 180,
    }),
  }));
  const chevron = useAnimatedStyle(() => ({
    transform: [
      {
        rotate: withTiming(expanded ? '180deg' : '0deg', {
          duration: reduced ? 0 : 330,
          easing: ease,
        }),
      },
    ],
  }));
  return (
    <View
      style={s.container}
      onLayout={({ nativeEvent }) => setAvailable(nativeEvent.layout.width)}
    >
      {/* Natural bubble measurement stays outside the animated constraint.
          It is never an interactive or accessibility duplicate. */}
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={s.measure}
        onLayout={({ nativeEvent: { layout } }) => {
          setRest((old) =>
            old.width === layout.width && old.height === layout.height
              ? old
              : { width: layout.width, height: layout.height },
          );
        }}
      >
        <Text
          testID="prompt-measurement"
          style={s.prompt}
          onTextLayout={({ nativeEvent }) => {
            const lines = nativeEvent.lines;
            const next =
              lines.length > 4
                ? lines
                    .slice(0, 4)
                    .reduce((total, line) => total + line.height, 0) + 20
                : null;
            setFoldedHeight((previous) =>
              previous === next ? previous : next,
            );
          }}
        >
          {text}
        </Text>
      </View>
      <Animated.View testID="message-edit-surface" style={[s.surface, surface]}>
        <Animated.View
          pointerEvents={editing ? 'auto' : 'none'}
          accessibilityElementsHidden={!editing}
          importantForAccessibility={editing ? 'auto' : 'no-hide-descendants'}
          style={[
            s.content,
            { width: Math.max(0, available - 2) },
            editorStyle,
          ]}
          onLayout={({ nativeEvent }) =>
            setEditHeight(nativeEvent.layout.height + 2)
          }
        >
          {children}
        </Animated.View>
        {!editing && (
          <Animated.View
            entering={FadeIn.duration(reduced ? 0 : 220)
              .easing(Easing.bezier(0, 0, 0.58, 1))
              .delay(reduced ? 0 : 100)}
            style={[s.content, { width: Math.max(0, rest.width - 2) }]}
          >
            <Animated.View
              style={fullStyle}
              pointerEvents={expanded || !foldable ? 'auto' : 'none'}
              accessibilityElementsHidden={!expanded && foldable}
              importantForAccessibility={
                !expanded && foldable ? 'no-hide-descendants' : 'auto'
              }
            >
              <Text selectable style={s.prompt}>
                {text}
              </Text>
            </Animated.View>
            {foldable && (
              <Animated.View
                style={[StyleSheet.absoluteFill, foldedStyle]}
                pointerEvents={expanded ? 'none' : 'auto'}
                accessibilityElementsHidden={expanded}
                importantForAccessibility={
                  expanded ? 'no-hide-descendants' : 'auto'
                }
              >
                <Text
                  selectable
                  numberOfLines={4}
                  ellipsizeMode="tail"
                  style={s.prompt}
                >
                  {text}
                </Text>
              </Animated.View>
            )}
          </Animated.View>
        )}
        {!editing && foldable && (
          <View style={s.toggle}>
            {!expanded && (
              <LinearGradient
                pointerEvents="none"
                colors={[
                  `${colors.elevated}00`,
                  colors.elevated,
                  colors.elevated,
                ]}
                locations={[0, 0.55, 1]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={{
                  position: 'absolute',
                  right: 0,
                  bottom: 9,
                  width: 76,
                  height: 24,
                }}
              />
            )}
            <IconButton
              label={expanded ? 'Collapse message' : 'Expand message'}
              icon={ChevronDown}
              expanded={expanded}
              size={16}
              onPress={() => {
                onDisclosure?.();
                setExpanded((value) => !value);
              }}
              style={{ width: 44, height: 44 }}
            >
              <Animated.View style={chevron}>
                <ChevronDown size={16} color={colors.text} />
              </Animated.View>
            </IconButton>
          </View>
        )}
      </Animated.View>
    </View>
  );
}
const s = StyleSheet.create({
  container: { width: '100%', alignItems: 'flex-end' },
  measure: {
    position: 'absolute',
    right: 0,
    top: 0,
    maxWidth: '85%',
    opacity: 0,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  surface: { borderRadius: 20, borderWidth: 1, overflow: 'hidden' },
  toggle: { position: 'absolute', right: 4, bottom: 0 },
  content: { position: 'absolute', top: 0, right: 0 },
  prompt: {
    fontSize: 14,
    lineHeight: 22,
    paddingHorizontal: 15,
    paddingVertical: 9,
  },
});
