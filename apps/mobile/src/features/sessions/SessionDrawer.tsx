import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Keyboard } from 'react-native';
import { X, Search, Settings, SquarePen } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { IconButton } from '../../components/ui/IconButton';
import { Button, Dialog, Input, Text } from '../../components/ui/primitives';
import { Notice } from '../../components/ui/Notice';
import { thinBorderWidth, useTheme } from '../../theme/Theme';
import { SessionList } from './SessionList';
import { useSessions } from './useSessions';
export function SessionDrawer({
  open,
  onClose,
  currentId,
}: {
  open: boolean;
  onClose: () => void;
  currentId?: string;
}) {
  const data = useSessions();
  const router = useRouter();
  const { colors } = useTheme();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (open) {
      Keyboard.dismiss();
      void data.refetch();
    } else {
      setSearching(false);
      setCreating(false);
    }
  }, [open, data.refetch]);
  return (
    <SafeAreaView style={[s.fill, { backgroundColor: colors.background }]}>
      <View style={s.body}>
        <View style={s.row}>
          <Text
            heading
            accessibilityRole="header"
            style={{ flex: 1, fontSize: 23, paddingLeft: 12 }}
          >
            Pocket
          </Text>
          <IconButton
            icon={Search}
            label={searching ? 'Close search' : 'Search history'}
            selected={searching}
            style={{
              borderWidth: thinBorderWidth,
              borderColor: colors.border,
            }}
            onPress={() => {
              Keyboard.dismiss();
              setSearching(!searching);
            }}
          />
          <IconButton
            icon={X}
            label="Close history"
            onPress={onClose}
            style={{
              borderWidth: thinBorderWidth,
              borderColor: colors.border,
            }}
          />
        </View>
        <View style={{ marginTop: 12, marginBottom: 16 }}>
          <Button
            label="New session"
            align="left"
            variant="navigation"
            icon={SquarePen}
            onPress={() => setCreating(true)}
          />
        </View>
        {data.isError && (
          <Notice
            description="Could not load sessions."
            onRetry={() => {
              void data.refetch();
            }}
          />
        )}
        <SessionList
          drawer
          searchOpen={searching}
          sessions={data.sessions}
          currentId={currentId}
          onSelect={(id) => {
            onClose();
            router.replace({ pathname: '/chat/[id]', params: { id } });
          }}
          hasMore={!!data.hasNextPage}
          loadingMore={data.isFetchingNextPage}
          onMore={() => {
            void data.fetchNextPage();
          }}
        />
        <View style={s.footer}>
          <View style={[s.avatar, { backgroundColor: colors.accent }]}>
            <Text style={{ color: colors.onAccent, fontWeight: '600' }}>P</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: '600', fontSize: 14 }}>
              Local workspace
            </Text>
            <Text muted style={{ fontSize: 11 }}>
              Mock preview · Unofficial
            </Text>
          </View>
          <IconButton
            icon={Settings}
            label="Settings"
            onPress={() => {
              onClose();
              router.push('/settings');
            }}
          />
        </View>
      </View>
      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Create a Mock session"
      >
        <View style={{ gap: 16 }}>
          <Input
            label="Session title"
            value={title}
            onChangeText={setTitle}
            maxLength={120}
            autoFocus
          />
          <Text muted>Synthetic sandbox</Text>
          {data.createError && <Notice description={data.createError} />}
          <Button
            label="Create session"
            disabled={!title.trim()}
            status={data.creating ? 'pending' : 'idle'}
            onPress={() => {
              void data.create(title.trim()).then((id) => {
                if (id) {
                  setCreating(false);
                  setTitle('');
                  onClose();
                  router.push({ pathname: '/chat/[id]', params: { id } });
                }
              });
            }}
          />
        </View>
      </Dialog>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  fill: { flex: 1 },
  body: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 8,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 8,
    paddingHorizontal: 12,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
