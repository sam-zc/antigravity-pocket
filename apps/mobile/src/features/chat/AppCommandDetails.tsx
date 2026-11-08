import React, { useState } from 'react';
import { View } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import type { AppActivityDetail } from '@pocket/protocol';
import { Button, Text } from '../../components/ui/primitives';
import { Reveal, easeSize } from '../../components/ui/Motion';
import { useTheme } from '../../theme/Theme';
import { CodeBlock } from './CodeBlock';
export function AppCommandDetails({
  detail,
  ordinal,
  onDisclosure,
  open: openProp,
  onOpenChange,
}: {
  detail: AppActivityDetail;
  ordinal: number;
  onDisclosure?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [userOpen, setUserOpen] = useState(false);
  const open = openProp ?? userOpen;
  const { colors, reduced } = useTheme();
  const chevron = useAnimatedStyle(() => ({
    transform: [
      {
        rotate: withTiming(open ? '90deg' : '0deg', {
          duration: reduced ? 0 : 300,
          easing: easeSize,
        }),
      },
    ],
  }));
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Animated.View style={chevron} accessible={false}>
          <ChevronRight size={16} color={colors.secondary} />
        </Animated.View>
        <Button
          label={open ? 'Hide command details' : 'Show command details'}
          accessibilityLabel={`${open ? 'Hide' : 'Show'} command details for step ${ordinal}`}
          variant="ghost"
          expanded={open}
          onPress={() => {
            onDisclosure?.();
            setUserOpen(!open);
            onOpenChange?.(!open);
          }}
        />
      </View>
      <Reveal open={open} duration={420} fadeIn={300} fadeOut={160}>
        <View style={{ gap: 8 }}>
          <Text muted>
            {detail.exitCode === undefined
              ? 'Exit result not observed'
              : `App recorded exit code ${detail.exitCode}`}
          </Text>
          {detail.command !== undefined && (
            <CodeBlock code={detail.command} language="Command text" />
          )}
          {detail.output !== undefined ? (
            <CodeBlock
              code={detail.output || '(Empty observed output)'}
              language="Observed output"
            />
          ) : (
            <Text muted>Output not available in this observation.</Text>
          )}
          {detail.clipped && (
            <Text muted>Content clipped to the local display limit.</Text>
          )}
          <Text muted>
            Read-only App record. This does not establish turn completion.
          </Text>
        </View>
      </Reveal>
    </View>
  );
}
