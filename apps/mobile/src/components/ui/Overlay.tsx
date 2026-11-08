import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  AccessibilityInfo,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { thinBorderWidth, useTheme } from '../../theme/Theme';

export function Overlay({
  open,
  onClose,
  children,
  label,
  placement = 'center',
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  label: string;
  placement?: 'center' | 'bottom';
}) {
  const { colors, reduced } = useTheme();
  const insets = useSafeAreaInsets();
  const sheet = placement === 'bottom';
  const [panelHeight, setPanelHeight] = useState(0);
  const [mounted, setMounted] = useState(open);
  const progress = useRef(new Animated.Value(0)).current;
  const scrim = useRef(new Animated.Value(0)).current;
  const panelOpacity = useRef(new Animated.Value(0)).current;
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    if (open) setMounted(true);
    if (sheet && open && !panelHeight) return;
    const easing = Easing.bezier(0.16, 1, 0.3, 1);
    const motion = Animated.parallel([
      Animated.timing(scrim, {
        toValue: open ? 1 : 0,
        duration: reduced ? 160 : sheet ? 330 : open ? 260 : 200,
        easing,
        useNativeDriver: true,
      }),
      Animated.timing(panelOpacity, {
        toValue: open ? 1 : 0,
        duration: reduced ? 160 : sheet ? (open ? 80 : 330) : open ? 240 : 180,
        easing,
        useNativeDriver: true,
      }),
      Animated.timing(progress, {
        toValue: open ? 1 : 0,
        duration: reduced ? 160 : sheet ? 330 : open ? 420 : 220,
        easing,
        useNativeDriver: true,
      }),
    ]);
    motion.start(({ finished }) => {
      if (finished && !latest.current) setMounted(false);
    });
    return () => motion.stop();
  }, [open, progress, scrim, panelOpacity, reduced, sheet, panelHeight]);
  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      onRequestClose={onClose}
      onShow={() => AccessibilityInfo.announceForAccessibility(label)}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <View
        style={s.fill}
        accessibilityViewIsModal
        accessibilityLabel={label}
        pointerEvents={open ? 'auto' : 'none'}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      >
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: sheet ? colors.modalScrim : colors.overlay,
              opacity: scrim,
            },
          ]}
        >
          <Pressable
            style={s.fill}
            accessibilityLabel="Dismiss overlay"
            accessibilityRole="button"
            onPress={onClose}
          />
        </Animated.View>
        <KeyboardAvoidingView
          pointerEvents="box-none"
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={[
            s.fill,
            sheet
              ? {
                  justifyContent: 'flex-end',
                  paddingHorizontal: Math.max(insets.left, insets.right, 8),
                  paddingBottom: Math.max(insets.bottom, 8),
                  paddingTop: insets.top + 16,
                }
              : s.center,
          ]}
        >
          <Animated.View
            onLayout={({ nativeEvent }) =>
              setPanelHeight(nativeEvent.layout.height)
            }
            style={[
              s.dialog,
              sheet && s.sheet,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
                opacity: panelOpacity,
                transform: reduced
                  ? []
                  : [
                      {
                        translateY: progress.interpolate({
                          inputRange: [0, 1],
                          outputRange: [
                            sheet
                              ? panelHeight + Math.max(insets.bottom, 8) + 16
                              : 8,
                            0,
                          ],
                        }),
                      },
                      {
                        scale: progress.interpolate({
                          inputRange: [0, 1],
                          outputRange: [sheet ? 1 : 0.96, 1],
                        }),
                      },
                    ],
              },
            ]}
          >
            {children}
          </Animated.View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
const s = StyleSheet.create({
  fill: { flex: 1 },
  center: { justifyContent: 'center', padding: 20 },
  sheet: {
    borderRadius: 40,
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 16,
    maxHeight: '95%',
    width: '100%',
    maxWidth: 600,
    alignSelf: 'center',
  },
  dialog: {
    borderRadius: 28,
    padding: 24,
    gap: 18,
    maxHeight: '85%',
    borderWidth: thinBorderWidth,
    boxShadow: '0 16px 60px rgba(0,0,0,0.12)',
  },
});
