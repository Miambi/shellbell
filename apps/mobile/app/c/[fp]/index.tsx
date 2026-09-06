import { FlashList } from "@shopify/flash-list";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import Animated, { Easing, LinearTransition } from "react-native-reanimated";
import { connectionManager } from "../../../src/net/manager";
import { useComputersStore } from "../../../src/store/computers";
import { useConnectionsStore } from "../../../src/store/connections";
import { tokens } from "../../../src/theme/tokens";
import { EmptyState } from "../../../src/ui/EmptyState";
import { Pill } from "../../../src/ui/Pill";
import { StatusOverlay } from "../../../src/ui/StatusOverlay";
import { asBackendName, backendLabel, newSessionLabel } from "../../../src/util/backends";
import { sidToRoute } from "../../../src/util/routes";
import { statePill } from "../../../src/util/session-state";

const ERROR_COPY: Record<string, { text: string; action: string }> = {
  unpaired: { text: "This phone was unpaired on the computer.", action: "Re-pair" },
  "re-pair": { text: "This computer's keys are out of sync.", action: "Re-pair" },
  superseded: { text: "This computer is open in another Shellbell session.", action: "Retry" },
  rejected: { text: "The relay rejected this phone's identity.", action: "Re-pair" },
  relay: { text: "The relay refused the connection.", action: "Retry" },
};

/** spec 10.9: 150 ms ease-out layout transition when a row is added or removed. */
const ROW_TRANSITION = LinearTransition.duration(150).easing(Easing.out(Easing.ease));

export default function Sessions() {
  const { fp } = useLocalSearchParams<{ fp: string }>();
  const router = useRouter();
  const computer = useComputersStore((s) => s.computers.find((c) => c.fp === fp));
  const conn = useConnectionsStore((s) => s.byComputer[fp ?? ""]);
  const accentKey = (computer?.accent ?? "emerald") as keyof typeof tokens.accents;
  const accent = tokens.accents[accentKey] ?? tokens.accents.emerald;

  const rows = useMemo(() => {
    const list = conn?.sessions ?? [];
    type Row =
      | { kind: "header"; key: string; text: string }
      | { kind: "session"; key: string; s: (typeof list)[number] };
    const out: Row[] = [];
    let lastGroup = "";
    for (const s of list) {
      const group = `${s.backend}:${s.windowId}`;
      if (group !== lastGroup) {
        out.push({
          kind: "header",
          key: `h:${group}`,
          text: `${backendLabel(s.backend)} · window ${s.windowNumber}`,
        });
        lastGroup = group;
      }
      out.push({ kind: "session", key: s.id, s });
    }
    return out;
  }, [conn?.sessions]);

  const newSession = () => {
    const creatable = (conn?.hello?.backends ?? [])
      .filter((b) => b.capabilities.createSession)
      .map((b) => asBackendName(b.name))
      .filter((n): n is NonNullable<typeof n> => n !== null);
    if (creatable.length === 0) return;
    const go = (backend: (typeof creatable)[number]) => {
      const c = connectionManager.get(fp ?? "");
      if (!c) return;
      void c
        .request({ type: "session.create", reqId: c.newReqId(), in: { kind: "tab", backend } })
        .then((ack) => {
          if (ack.sessionId) router.push(`/c/${fp}/s/${sidToRoute(ack.sessionId)}`);
        })
        .catch(() => undefined);
    };
    if (creatable.length === 1) {
      const only = creatable[0];
      if (only) go(only);
      return;
    }
    Alert.alert("New session", undefined, [
      ...creatable.map((b) => ({ text: newSessionLabel(b), onPress: () => go(b) })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  };

  const errored = conn?.status === "error" && conn.error;
  if (errored) {
    const copy = ERROR_COPY[conn.error ?? "relay"] ?? ERROR_COPY.relay;
    return (
      <EmptyState
        text={copy?.text ?? "The connection failed."}
        action={{ label: copy?.action ?? "Retry", onPress: () => router.push("/pair") }}
      />
    );
  }
  if (rows.length === 0 && conn?.status === "online") {
    return (
      <EmptyState
        text="No terminal sessions — open iTerm2 or start tmux on the Mac."
        action={{ label: "New session", onPress: newSession }}
      />
    );
  }
  if (rows.length === 0) return <EmptyState text="Connecting…" />;

  const dimmed = conn?.status !== "online";
  const overlay = !conn?.agentOnline
    ? `${computer?.name ?? "Computer"} is offline`
    : "Reconnecting…";

  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <FlashList
        data={rows}
        keyExtractor={(r) => r.key}
        getItemType={(r) => r.kind}
        contentContainerStyle={{ padding: 12 }}
        renderItem={({ item }) => {
          if (item.kind === "header") {
            return (
              <Animated.View layout={ROW_TRANSITION}>
                <Text
                  style={{
                    color: tokens.textMuted,
                    fontSize: 12,
                    letterSpacing: 1,
                    marginTop: 12,
                    marginBottom: 6,
                  }}
                >
                  {item.text.toUpperCase()}
                </Text>
              </Animated.View>
            );
          }
          const pill = statePill(item.s.state);
          return (
            <Animated.View layout={ROW_TRANSITION}>
              <Pressable
                onPress={() => router.push(`/c/${fp}/s/${sidToRoute(item.s.id)}`)}
                style={{
                  paddingVertical: 10,
                  borderBottomColor: tokens.border,
                  borderBottomWidth: 1,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: item.s.isFocusedOnMac ? accent : tokens.textFaint,
                  }}
                />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: tokens.text, fontSize: 15 }} numberOfLines={1}>
                    {item.s.title}
                  </Text>
                  {item.s.cwd ? (
                    <Text style={{ color: tokens.textMuted, fontSize: 12 }} numberOfLines={1}>
                      {item.s.cwd}
                    </Text>
                  ) : null}
                </View>
                <Pill tone="muted" text={backendLabel(item.s.backend)} />
                {pill ? <Pill tone={pill.tone} text={pill.label} /> : null}
                {(conn?.unread[item.s.id] ?? 0) > 0 ? (
                  <View
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      backgroundColor: tokens.accents.rose,
                    }}
                  />
                ) : null}
              </Pressable>
            </Animated.View>
          );
        }}
      />
      {dimmed ? <StatusOverlay text={overlay} tone="muted" /> : null}
      <Pressable
        accessibilityLabel="New session"
        onPress={newSession}
        style={{
          position: "absolute",
          right: 20,
          bottom: 32,
          width: 56,
          height: 56,
          borderRadius: 28,
          // spec 10.9: the computer's accent tints exactly card stripe, session dot, cursor, send
          // button and connection indicator — this "+" is a fixed brand action, like the pairing
          // FAB on the computers list, not a sixth accented surface.
          backgroundColor: tokens.accents.emerald,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: tokens.bg, fontSize: 28, lineHeight: 30 }}>+</Text>
      </Pressable>
    </View>
  );
}
