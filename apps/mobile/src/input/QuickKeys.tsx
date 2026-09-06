import type { NamedKey } from "@shellbell/protocol";
import { Pressable, ScrollView, Text } from "react-native";
import { tokens } from "../theme/tokens";
import { QUICK_KEYS } from "./keys";

export function QuickKeys({
  onKey,
  onPaste,
}: {
  onKey: (key: NamedKey) => void;
  onPaste: () => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
    >
      {QUICK_KEYS.map((k) => (
        <Pressable
          key={k.key}
          accessibilityLabel={k.label}
          onPress={() => onKey(k.key)}
          style={{
            minWidth: 36,
            height: 32,
            paddingHorizontal: 10,
            borderRadius: tokens.radius.sm,
            borderWidth: 1,
            borderColor: tokens.border,
            backgroundColor: tokens.surface2,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: tokens.text, fontSize: 13 }}>{k.label}</Text>
        </Pressable>
      ))}
      <Pressable
        accessibilityLabel="Paste"
        onPress={onPaste}
        style={{
          minWidth: 36,
          height: 32,
          paddingHorizontal: 10,
          borderRadius: tokens.radius.sm,
          borderWidth: 1,
          borderColor: tokens.border,
          backgroundColor: tokens.surface2,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.text, fontSize: 13 }}>Paste</Text>
      </Pressable>
    </ScrollView>
  );
}
