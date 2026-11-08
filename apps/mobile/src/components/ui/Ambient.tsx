import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Defs,
  LinearGradient as SvgGradient,
  Stop,
  Path,
} from 'react-native-svg';
import { useTheme } from '../../theme/Theme';

export function Spark({ size = 32 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" accessible={false}>
      <Defs>
        <SvgGradient id="spark" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#86B9FF" />
          <Stop offset="0.6" stopColor="#4785F5" />
          <Stop offset="1" stopColor="#A98FF1" />
        </SvgGradient>
      </Defs>
      <Path
        d="M16 1C18.2 10.4 21.6 13.8 31 16C21.6 18.2 18.2 21.6 16 31C13.8 21.6 10.4 18.2 1 16C10.4 13.8 13.8 10.4 16 1Z"
        fill="url(#spark)"
      />
    </Svg>
  );
}
/** The welcome screen keeps its own decorative treatment; chat is flat. */
export function WelcomeBackdrop() {
  const { dark, colors } = useTheme();
  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <LinearGradient
        colors={
          dark
            ? [`${colors.background}00`, '#142333', '#213A54']
            : [`${colors.background}00`, '#EAF5FF', '#B8DDFA']
        }
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={s.welcome}
      />
    </View>
  );
}
const s = StyleSheet.create({
  welcome: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '70%',
  },
});
