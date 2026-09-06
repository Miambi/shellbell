import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import type { PropsWithChildren } from "react";
import { Platform, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { tokens } from "../theme/tokens";

const glass = Platform.OS === "ios" && isGlassEffectAPIAvailable();

/**
 * Review I4: this is the bottom-most bar on the session screen (it hosts the input field), so it
 * must clear the iPhone home indicator / Android gesture area itself -- nothing renders below it.
 */
export function Bar({ children, style }: PropsWithChildren<{ style?: ViewStyle }>) {
  const insets = useSafeAreaInsets();
  const paddingBottom = 8 + insets.bottom;
  if (glass) {
    return (
      <GlassView
        glassEffectStyle="regular"
        style={[{ paddingHorizontal: 12, paddingTop: 8, paddingBottom }, style]}
      >
        {children}
      </GlassView>
    );
  }
  return (
    <View
      style={[
        {
          backgroundColor: "rgba(11,11,13,0.92)",
          borderColor: tokens.border,
          borderWidth: 1,
          paddingHorizontal: 12,
          paddingTop: 8,
          paddingBottom,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
