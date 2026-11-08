import React, { useEffect, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { Copy, Check, WrapText, ChevronDown } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { Button, Text } from '../../components/ui/primitives';
import { IconButton } from '../../components/ui/IconButton';
import Animated, {
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Reveal, Blink, easeSize } from '../../components/ui/Motion';
import { CopyGlyph } from './CopyGlyph';
import { useTheme } from '../../theme/Theme';
export function CodeBlock({
  code,
  language,
  streaming = false,
}: {
  code: string;
  language: string;
  streaming?: boolean;
}) {
  const { colors, reduced } = useTheme();
  const [wrap, setWrap] = useState(false);
  const [expanded, setExpanded] = useState(streaming);
  const [copy, setCopy] = useState<'idle' | 'success' | 'error'>('idle');
  const lines = code.replace(/\n$/, '').split('\n');
  const foldable = !streaming && lines.length > 21;
  const folded = foldable && !expanded;
  const chevron = useAnimatedStyle(() => ({
    transform: [
      {
        rotate: withTiming(expanded ? '180deg' : '0deg', {
          duration: reduced ? 0 : 300,
          easing: easeSize,
        }),
      },
    ],
  }));
  useEffect(() => {
    if (copy === 'idle') return;
    const timer = setTimeout(() => setCopy('idle'), 1600);
    return () => clearTimeout(timer);
  }, [copy]);
  const [end, setEnd] = useState({ x: 0, y: 0 });
  const veil = useAnimatedStyle(() => ({
    opacity: withTiming(folded ? 1 : 0, {
      duration: reduced ? 0 : 360,
      easing: easeSize,
    }),
  }));
  const body = (
    <View style={{ padding: 12 }}>
      <Text
        onTextLayout={
          streaming
            ? ({ nativeEvent }) => {
                const line = nativeEvent.lines.at(-1);
                if (!line) return;
                setEnd((old) =>
                  old.x === line.x + line.width && old.y === line.y
                    ? old
                    : { x: line.x + line.width, y: line.y },
                );
              }
            : undefined
        }
        selectable
        style={{
          fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
          fontSize: 13,
          lineHeight: 21,
        }}
      >
        {(folded ? lines.slice(0, 18) : lines).join('\n')}
      </Text>
      {streaming && (
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ position: 'absolute', left: end.x + 12, top: end.y + 15 }}
        >
          <Blink active>
            <View
              style={{
                width: 7,
                height: 15,
                backgroundColor: colors.secondary,
              }}
            />
          </Blink>
        </View>
      )}
    </View>
  );
  return (
    <View
      style={{
        borderRadius: 16,
        overflow: 'hidden',
        backgroundColor: colors.elevated,
      }}
    >
      <View
        style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 14 }}
      >
        <Text muted style={{ flex: 1, fontSize: 12 }}>
          {language || 'Code'}
        </Text>
        <IconButton
          icon={WrapText}
          label="Wrap code lines"
          selected={wrap}
          onPress={() => setWrap(!wrap)}
        />
        <IconButton
          icon={copy === 'success' ? Check : Copy}
          children={<CopyGlyph copied={copy === 'success'} size={20} />}
          disabled={streaming}
          label={copy === 'success' ? 'Code copied' : 'Copy code'}
          onPress={() => {
            void Clipboard.setStringAsync(code)
              .then(() => setCopy('success'))
              .catch(() => setCopy('error'));
          }}
        />
      </View>
      <Reveal open duration={460} easing={easeSize}>
        <View>
          {wrap ? (
            body
          ) : (
            <ScrollView horizontal style={{ flexGrow: 0, flexShrink: 0 }}>
              {body}
            </ScrollView>
          )}
          <Animated.View
            pointerEvents="none"
            style={[
              {
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: 48,
              },
              veil,
            ]}
          >
            <LinearGradient
              colors={[`${colors.elevated}00`, colors.elevated]}
              style={{ flex: 1 }}
            />
          </Animated.View>
        </View>
      </Reveal>
      <Reveal open={copy === 'error'}>
        <Text accessibilityRole="alert">
          Could not copy code. Select the text to copy it.
        </Text>
      </Reveal>
      {foldable && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Animated.View style={chevron}>
            <ChevronDown size={16} color={colors.secondary} />
          </Animated.View>
          <Button
            expanded={expanded}
            variant="ghost"
            label={
              folded ? `Show ${lines.length - 18} more lines` : 'Show less code'
            }
            onPress={() => setExpanded(!expanded)}
          />
        </View>
      )}
    </View>
  );
}
