import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SectionList, type ViewProps } from 'react-native';
import Animated, {
  FadeInDown,
  LinearTransition,
} from 'react-native-reanimated';
import { easeSize, easeOut } from '../../components/ui/Motion';
import { useTheme } from '../../theme/Theme';
import type { Session } from '@pocket/protocol';
import { Button, Input, Text } from '../../components/ui/primitives';
function HistoryCell({ children, style, onLayout }: ViewProps) {
  const { reduced } = useTheme();
  return (
    <Animated.View
      onLayout={onLayout}
      style={style}
      layout={LinearTransition.duration(reduced ? 0 : 420).easing(easeOut)}
    >
      {children}
    </Animated.View>
  );
}
function Arrival({
  id,
  known,
  children,
}: {
  id: string;
  known: Set<string>;
  children: React.ReactNode;
}) {
  const { reduced } = useTheme();
  const [fresh] = useState(() => {
    const first = !known.has(id);
    known.add(id);
    return first;
  });
  return (
    <Animated.View
      entering={
        fresh && !reduced
          ? FadeInDown.duration(280)
              .easing(easeSize)
              .withInitialValues({ opacity: 0, transform: [{ translateY: 4 }] })
          : undefined
      }
    >
      {children}
    </Animated.View>
  );
}
const DAY = 86400000;
const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
export function bucket(date: Date, today: number) {
  const days = Math.round((today - startOfDay(date)) / DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  return date.toLocaleDateString('en-US', {
    month: 'long',
    year:
      new Date(today).getFullYear() === date.getFullYear()
        ? undefined
        : 'numeric',
  });
}
export function SessionList({
  sessions,
  onSelect,
  onMore,
  hasMore,
  loadingMore = false,
  currentId,
  drawer = false,
  searchOpen = true,
}: {
  sessions: Session[];
  onSelect: (id: string) => void;
  onMore: () => void;
  hasMore: boolean;
  loadingMore?: boolean;
  currentId?: string;
  drawer?: boolean;
  searchOpen?: boolean;
}) {
  const [query, setQuery] = useState('');
  const known = useRef(new Set<string>()).current;
  useEffect(() => {
    if (!searchOpen) setQuery('');
  }, [searchOpen]);
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = sessions.filter(
      (c) => !q || c.title.toLowerCase().includes(q),
    );
    const groups = new Map<string, Session[]>();
    for (const chat of [...visible].sort(
      (a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt),
    )) {
      const name = drawer
        ? 'All chats'
        : bucket(new Date(chat.updatedAt), startOfDay(new Date()));
      groups.set(name, [...(groups.get(name) ?? []), chat]);
    }
    return [...groups].map(([title, data]) => ({ title, data }));
  }, [sessions, query, drawer]);
  return (
    <>
      {searchOpen && (
        <Input
          label="Search sessions"
          value={query}
          onChangeText={setQuery}
          clearable
          hideLabel
          placeholder="Search conversations"
          autoFocus={drawer}
        />
      )}
      <SectionList
        CellRendererComponent={HistoryCell}
        sections={sections}
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        stickySectionHeadersEnabled={false}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ gap: drawer ? 0 : 4, paddingBottom: 12 }}
        renderSectionHeader={({ section }) => (
          <Text muted style={{ fontSize: 12, padding: 12 }}>
            {section.title}
          </Text>
        )}
        renderItem={({ item }) => (
          <Arrival id={item.id} known={known}>
            <Button
              label={item.title}
              variant={drawer ? 'navigation' : 'ghost'}
              selected={item.id === currentId}
              align="left"
              onPress={() => onSelect(item.id)}
            />
          </Arrival>
        )}
        ListEmptyComponent={
          <Text muted>
            {query
              ? `No loaded sessions match “${query.trim()}”`
              : 'No sessions yet. Create your first Mock session.'}
          </Text>
        }
        ListFooterComponent={
          hasMore ? (
            <Button
              label="Load more sessions"
              variant="ghost"
              status={loadingMore ? 'pending' : 'idle'}
              onPress={onMore}
            />
          ) : undefined
        }
      />
    </>
  );
}
