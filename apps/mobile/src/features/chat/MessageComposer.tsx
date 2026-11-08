import React, { useRef, useState } from 'react';
import { TextInput, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import {
  easeOut,
  IconLayer,
  Reveal,
  Spinner,
} from '../../components/ui/Motion';
import { ArrowUp, Plus, Square, AtSign } from 'lucide-react-native';
import { utf8Bytes } from '@pocket/protocol';
import { Text, Dialog, Button } from '../../components/ui/primitives';
import { IconButton } from '../../components/ui/IconButton';
import { useTheme } from '../../theme/Theme';
import { mentionAt, type MentionItem } from './mentions';
import { MentionMenu } from './MentionMenu';
export type ComposerStatus = 'ready' | 'submitted' | 'streaming' | 'error';
export function MessageComposer({
  value,
  onValueChange,
  onSubmit,
  onStop,
  status = 'ready',
  disabled = false,
  disabledReason,
  stopping = false,
  plainText = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onStop: () => void;
  status?: ComposerStatus;
  disabled?: boolean;
  disabledReason?: string;
  stopping?: boolean;
  plainText?: boolean;
}) {
  const { colors, reduced } = useTheme();
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  const [cursor, setCursor] = useState(value.length);
  const [height, setHeight] = useState(48);
  const [selection, setSelection] = useState<{ start: number; end: number }>();
  const [dismissed, setDismissed] = useState(false);
  const [options, setOptions] = useState(false);
  const busy = status === 'submitted' || status === 'streaming';
  const canSend =
    !disabled && !busy && !!value.trim() && utf8Bytes(value) <= 65536;
  const waiting = status === 'submitted' || stopping;
  const fieldSize = useAnimatedStyle(() => ({
    height: withTiming(height, {
      duration: reduced ? 0 : 380,
      easing: easeOut,
    }),
  }));
  const mention =
    !plainText && !busy && !dismissed ? mentionAt(value, cursor) : null;
  const insertMention = (item: MentionItem) => {
    if (!mention) return;
    const prefix = value.slice(0, mention.start) + '@' + item.label + ' ';
    onValueChange(prefix + value.slice(mention.end));
    setCursor(prefix.length);
    setSelection({ start: prefix.length, end: prefix.length });
    setDismissed(true);
    input.current?.focus();
  };
  const openMentions = () => {
    const prefix = value + (value && !/\s$/.test(value) ? ' ' : '') + '@';
    onValueChange(prefix);
    setCursor(prefix.length);
    setSelection({ start: prefix.length, end: prefix.length });
    setDismissed(false);
    setOptions(false);
    input.current?.focus();
  };
  return (
    <View>
      <MentionMenu
        open={!!mention}
        query={mention?.query ?? ''}
        onSelect={insertMention}
        onClose={() => setDismissed(true)}
      />
      <Reveal open={!!disabledReason} duration={380}>
        <Text muted style={s.hint}>
          {disabledReason}
        </Text>
      </Reveal>
      <View style={[s.pill, { backgroundColor: colors.surface }]}>
        {!plainText && (
          <IconButton
            icon={Plus}
            label="Composer options"
            disabled={busy}
            onPress={() => setOptions(true)}
          />
        )}
        <Animated.View style={[{ flex: 1, overflow: 'hidden' }, fieldSize]}>
          <TextInput
            ref={input}
            accessibilityLabel="Message"
            placeholder={busy ? 'What’s next?' : 'Ask Pocket'}
            placeholderTextColor={colors.secondary}
            value={value}
            multiline
            editable={!busy}
            selection={selection}
            textAlignVertical="center"
            onChangeText={(text) => {
              setDismissed(false);
              setSelection(undefined);
              onValueChange(text);
            }}
            onSelectionChange={({ nativeEvent }) => {
              setCursor(nativeEvent.selection.end);
              setSelection(undefined);
            }}
            onContentSizeChange={({ nativeEvent }) =>
              setHeight(
                Math.max(48, Math.min(160, nativeEvent.contentSize.height)),
              )
            }
            style={[s.input, { color: colors.text, height }]}
          />
        </Animated.View>
        {!plainText && !busy && !value && (
          <IconButton
            icon={AtSign}
            label="Add mention"
            onPress={openMentions}
            size={19}
          />
        )}
        <IconButton
          icon={ArrowUp}
          busy={waiting}
          label={
            waiting
              ? stopping
                ? 'Stopping…'
                : 'Sending…'
              : status === 'streaming'
                ? 'Stop'
                : status === 'error'
                  ? 'Retry send'
                  : 'Send'
          }
          filled={!busy}
          neutral={busy}
          disabled={waiting || (status === 'streaming' ? disabled : !canSend)}
          onPress={() => {
            if (status === 'streaming' && !waiting) onStop();
            else if (canSend && !waiting) onSubmit(value);
          }}
        >
          <View style={{ width: 20, height: 20 }}>
            <IconLayer active={!waiting && status !== 'streaming'}>
              <ArrowUp size={20} color={colors.onAccent} />
            </IconLayer>
            <IconLayer active={!waiting && status === 'streaming'}>
              <Square size={16} color={colors.text} strokeWidth={1.8} />
            </IconLayer>
            <IconLayer active={waiting}>
              <Spinner active={waiting} color={colors.onAccent} size={18} />
            </IconLayer>
          </View>
        </IconButton>
      </View>
      <Reveal open={utf8Bytes(value) > 65536} duration={380}>
        <Text accessibilityRole="alert" style={s.hint}>
          Message exceeds 64 KiB.
        </Text>
      </Reveal>
      <Dialog
        open={options}
        onClose={() => setOptions(false)}
        title="Add to your prompt"
      >
        <View style={{ gap: 16 }}>
          <Button
            label="Mention Mock context"
            variant="ghost"
            onPress={openMentions}
          />
          <Text muted>
            Context mentions stay inside this synthetic conversation. Files and
            account connectors are not available in this preview.
          </Text>
        </View>
      </Dialog>
    </View>
  );
}
const s = StyleSheet.create({
  pill: {
    marginHorizontal: 16,
    borderRadius: 34,
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 8,
    gap: 0,
    boxShadow: '0 4px 24px rgba(30,45,70,0.07)',
  },
  input: {
    flex: 1,
    fontSize: 16,
    lineHeight: 23,
    paddingVertical: 12,
    paddingHorizontal: 4,
    minHeight: 48,
  },
  hint: { paddingHorizontal: 28, paddingVertical: 8, fontSize: 12 },
  wait: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
