import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import type { PropsWithChildren } from "react";
import { Platform, View, type ViewStyle } from "react-native";
import { tokens } from "../theme/tokens";

const glass = Platform.OS === "ios" && isGlassEffectAPIAvailable();

export function Bar({ children, style }: PropsWithChildren<{ style?: ViewStyle }>) {
  if (glass) {
    return (
      <GlassView
        glassEffectStyle="regular"
        style={[{ paddingHorizontal: 12, paddingVertical: 8 }, style]}
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
          paddingVertical: 8,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
