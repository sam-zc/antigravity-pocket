import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { Bot, Box, X } from 'lucide-react-native';
import { Text } from '../../components/ui/primitives';
import { IconButton } from '../../components/ui/IconButton';
import { thinBorderWidth, useTheme } from '../../theme/Theme';
import { mockMentions, rankMentions, type MentionItem } from './mentions';

function Highlight({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  return (
    <Text style={s.label}>
      {index < 0 ? (
        text
      ) : (
        <>
          {text.slice(0, index)}
          <Text style={[s.label, { fontWeight: '700' }]}>
            {text.slice(index, index + query.length)}
          </Text>
          {text.slice(index + query.length)}
        </>
      )}
    </Text>
  );
}
export function MentionMenu({
  open,
  query,
  onSelect,
  onClose,
}: {
  open: boolean;
  query: string;
  onSelect: (item: MentionItem) => void;
  onClose: () => void;
}) {
  const { colors, reduced } = useTheme();
  const [mounted, setMounted] = useState(open);
  const [height, setHeight] = useState(0);
  const progress = useRef(new Animated.Value(open ? 1 : 0)).current;
  const size = useRef(new Animated.Value(0)).current;
  const highlight = useRef(new Animated.Value(0)).current;
  const [active, setActive] = useState<string | null>(null);
  const [rows, setRows] = useState<
    Record<string, { y: number; height: number }>
  >({});
  const target = active ? rows[active] : undefined;
  useEffect(() => {
    if (!target) return;
    const motion = Animated.timing(highlight, {
      toValue: target.y,
      duration: reduced ? 0 : 180,
      easing: Easing.bezier(0.23, 1, 0.32, 1),
      useNativeDriver: true,
    });
    motion.start();
    return () => motion.stop();
  }, [target, highlight, reduced]);
  useEffect(() => {
    setActive(null);
  }, [query, open]);
  const latest = useRef(open);
  const lastQuery = useRef(query);
  latest.current = open;
  if (open) lastQuery.current = query;
  const shownQuery = open ? query : lastQuery.current;
  useEffect(() => {
    if (open) setMounted(true);
    const motion = Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: reduced ? 0 : open ? 200 : 160,
      easing: Easing.bezier(0.23, 1, 0.32, 1),
      useNativeDriver: true,
    });
    motion.start(({ finished }) => {
      if (finished && !latest.current) setMounted(false);
    });
    return () => motion.stop();
  }, [open, reduced, progress]);
  useEffect(() => {
    if (!height) return;
    const motion = Animated.timing(size, {
      toValue: height,
      duration: reduced ? 0 : 220,
      easing: Easing.bezier(0.23, 1, 0.32, 1),
      useNativeDriver: false,
    });
    motion.start();
    return () => motion.stop();
  }, [height, size, reduced]);
  const items = rankMentions(mockMentions, shownQuery);
  if (!mounted) return null;
  return (
    <Animated.View
      pointerEvents={open ? 'auto' : 'none'}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      style={[
        s.menu,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          opacity: progress,
          transform: reduced
            ? []
            : [
                {
                  translateY: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [open ? -4 : 4, 0],
                  }),
                },
                {
                  scale: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.96, 1],
                  }),
                },
              ],
        },
      ]}
    >
      <Animated.View
        style={height ? { height: size, overflow: 'hidden' } : undefined}
      >
        <View
          style={s.content}
          onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        >
          <View style={s.heading}>
            <Text muted style={{ fontSize: 12 }}>
              Context
            </Text>
            <IconButton
              icon={X}
              label="Close mentions"
              onPress={onClose}
              size={14}
            />
          </View>
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: 4,
              right: 4,
              top: 0,
              borderRadius: 12,
              height: target?.height ?? 0,
              opacity: target ? 1 : 0,
              backgroundColor: colors.elevated,
              transform: [{ translateY: highlight }],
            }}
          />
          {items.map((item) => {
            const Icon = item.id === 'mock' ? Bot : Box;
            return (
              <Pressable
                key={item.id}
                onLayout={({ nativeEvent: { layout } }) =>
                  setRows((old) =>
                    old[item.id]?.y === layout.y &&
                    old[item.id]?.height === layout.height
                      ? old
                      : {
                          ...old,
                          [item.id]: { y: layout.y, height: layout.height },
                        },
                  )
                }
                onFocus={() => setActive(item.id)}
                onPressIn={() => setActive(item.id)}
                accessibilityRole="button"
                accessibilityLabel={`Mention ${item.label}`}
                onPress={() => {
                  if (open) onSelect(item);
                }}
                style={({ pressed }) => [
                  s.item,
                  {
                    backgroundColor: pressed ? colors.elevated : 'transparent',
                  },
                ]}
              >
                <Icon size={18} color={colors.secondary} strokeWidth={1.8} />
                <View style={{ flex: 1 }}>
                  <Highlight text={item.label} query={shownQuery} />
                  <Text muted style={s.description}>
                    {item.description}
                  </Text>
                </View>
              </Pressable>
            );
          })}
          {!items.length && (
            <Text accessibilityLiveRegion="polite" muted style={s.empty}>
              No matches for “{shownQuery}”
            </Text>
          )}
        </View>
      </Animated.View>
    </Animated.View>
  );
}
const s = StyleSheet.create({
  menu: {
    position: 'absolute',
    bottom: '100%',
    left: 16,
    right: 16,
    maxWidth: 320,
    marginBottom: 8,
    zIndex: 30,
    borderRadius: 16,
    borderWidth: thinBorderWidth,
    boxShadow: '0 8px 24px rgba(0,0,0,0.1)',
  },
  content: { padding: 4 },
  heading: {
    paddingLeft: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  item: {
    minHeight: 52,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  label: { fontSize: 14, lineHeight: 20 },
  description: { fontSize: 12, lineHeight: 18 },
  empty: { padding: 12, fontSize: 13, lineHeight: 20 },
});
