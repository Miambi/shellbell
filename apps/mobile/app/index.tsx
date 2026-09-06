import { FlashList } from "@shopify/flash-list";
import { Link, useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { useComputersStore } from "../src/store/computers";
import { useConnectionsStore } from "../src/store/connections";
import { tokens } from "../src/theme/tokens";
import { Card } from "../src/ui/Card";
import { EmptyState } from "../src/ui/EmptyState";
import { Pill } from "../src/ui/Pill";

const STATUS_TEXT: Record<string, string> = {
  idle: "idle",
  connecting: "connecting…",
  auth: "connecting…",
  handshake: "connecting…",
  online: "online",
  offline: "reconnecting…",
  error: "needs attention",
};

const ERROR_TEXT: Record<string, string> = {
  unpaired: "unpaired",
  "re-pair": "re-pair needed",
  superseded: "open on another device",
  rejected: "rejected by relay",
  relay: "relay error",
};

export default function Computers() {
  const computers = useComputersStore((s) => s.computers);
  const conns = useConnectionsStore((s) => s.byComputer);
  const router = useRouter();
  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      {computers.length === 0 ? (
        <EmptyState
          text="No computers yet."
          action={{ label: "Pair one", onPress: () => router.push("/pair") }}
        />
      ) : (
        <FlashList
          data={computers}
          keyExtractor={(c) => c.fp}
          contentContainerStyle={{ padding: 12 }}
          renderItem={({ item }) => {
            const c = conns[item.fp];
            const accentKey = item.accent as keyof typeof tokens.accents;
            const accent = tokens.accents[accentKey] ?? tokens.accents.emerald;
            const offline = c?.status === "offline" && !c.agentOnline;
            const label = c?.error
              ? (ERROR_TEXT[c.error] ?? "needs attention")
              : offline
                ? "computer offline"
                : (STATUS_TEXT[c?.status ?? "idle"] ?? "idle");
            return (
              <Pressable onPress={() => router.push(`/c/${item.fp}`)}>
                <Card accent={accent}>
                  <Text style={{ color: tokens.text, fontSize: 17, fontWeight: "600" }}>
                    {item.name}
                  </Text>
                  <View
                    style={{
                      flexDirection: "row",
                      gap: 8,
                      marginTop: 6,
                      alignItems: "center",
                    }}
                  >
                    <Pill color={c?.status === "online" ? accent : tokens.textFaint} text={label} />
                    <Text style={{ color: tokens.textMuted }}>
                      {c?.sessions.length ?? 0} sessions
                    </Text>
                  </View>
                </Card>
              </Pressable>
            );
          }}
        />
      )}
      <Link href="/pair" asChild>
        <Pressable
          style={{
            position: "absolute",
            right: 20,
            bottom: 32,
            width: 56,
            height: 56,
            borderRadius: 28,
            backgroundColor: tokens.accents.emerald,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: "#000", fontSize: 28, lineHeight: 30 }}>+</Text>
        </Pressable>
      </Link>
      <Link
        href="/settings"
        style={{ position: "absolute", left: 20, bottom: 44, color: tokens.textMuted }}
      >
        Settings
      </Link>
    </View>
  );
}
