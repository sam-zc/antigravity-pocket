import React, { useState } from 'react';
import { View } from 'react-native';
import { CircleAlert, Info, WifiOff, ChevronDown } from 'lucide-react-native';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { Reveal, LabelChange, IconLayer, easeOut, easeSize } from './Motion';
import { useTheme } from '../../theme/Theme';
import { Button, Card, Text } from './primitives';
export function Notice({
  kind = 'error',
  title,
  description,
  details,
  onRetry,
  retrying = false,
}: {
  kind?: 'error' | 'offline' | 'info';
  title?: string;
  description: string;
  details?: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const { colors, reduced } = useTheme();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const heading =
    title ??
    (kind === 'offline'
      ? 'Connection interrupted'
      : kind === 'info'
        ? 'Development preview'
        : 'Something went wrong');
  const chevron = useAnimatedStyle(() => ({
    transform: [
      {
        rotate: withTiming(detailsOpen ? '180deg' : '0deg', {
          duration: reduced ? 0 : 300,
          easing: easeOut,
        }),
      },
    ],
  }));
  return (
    <Animated.View
      entering={FadeInDown.duration(reduced ? 0 : 320)
        .easing(easeSize)
        .withInitialValues({
          opacity: 0,
          transform: [{ translateY: reduced ? 0 : 4 }],
        })}
    >
      <Card
        accessibilityRole={kind === 'error' ? 'alert' : undefined}
        accessibilityLiveRegion="polite"
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View accessible={false} style={{ width: 18, height: 18 }}>
            <IconLayer active={kind === 'error'}>
              <CircleAlert size={18} color={colors.error} />
            </IconLayer>
            <IconLayer active={kind === 'offline'}>
              <WifiOff size={18} color={colors.warning} />
            </IconLayer>
            <IconLayer active={kind === 'info'}>
              <Info size={18} color={colors.secondary} />
            </IconLayer>
          </View>
          <View style={{ flex: 1 }}>
            <LabelChange value={heading}>
              <Text style={{ fontWeight: '600' }}>{heading}</Text>
            </LabelChange>
          </View>
        </View>
        <LabelChange value={description}>
          <Text muted>{description}</Text>
        </LabelChange>
        {details && (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Animated.View style={chevron}>
                <ChevronDown size={14} color={colors.secondary} />
              </Animated.View>
              <Button
                label={detailsOpen ? 'Hide details' : 'Show details'}
                variant="ghost"
                expanded={detailsOpen}
                onPress={() => setDetailsOpen(!detailsOpen)}
              />
            </View>
            <Reveal
              open={detailsOpen}
              duration={420}
              fadeIn={320}
              fadeOut={160}
            >
              <Text selectable>{details}</Text>
            </Reveal>
          </>
        )}
        {onRetry && (
          <Button
            label="Retry"
            pendingLabel="Retrying…"
            status={retrying ? 'pending' : 'idle'}
            variant="outline"
            onPress={onRetry}
          />
        )}
      </Card>
    </Animated.View>
  );
}
