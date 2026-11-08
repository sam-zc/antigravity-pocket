import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import { utf8Bytes } from '@pocket/protocol';
import { Button, Text } from '../../components/ui/primitives';
import { useTheme } from '../../theme/Theme';

export function MessageEdit({
  text,
  disabled,
  onCancel,
  onAccept,
  embedded = false,
  active = true,
}: {
  active?: boolean;
  embedded?: boolean;
  text: string;
  disabled: boolean;
  onCancel: () => void;
  onAccept: (draft: string) => Promise<boolean>;
}) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState(text);
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  useEffect(() => {
    setDraft(text);
    setError('');
    if (active) {
      input.current?.focus();
    } else {
      input.current?.blur();
    }
  }, [active, text]);
  const { fontScale } = useWindowDimensions();
  const lineHeight = 22 * fontScale;
  const [height, setHeight] = useState(lineHeight);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const tooLong = utf8Bytes(draft) > 65536;
  const unchanged = !draft.trim() || draft.trim() === text.trim();
  async function send() {
    if (!active || disabled || unchanged || tooLong || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    try {
      if (!(await onAccept(draft.trim())))
        setError('Could not send. Your edit is retained. Try again.');
    } catch {
      setError('Could not send. Your edit is retained. Try again.');
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }
  return (
    <View
      style={[
        s.editor,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
        },
        embedded && s.embedded,
      ]}
    >
      <TextInput
        ref={input}
        accessibilityLabel="Edited message"
        accessibilityHint="Send submits the edited text as a new prompt."
        value={draft}
        onChangeText={setDraft}
        multiline
        editable={active && !disabled && !submitting}
        onKeyPress={({ nativeEvent }) => {
          if (nativeEvent.key === 'Escape' && !inFlight.current) onCancel();
        }}
        onContentSizeChange={({ nativeEvent }) =>
          setHeight(
            Math.min(240, Math.max(lineHeight, nativeEvent.contentSize.height)),
          )
        }
        style={[
          s.field,
          { color: colors.text, height: Math.max(lineHeight, height) },
        ]}
      />
      {tooLong && (
        <Text accessibilityRole="alert">Message exceeds 64 KiB.</Text>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={s.error}>
          {error}
        </Text>
      )}
      <View style={s.actions}>
        <Button
          size="compact"
          label="Cancel"
          accessibilityLabel="Cancel edit"
          variant="ghost"
          disabled={submitting}
          onPress={onCancel}
        />
        <Button
          size="compact"
          label="Send"
          accessibilityLabel="Send edited message"
          status={submitting ? 'pending' : 'idle'}
          pendingLabel="Sending…"
          disabled={disabled || unchanged || tooLong}
          onPress={() => {
            void send();
          }}
        />
      </View>
    </View>
  );
}
const s = StyleSheet.create({
  editor: {
    width: '100%',
    borderRadius: 20,
    borderWidth: 1,
    padding: 12,
    gap: 8,
  },
  embedded: { borderWidth: 0, backgroundColor: 'transparent' },
  field: {
    fontSize: 14,
    lineHeight: 22,
    textAlignVertical: 'top',
    paddingVertical: 0,
    paddingHorizontal: 4,
    includeFontPadding: false,
  },
  error: { fontSize: 12, lineHeight: 18 },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    gap: 4,
  },
});
