import React, { memo, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, AccessibilityInfo } from 'react-native';
import Motion, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { Copy, Check, Pencil } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import type { Message } from '@pocket/protocol';
import { Text } from '../../components/ui/primitives';
import { GenerationActivity } from './GenerationActivity';
import { CopyGlyph } from './CopyGlyph';
import { EditSurface } from './EditSurface';
import { MessageEdit } from './MessageEdit';
import { IconButton } from '../../components/ui/IconButton';
import { useTheme } from '../../theme/Theme';
import { StreamingParagraph } from './StreamingParagraph';
import { CodeBlock } from './CodeBlock';
import { messageContent } from './message-content';

export const MessageBubble = memo(function MessageBubble({
  message,
  busy,
  onEdit,
  onEditingChange,
  onDisclosure,
}: {
  message: Message;
  busy: boolean;
  onEdit?: (text: string) => Promise<boolean>;
  onEditingChange?: (editing: boolean) => void;
  onDisclosure?: () => void;
}) {
  const { reduced } = useTheme();
  const [editing, setEditing] = useState(false);
  const actionStyle = useAnimatedStyle(() => ({
    opacity: withTiming(editing ? 0 : 1, { duration: reduced ? 0 : 200 }),
  }));
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const editState = useRef({ editing, onEditingChange });
  editState.current = { editing, onEditingChange };
  useEffect(
    () => () => {
      // FlatList may unmount an offscreen editor; release the timeline's edit lock.
      if (editState.current.editing) editState.current.onEditingChange?.(false);
    },
    [],
  );
  const user = message.role === 'user';
  const streaming = message.status === 'streaming';
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try {
      await Clipboard.setStringAsync(message.text);
      setCopied(true);
      AccessibilityInfo.announceForAccessibility('Copied');
    } catch {
      setError('Could not copy this message. Select the text to copy it.');
    }
  }
  const finishEditing = () => {
    setEditing(false);
    onEditingChange?.(false);
  };
  const blocks = messageContent(message.text);
  return (
    <View style={[s.message, user && s.user]}>
      {user ? (
        <EditSurface
          editing={editing}
          text={message.text}
          onDisclosure={onDisclosure}
        >
          <MessageEdit
            active={editing}
            embedded
            text={message.text}
            disabled={busy}
            onCancel={finishEditing}
            onAccept={async (draft) => {
              if (!onEdit || !(await onEdit(draft))) return false;
              finishEditing();
              void Haptics.selectionAsync().catch(() => {
                /* Optional device feedback. */
              });
              return true;
            }}
          />
        </EditSurface>
      ) : (
        <View style={s.response}>
          {streaming && (
            <Motion.View
              entering={FadeIn.duration(reduced ? 0 : 250)}
              exiting={FadeOut.duration(reduced ? 0 : 180)}
            >
              <GenerationActivity receiving={!!message.text} />
            </Motion.View>
          )}
          <View style={{ gap: 16 }}>
            {message.text
              ? blocks.map((block, index) =>
                  block.kind === 'code' ? (
                    <CodeBlock
                      key={index}
                      code={block.text}
                      language={block.language}
                      streaming={streaming && !block.closed}
                    />
                  ) : (
                    <View key={index} style={{ gap: 16 }}>
                      {block.text
                        .trim()
                        .split(/\n{2,}/)
                        .map((paragraph, part) => (
                          <StreamingParagraph
                            key={part}
                            text={paragraph}
                            streaming={
                              streaming &&
                              index === blocks.length - 1 &&
                              part ===
                                block.text.trim().split(/\n{2,}/).length - 1
                            }
                          />
                        ))}
                    </View>
                  ),
                )
              : null}
          </View>
          {message.status === 'cancelled' && (
            <Motion.View entering={FadeIn.duration(reduced ? 0 : 300)}>
              <Text muted style={s.caption}>
                Stopped
              </Text>
            </Motion.View>
          )}
          {message.status === 'failed' && (
            <Motion.View entering={FadeIn.duration(reduced ? 0 : 300)}>
              <Text muted style={s.caption}>
                The answer was interrupted.
              </Text>
            </Motion.View>
          )}
        </View>
      )}
      {!streaming && !!message.text && (
        <Motion.View
          entering={FadeIn.duration(reduced ? 0 : 300)}
          style={[s.actions, actionStyle]}
          pointerEvents={editing ? 'none' : 'auto'}
          accessibilityElementsHidden={editing}
          importantForAccessibility={editing ? 'no-hide-descendants' : 'auto'}
        >
          <IconButton
            icon={copied ? Check : Copy}
            children={<CopyGlyph copied={copied} size={user ? 14 : 17} />}
            size={user ? 14 : 17}
            muted={user}
            label={copied ? 'Copied' : user ? 'Copy message' : 'Copy answer'}
            onPress={() => {
              void copy();
            }}
          />
          {user && onEdit && (
            <IconButton
              icon={Pencil}
              size={14}
              muted
              label="Edit message"
              disabled={busy}
              onPress={() => {
                setEditing(true);
                onEditingChange?.(true);
              }}
            />
          )}
        </Motion.View>
      )}
      {error && (
        <Text accessibilityRole="alert" muted>
          {error}
        </Text>
      )}
    </View>
  );
});
const s = StyleSheet.create({
  message: { paddingVertical: 8, gap: 4 },
  user: { alignItems: 'flex-end' },
  response: { gap: 18, paddingTop: 6 },
  answer: { fontSize: 16, lineHeight: 26 },
  caption: { fontSize: 12, lineHeight: 18 },
  actions: { flexDirection: 'row', alignItems: 'center', marginHorizontal: -8 },
});
