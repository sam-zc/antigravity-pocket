import { AppSendStatus } from './AppSendStatus';
import React, { useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { Button, Text } from '../../components/ui/primitives';
import { Notice } from '../../components/ui/Notice';
import { CancelResponseSheet } from './CancelResponseSheet';
import { GenerationBackdrop } from './GenerationBackdrop';
import { MessageComposer } from './MessageComposer';
import { MessageTimeline } from './MessageTimeline';
import { ChatHeader } from './ChatHeader';
import { SessionDrawer } from '../sessions/SessionDrawer';
import { DrawerScene } from '../sessions/DrawerScene';
import { useConnectionFeedback } from './useConnectionFeedback';
import { useChat } from './useChat';
import { usePocket } from '../../services/PocketProvider';
import { useTheme } from '../../theme/Theme';
export function ChatScreen({ id }: { id: string }) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const chat = useChat(id);
  const { reauthenticate, runtime, notice } = usePocket();
  const [history, setHistory] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const feedback = useConnectionFeedback(
    id,
    !chat.snapshot && chat.state === 'live' ? 'connecting' : chat.state,
  );
  const loading = feedback === 'loading';
  const terminal = chat.terminal;
  const external = chat.snapshot?.session.external;
  const caption = loading
    ? chat.snapshot
      ? 'Connecting…'
      : 'Loading…'
    : feedback === 'storage-error'
      ? 'Storage unavailable'
      : feedback === 'recovering'
        ? 'Reconnecting…'
        : feedback === 'auth-required'
          ? 'Connection needed'
          : feedback === 'incompatible'
            ? 'Update required'
            : external
              ? `App ${external.observation} · ${external.send ? 'experimental send' : 'read-only'}`
              : (chat.run?.state ??
                (terminal?.reason === 'process_restarted'
                  ? 'Interrupted'
                  : (terminal?.state ?? 'Ready')));
  const status = `${chat.state} · ${caption}`;
  return (
    <DrawerScene
      open={history}
      onOpenChange={setHistory}
      drawer={
        <SessionDrawer
          open={history}
          currentId={id}
          onClose={() => setHistory(false)}
        />
      }
    >
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <GenerationBackdrop active={!!chat.run && chat.state === 'live'} />
        <View
          style={{
            flex: 1,
            paddingTop: insets.top,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          }}
        >
          <ChatHeader
            external={!!external}
            status={status}
            loading={loading}
            onHistory={() => setHistory(true)}
          />
          {(feedback === 'recovering' ||
            feedback === 'auth-required' ||
            feedback === 'incompatible' ||
            feedback === 'storage-error') && (
            <View style={{ padding: 16 }}>
              <Notice
                kind={feedback === 'incompatible' ? 'error' : 'offline'}
                title={
                  feedback === 'storage-error'
                    ? 'Local storage needs attention'
                    : feedback === 'auth-required'
                      ? runtime?.api.credential
                        ? 'Workspace access changed'
                        : 'Reconnect with the current credential'
                      : feedback === 'incompatible'
                        ? 'Gateway update required'
                        : 'Recovering your conversation'
                }
                description={
                  feedback === 'storage-error'
                    ? 'Content is hidden and sending is paused. Restart Pocket; if cleanup still fails, clear Pocket data before reconnecting. Uncertain sends must be reviewed on desktop.'
                    : feedback === 'auth-required'
                      ? runtime?.api.credential
                        ? 'The desktop changed your permissions. Cached content was cleared. Return to Home or pair again for new grants.'
                        : 'Reconnect with the current desktop credential. Removed sources stay hidden; pending sends are never retried.'
                      : feedback === 'incompatible'
                        ? 'This gateway uses an unsupported protocol. Update the app and gateway before reconnecting.'
                        : external
                          ? 'Saved App observations may be stale. Reads are paused until reconnection.'
                          : 'Sending is paused. Committed responses continue on the gateway.'
                }
                onRetry={
                  feedback === 'auth-required'
                    ? reauthenticate
                    : feedback === 'recovering'
                      ? chat.retry
                      : undefined
                }
              />
            </View>
          )}
          {!!notice && (
            <View style={{ paddingHorizontal: 16 }}>
              <Notice description={notice} />
            </View>
          )}
          {chat.error && (
            <View style={{ paddingHorizontal: 16 }}>
              <Notice description={chat.error} />
            </View>
          )}
          {!!external && (
            <AppSendStatus
              command={chat.appCommand}
              pending={!!chat.appPending}
              resolving={chat.appResolving}
              canResolve={!!external.send}
              offline={chat.state !== 'live'}
              onCheck={() => {
                void chat.refreshApp();
              }}
              onResolve={() => {
                void chat.resolveApp();
              }}
            />
          )}
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >
            <MessageTimeline
              key={id}
              messages={chat.messages}
              historyReady={!!chat.snapshot && chat.state === 'live'}
              streaming={!!chat.run}
              hasOlder={chat.hasOlder && chat.state === 'live'}
              onOlder={() => {
                void chat.loadOlder();
              }}
              editDisabled={
                !!external ||
                chat.state !== 'live' ||
                !chat.snapshot ||
                !chat.loaded ||
                chat.sending
              }
              onEdit={external ? undefined : chat.send}
            />
            <View
              style={{
                paddingBottom: Math.max(insets.bottom, 12) + 6,
                paddingTop: 8,
              }}
            >
              {external?.view === 'coding' && (
                <View style={{ paddingHorizontal: 24, gap: 6 }}>
                  <Text muted>
                    Read-only App window · steps{' '}
                    {(external.windowStart ?? 0) + 1}–{external.windowEnd}.
                    Earlier history and activity details may be omitted.
                  </Text>
                  <Text muted>
                    {external.laterHistory === 'observed_end'
                      ? 'End of this observed response. Complete history is not established.'
                      : external.windowEnd === 2000
                        ? 'Local history limit reached. Continue in the desktop App.'
                        : 'Later activity is not yet observed. This is not a latest-activity view.'}
                  </Text>
                  {external.laterHistory === 'unobserved' &&
                    (external.windowEnd ?? 2000) < 2000 && (
                      <Button
                        label={
                          chat.historyLoading
                            ? 'Loading window…'
                            : 'Next history window'
                        }
                        variant="outline"
                        disabled={
                          chat.historyLoading ||
                          chat.state !== 'live' ||
                          external.observation !== 'fresh'
                        }
                        onPress={() => {
                          void chat.nextAppHistory();
                        }}
                      />
                    )}
                </View>
              )}
              <MessageComposer
                plainText={!!external}
                value={chat.draft}
                onValueChange={chat.setDraft}
                status={
                  chat.sending
                    ? 'submitted'
                    : chat.run
                      ? 'streaming'
                      : chat.error && !external
                        ? 'error'
                        : 'ready'
                }
                disabled={
                  (!!external &&
                    (!external.send ||
                      external.observation !== 'fresh' ||
                      !!chat.appPending)) ||
                  chat.state !== 'live' ||
                  !chat.snapshot ||
                  !chat.loaded
                }
                disabledReason={
                  external
                    ? external.observation === 'gap'
                      ? 'History cannot be safely updated. Continue in the desktop App; check owner status for unsupported steps or a history gap.'
                      : external.observation === 'unavailable'
                        ? 'App connection unavailable. Open the desktop App and check owner setup. Saved history is shown.'
                        : external.view === 'coding'
                          ? 'Coding view is read-only. Continue work in the desktop App.'
                          : !external.send
                            ? 'Read-only · Recent history only. Enable sending from desktop setup.'
                            : 'Experimental · Recent history only; earlier messages may be omitted.'
                    : undefined
                }
                onSubmit={(text) => {
                  void chat.send(text);
                }}
                onStop={() => {
                  if (chat.run) setCancelTarget(chat.run.id);
                }}
                stopping={chat.stopping}
              />
            </View>
          </KeyboardAvoidingView>
        </View>
        <CancelResponseSheet
          open={
            cancelTarget !== null &&
            chat.run?.id === cancelTarget &&
            !chat.stopping
          }
          onClose={() => setCancelTarget(null)}
          onConfirm={() => {
            const target = cancelTarget;
            setCancelTarget(null);
            if (target) void chat.stop(target);
          }}
        />
      </View>
    </DrawerScene>
  );
}
