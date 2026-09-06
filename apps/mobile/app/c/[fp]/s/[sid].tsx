import { useKeepAwake } from "expo-keep-awake";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { View } from "react-native";
import { connectionManager } from "../../../../src/net/manager";
import { ScreenView } from "../../../../src/screen/ScreenView";
import { useComputersStore } from "../../../../src/store/computers";
import { useConnectionsStore } from "../../../../src/store/connections";
import { tokens } from "../../../../src/theme/tokens";
import { EmptyState } from "../../../../src/ui/EmptyState";
import { StatusOverlay } from "../../../../src/ui/StatusOverlay";
import { backendLabel, cursorIsInferred } from "../../../../src/util/backends";
import { sidFromRoute } from "../../../../src/util/routes";
import { cursorBlinks, statePill } from "../../../../src/util/session-state";

export default function Session() {
  useKeepAwake();
  const { fp, sid } = useLocalSearchParams<{ fp: string; sid: string }>();
  const router = useRouter();
  const sessionId = sidFromRoute(sid ?? "");
  const computer = useComputersStore((s) => s.computers.find((c) => c.fp === fp));
  const conn = useConnectionsStore((s) => s.byComputer[fp ?? ""]);
  const session = conn?.sessions.find((s) => s.id === sessionId);
  const accentKey = (computer?.accent ?? "emerald") as keyof typeof tokens.accents;
  const accent = tokens.accents[accentKey] ?? tokens.accents.emerald;
  const inFlight = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: conn?.status deliberately re-runs this on reconnect.
  useEffect(() => {
    const c = connectionManager.get(fp ?? "");
    c?.subscribe(sessionId);
    useConnectionsStore.getState().patch(fp ?? "", (x) => ({
      unread: { ...x.unread, [sessionId]: 0 },
    }));
    return () => {
      c?.subscribe(null);
    };
  }, [fp, sessionId, conn?.status]);

  const view = conn?.view?.sessionId === sessionId ? conn.view.view : undefined;
  const oldest = conn?.oldestAvailable[sessionId];

  const loadOlder = useCallback(() => {
    const c = connectionManager.get(fp ?? "");
    if (!c || !view || inFlight.current) return;
    const from = view.state.historyFrom;
    // Spec 10.5: stop at the top, and stop once the agent says there is nothing older.
    if (from <= 0) return;
    if (oldest !== undefined && from <= oldest) return;
    inFlight.current = true;
    void c
      .request({
        type: "history.get",
        reqId: c.newReqId(),
        sessionId,
        before: from,
        count: 200,
      })
      .catch(() => undefined)
      .finally(() => {
        inFlight.current = false;
      });
  }, [fp, sessionId, view, oldest]);

  const pill = session ? statePill(session.state) : null;
  const title = session ? `${session.title}${pill ? ` · ${pill.label}` : ""}` : "Session";
  const dimmed = conn?.status !== "online";
  const overlay = !conn?.agentOnline
    ? `${computer?.name ?? "Computer"} is offline`
    : "Reconnecting…";

  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <Stack.Screen
        options={{ title, headerBackTitle: session ? backendLabel(session.backend) : undefined }}
      />
      {!session && !view ? (
        <EmptyState
          text="Session ended."
          action={{ label: "Back", onPress: () => router.back() }}
        />
      ) : !view ? (
        <EmptyState text="Waiting for output…" />
      ) : (
        <ScreenView
          view={view}
          accent={accent}
          blinking={cursorBlinks(session?.state ?? "unknown")}
          inferredCursor={cursorIsInferred(session?.backend ?? "")}
          onLoadOlder={loadOlder}
        />
      )}
      {/* Spec 12: dim the last screen; never unmount it. */}
      {dimmed && view ? <StatusOverlay text={overlay} tone="muted" /> : null}
      {/* InputBar is added in Task 8 */}
    </View>
  );
}
