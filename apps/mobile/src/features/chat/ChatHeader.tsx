import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Menu, SquarePen } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { Spinner } from '../../components/ui/Motion';
import { IconButton } from '../../components/ui/IconButton';
import { Text } from '../../components/ui/primitives';
import { thinBorderWidth, useTheme } from '../../theme/Theme';
export function ChatHeader({
  onHistory,
  status,
  home = false,
  loading = false,
  external = false,
}: {
  onHistory: () => void;
  status?: string;
  home?: boolean;
  loading?: boolean;
  external?: boolean;
}) {
  const { colors } = useTheme();
  const router = useRouter();
  return (
    <View style={s.header}>
      <IconButton
        icon={Menu}
        label={home ? 'Open sessions' : 'Back to sessions'}
        onPress={onHistory}
        style={{
          borderWidth: thinBorderWidth,
          borderColor: colors.border,
          backgroundColor: colors.surface,
        }}
      />
      <View style={s.model}>
        <View style={s.line}>
          <Text style={s.name}>
            {external ? 'Antigravity' : 'Mock'}{' '}
            <Text muted style={s.name}>
              {external ? 'Experimental' : 'Local'}
            </Text>
          </Text>
        </View>
        {status && (
          <View
            accessible
            accessibilityLabel={status}
            accessibilityState={{ busy: loading }}
            style={s.line}
          >
            {loading ? (
              <Spinner active color={colors.secondary} size={10} />
            ) : (
              <View
                style={[
                  s.dot,
                  {
                    backgroundColor: status.startsWith('live')
                      ? colors.success
                      : colors.warning,
                  },
                ]}
              />
            )}
            <Text muted numberOfLines={1} style={s.caption}>
              {status.split(' · ')[1]}
            </Text>
          </View>
        )}
      </View>
      <View
        style={[
          s.actions,
          { borderColor: colors.border, backgroundColor: colors.surface },
        ]}
      >
        <IconButton
          icon={SquarePen}
          label={external ? 'New Mock chat' : 'New chat'}
          onPress={() => router.replace('/')}
        />
      </View>
    </View>
  );
}
const s = StyleSheet.create({
  header: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  model: { flex: 1, minHeight: 48, justifyContent: 'center', gap: 1 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  name: { fontSize: 14, lineHeight: 20 },
  caption: { fontSize: 10, lineHeight: 14 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  actions: {
    flexDirection: 'row',
    borderRadius: 28,
    borderWidth: thinBorderWidth,
  },
});
