import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { id as idSchema } from '@pocket/protocol';
import { ChatScreen } from '../../src/features/chat/ChatScreen';
import { Screen, Text } from '../../src/components/ui/primitives';
export default function ChatRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const parsed = idSchema.safeParse(id);
  return parsed.success ? (
    <ChatScreen key={parsed.data} id={parsed.data} />
  ) : (
    <Screen>
      <Text>Invalid session link.</Text>
    </Screen>
  );
}
