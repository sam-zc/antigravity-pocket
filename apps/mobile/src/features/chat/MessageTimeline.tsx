import React, { useState } from 'react';
import { FlatList, View } from 'react-native';
import type { Message } from '@pocket/protocol';
import { Button, Text } from '../../components/ui/primitives';
import { AppActivityCard } from './AppActivityCard';
import { MessageBubble } from './MessageBubble';
import { JumpToLatest } from './JumpToLatest';
import { useChatScroll } from './useChatScroll';
export function MessageTimeline({
  messages,
  streaming,
  historyReady = true,
  editDisabled = false,
  hasOlder,
  onOlder,
  onEdit,
}: {
  messages: Message[];
  streaming: boolean;
  historyReady?: boolean;
  editDisabled?: boolean;
  hasOlder: boolean;
  onOlder: () => void;
  onEdit?: (text: string) => Promise<boolean>;
}) {
  const scroll = useChatScroll(messages);
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <View style={{ flex: 1 }}>
      <FlatList
        ref={scroll.list}
        accessibilityLabel="Conversation"
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) =>
          item.role === 'activity' ? (
            <AppActivityCard message={item} onDisclosure={scroll.pause} />
          ) : (
            <View>
              <MessageBubble
                message={item}
                busy={streaming || editDisabled}
                onEdit={onEdit}
                onDisclosure={scroll.pause}
                onEditingChange={(editing) => {
                  setEditingId(editing ? item.id : null);
                  if (editing) scroll.pause();
                }}
              />
              {item.contentOmitted && (
                <Text muted>
                  Some message content is omitted in this bounded view.
                </Text>
              )}
            </View>
          )
        }
        contentContainerStyle={{
          gap: 12,
          paddingHorizontal: 24,
          paddingBottom: 24,
        }}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        windowSize={7}
        onScrollBeginDrag={scroll.onDrag}
        onScrollEndDrag={scroll.onDragEnd}
        onScroll={({ nativeEvent }) => scroll.onScroll(nativeEvent)}
        scrollEventThrottle={16}
        onContentSizeChange={scroll.onSize}
        onLayout={({ nativeEvent }) =>
          scroll.onLayout(nativeEvent.layout.height)
        }
        ListHeaderComponent={
          hasOlder ? (
            <Button
              label="Load earlier messages"
              variant="outline"
              onPress={onOlder}
            />
          ) : undefined
        }
        ListEmptyComponent={
          historyReady ? (
            <Text muted style={{ textAlign: 'center', paddingTop: 32 }}>
              Your conversation starts here.
            </Text>
          ) : undefined
        }
      />
      <JumpToLatest
        visible={scroll.away && !editingId}
        unread={scroll.unread}
        streaming={streaming}
        onPress={() => scroll.latest()}
      />
    </View>
  );
}
