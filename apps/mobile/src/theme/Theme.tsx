import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  AccessibilityInfo,
  PixelRatio,
  Platform,
  useColorScheme,
} from 'react-native';
import { themes, type Palette } from '@pocket/design-tokens';
const density = PixelRatio.get();
// Round the native 0.4pt target to whole pixels, with at least one pixel.
export const thinBorderWidth =
  Platform.OS === 'web' ? 1 : Math.max(1, Math.round(0.4 * density)) / density;
type Preference = 'system' | 'light' | 'dark';
const ThemeContext = createContext<{
  colors: Palette;
  dark: boolean;
  preference: Preference;
  setPreference: (p: Preference) => void;
  reduced: boolean;
}>({
  colors: themes.light,
  dark: false,
  preference: 'system',
  setPreference: () => {},
  reduced: true,
});
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreference] = useState<Preference>('system');
  const system = useColorScheme();
  const dark = (preference === 'system' ? system : preference) === 'dark';
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduced,
    );
    return () => sub.remove();
  }, []);
  return (
    <ThemeContext.Provider
      value={{
        colors: dark ? themes.dark : themes.light,
        dark,
        preference,
        setPreference,
        reduced,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
export const useTheme = () => useContext(ThemeContext);
