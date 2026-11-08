import React, { useCallback, useRef, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { AccessibilityInfo, findNodeHandle, View } from 'react-native';
import {
  Button,
  Dialog,
  Input,
  Screen,
  Text,
} from '../../components/ui/primitives';
import { Notice } from '../../components/ui/Notice';
import { useSessions } from './useSessions';
import { SessionList } from './SessionList';
export function SessionsScreen() {
  const data = useSessions();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const trigger = useRef<React.ComponentRef<typeof View>>(null);
  useFocusEffect(
    useCallback(() => {
      void data.refetch();
    }, [data.refetch]),
  );
  const select = (id: string) =>
    router.push({ pathname: '/chat/[id]', params: { id } });
  const close = () => {
    setOpen(false);
    const handle = findNodeHandle(trigger.current);
    if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
  };
  return (
    <Screen>
      <Text heading accessibilityRole="header">
        Sessions
      </Text>
      <View ref={trigger}>
        <Button label="New session" onPress={() => setOpen(true)} />
      </View>
      {data.isLoading && (
        <Text accessibilityLiveRegion="polite">Loading sessions…</Text>
      )}
      {data.isError && (
        <Notice
          description="Could not load sessions. Check the gateway or reconnect in Settings."
          onRetry={() => {
            void data.refetch();
          }}
        />
      )}
      <SessionList
        sessions={data.sessions}
        onSelect={select}
        hasMore={!!data.hasNextPage}
        loadingMore={data.isFetchingNextPage}
        onMore={() => {
          void data.fetchNextPage();
        }}
      />
      <Dialog open={open} onClose={close} title="Create a Mock session">
        <Input
          label="Session title"
          value={title}
          onChangeText={setTitle}
          maxLength={120}
          autoFocus
        />
        <Text muted>Synthetic sandbox · No real workspace access</Text>
        {data.createError && <Notice description={data.createError} />}
        <Button
          label="Create session"
          disabled={!title.trim()}
          status={data.creating ? 'pending' : 'idle'}
          onPress={() => {
            void data.create(title.trim()).then((id) => {
              if (id) {
                close();
                setTitle('');
                select(id);
              }
            });
          }}
        />
      </Dialog>
    </Screen>
  );
}
