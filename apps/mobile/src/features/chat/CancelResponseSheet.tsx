import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Overlay } from '../../components/ui/Overlay';
import { Button, Text } from '../../components/ui/primitives';
import { useTheme } from '../../theme/Theme';

export function CancelResponseSheet({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Overlay
      open={open}
      onClose={onClose}
      label="Cancel response generation?"
      placement="bottom"
    >
      <View
        accessible={false}
        style={[s.handle, { backgroundColor: colors.border }]}
      />
      <ScrollView bounces={false} contentContainerStyle={s.content}>
        <Text accessibilityRole="header" style={s.title}>
          Cancel response generation?
        </Text>
        <Text muted style={s.description}>
          To ask a new question, you can wait until the response is cancelled or
          start a new chat.
        </Text>
        <View style={s.actions}>
          <Button label="Yes, cancel" variant="danger" onPress={onConfirm} />
          <Button label="No" variant="ghost" onPress={onClose} />
        </View>
      </ScrollView>
    </Overlay>
  );
}
const s = StyleSheet.create({
  handle: { width: 32, height: 4, borderRadius: 2, alignSelf: 'center' },
  content: { gap: 20, paddingTop: 8, paddingBottom: 4 },
  title: {
    textAlign: 'center',
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '500',
  },
  description: { textAlign: 'center', fontSize: 14, lineHeight: 21 },
  actions: { gap: 6, paddingTop: 8 },
});
