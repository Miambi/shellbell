import { useKeepAwake } from "expo-keep-awake";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { KeyboardAvoidingView, Platform, View } from "react-native";
import { InputBar } from "../../../../src/input/InputBar";
import { connectionManager } from "../../../../src/net/manager";
import { ScreenView } from "../../../../src/screen/ScreenView";
import { useComputersStore } from "../../../../src/store/computers";
import { useConnectionsStore } from "../../../../src/store/connections";
import { tokens } from "../../../../src/theme/tokens";
import { EmptyState } from "../../../../src/ui/EmptyState";
import { StatusOverlay } from "../../../../src/ui/StatusOverlay";
import { Toast } from "../../../../src/ui/Toast";
import { backendLabel, cursorIsInferred } from "../../../../src/util/backends";
import { sidFromRoute } from "../../../../src/util/routes";
import {
  cursorBlinks,
  sessionEnded,
  shouldLoadOlder,
  statePill,
  wantsReply,
} from "../../../../src/util/session-state";

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
    if (!shouldLoadOlder(from, oldest)) return;
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

  // The session left the computer's `sessions` list but a cached `view` remains: it ended, and
  // the app must stop offering input for it (R59 ruling 1). The second disjunct only applies
  // while genuinely online (M7): otherwise a cold deep-link/notification tap into a session the
  // app has never fetched (`sessions` not loaded yet, or mid-reconnect) would render "Session
  // ended." for a session that may well still be running.
  const ended =
    sessionEnded(conn?.sessions ?? [], sessionId, view) ||
    (conn?.status === "online" && !session && !view);
  const pill = session ? statePill(session.state) : null;
  const title = session ? `${session.title}${pill ? ` · ${pill.label}` : ""}` : "Session";
  const dimmed = conn?.status !== "online";
  const overlay = !conn?.agentOnline
    ? `${computer?.name ?? "Computer"} is offline`
    : "Reconnecting…";

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={{ flex: 1, backgroundColor: tokens.bg }}>
        <Stack.Screen
          options={{ title, headerBackTitle: session ? backendLabel(session.backend) : undefined }}
        />
        {ended ? (
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
        {dimmed && view && !ended ? <StatusOverlay text={overlay} tone="muted" /> : null}
        {ended ? null : (
          <InputBar
            fp={fp ?? ""}
            sessionId={sessionId}
            accent={accent}
            showChips={wantsReply(
              session?.state ?? "unknown",
              conn?.events[sessionId]?.at(-1)?.kind,
            )}
          />
        )}
        {conn?.toast ? (
          <Toast
            text={conn.toast}
            onDone={() =>
              useConnectionsStore.getState().patch(fp ?? "", () => ({ toast: undefined }))
            }
          />
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}
