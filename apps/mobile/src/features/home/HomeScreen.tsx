import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import {
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { WelcomeBackdrop, Spark } from '../../components/ui/Ambient';
import { Text } from '../../components/ui/primitives';
import { Notice } from '../../components/ui/Notice';
import { useTheme } from '../../theme/Theme';
import { ChatHeader } from '../chat/ChatHeader';
import { MessageComposer } from '../chat/MessageComposer';
import { SessionDrawer } from '../sessions/SessionDrawer';
import { DrawerScene } from '../sessions/DrawerScene';
import { useNewChat } from './useNewChat';
export function HomeScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [history, setHistory] = useState(false);
  const chat = useNewChat((id) =>
    router.push({ pathname: '/chat/[id]', params: { id } }),
  );
  return (
    <DrawerScene
      open={history}
      onOpenChange={setHistory}
      drawer={
        <SessionDrawer open={history} onClose={() => setHistory(false)} />
      }
    >
      <View style={[s.fill, { backgroundColor: colors.background }]}>
        <WelcomeBackdrop />
        <SafeAreaView edges={['top', 'left', 'right']} style={s.fill}>
          <ChatHeader home onHistory={() => setHistory(true)} />
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={s.fill}
          >
            <View style={s.hero}>
              <Spark />
              <Text accessibilityRole="header" style={s.title}>
                What should we{`\n`}focus on?
              </Text>
            </View>
            {chat.error && (
              <View style={s.notice}>
                <Notice description={chat.error} />
              </View>
            )}
            <View style={{ paddingBottom: Math.max(insets.bottom, 12) + 6 }}>
              <Text muted style={s.preview}>
                LOCAL MOCK PREVIEW
              </Text>
              <MessageComposer
                value={chat.draft}
                onValueChange={chat.change}
                onSubmit={(text) => {
                  void chat.send(text);
                }}
                onStop={() => {}}
                status={
                  chat.busy ? 'submitted' : chat.error ? 'error' : 'ready'
                }
                disabled={!chat.loaded}
              />
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </View>
    </DrawerScene>
  );
}
const s = StyleSheet.create({
  fill: { flex: 1 },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    paddingBottom: 36,
  },
  title: {
    fontSize: 30,
    lineHeight: 37,
    letterSpacing: -0.9,
    textAlign: 'center',
    fontWeight: '400',
  },
  preview: {
    fontSize: 9,
    lineHeight: 16,
    letterSpacing: 1.4,
    textAlign: 'center',
    marginBottom: 12,
  },
  notice: { padding: 16 },
});
