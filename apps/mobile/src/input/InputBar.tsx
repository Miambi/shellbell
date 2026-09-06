import type { NamedKey } from "@shellbell/protocol";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { connectionManager } from "../net/manager";
import { useUiStore } from "../store/computers";
import { useConnectionsStore } from "../store/connections";
import { tokens } from "../theme/tokens";
import { Bar } from "../ui/Bar";
import { fireInput } from "./fireInput";
import { lineExceedsLimit } from "./limits";
import { preparePaste } from "./paste";
import { QuickKeys } from "./QuickKeys";
import { ReplyChips } from "./ReplyChips";
import { type RawStep, rawBackspaceOnEmptySteps, rawChangeSteps } from "./rawSequence";

const LINE_TOO_LONG_TOAST = "Line too long — shorten it before sending.";

export function InputBar({
  fp,
  sessionId,
  accent,
  showChips,
}: {
  fp: string;
  sessionId: string;
  accent: string;
  showChips: boolean;
}) {
  const raw = useUiStore((s) => s.rawModeBySession[sessionId] ?? false);
  const setRaw = useUiStore((s) => s.setRawMode);
  const [text, setText] = useState("");
  const [rawText, setRawText] = useState("");
  const [histIdx, setHistIdx] = useState(-1);
  const rawPrev = useRef("");

  const conn = () => connectionManager.get(fp);

  type Req = Parameters<NonNullable<ReturnType<typeof conn>>["request"]>[0];
  const fire = (msg: Req) => {
    const c = conn();
    if (!c) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    fireInput(c, msg, {
      track: (reqId) =>
        useConnectionsStore.getState().patch(fp, (x) => ({
          pendingInputs: { ...x.pendingInputs, [reqId]: { at: Date.now(), sessionId } },
        })),
      untrack: (reqId, toast) =>
        useConnectionsStore.getState().patch(fp, (x) => {
          const rest = { ...x.pendingInputs };
          delete rest[reqId];
          return toast ? { pendingInputs: rest, toast } : { pendingInputs: rest };
        }),
    });
  };

  const fireStep = (step: RawStep) => {
    const c = conn();
    if (!c) return;
    if (step.kind === "text")
      fire({ type: "input.text", reqId: c.newReqId(), sessionId, text: step.text });
    else fire({ type: "input.key", reqId: c.newReqId(), sessionId, key: step.key });
  };

  const sendLine = (line: string) => {
    const c = conn();
    if (!c) return;
    fire({ type: "input.line", reqId: c.newReqId(), sessionId, text: line });
    useConnectionsStore.getState().patch(fp, (x) => ({
      history: [...x.history.filter((h) => h !== line), line].slice(-100),
    }));
  };
  const sendKey = (key: NamedKey) => {
    const c = conn();
    if (c) fire({ type: "input.key", reqId: c.newReqId(), sessionId, key });
  };
  const sendText = (t: string) => {
    const c = conn();
    if (c && t) fire({ type: "input.text", reqId: c.newReqId(), sessionId, text: t });
  };
  const paste = async () => {
    const { text: pasted, sendEnter } = preparePaste(await Clipboard.getStringAsync());
    sendText(pasted);
    if (sendEnter) sendKey("enter");
  };

  const browseHistory = () => {
    const h = useConnectionsStore.getState().read(fp).history;
    if (h.length === 0) return;
    const idx = histIdx === -1 ? h.length - 1 : Math.max(0, histIdx - 1);
    setHistIdx(idx);
    setText(h[idx] ?? "");
  };

  /** Raw mode: diff against the previous value, then keep it as the new baseline. */
  const onRawChange = (next: string) => {
    for (const step of rawChangeSteps(rawPrev.current, next)) fireStep(step);
    rawPrev.current = next;
    setRawText(next);
  };

  /** Review I1: once the field is empty, `onChangeText` never fires for a Backspace press -- the
   *  differ above has nothing left to shorten. `onKeyPress` is the only remaining signal. */
  const onRawKeyPress = (key: string) => {
    if (key !== "Backspace") return;
    for (const step of rawBackspaceOnEmptySteps(rawText)) fireStep(step);
  };

  const submitRaw = () => {
    sendKey("enter");
    rawPrev.current = "";
    setRawText("");
  };

  const submitLine = () => {
    if (!text.trim()) return;
    if (lineExceedsLimit(text)) {
      useConnectionsStore.getState().patch(fp, () => ({ toast: LINE_TOO_LONG_TOAST }));
      return;
    }
    sendLine(text);
    setText("");
    setHistIdx(-1);
  };

  return (
    <Bar style={{ gap: 6 }}>
      {showChips ? <ReplyChips onLine={sendLine} onKey={sendKey} accent={accent} /> : null}
      <QuickKeys onKey={sendKey} onPaste={() => void paste()} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable
          accessibilityLabel={raw ? "Switch to line mode" : "Switch to raw mode"}
          onPress={() => setRaw(sessionId, !raw)}
          style={{
            width: 40,
            height: 40,
            borderRadius: tokens.radius.md,
            borderWidth: 1,
            borderColor: raw ? accent : tokens.border,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: raw ? accent : tokens.textMuted }}>⌨︎</Text>
        </Pressable>
        <View
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            backgroundColor: tokens.surface2,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: tokens.border,
            paddingLeft: 12,
          }}
        >
          <Text style={{ color: accent, fontWeight: "700" }}>{raw ? "»" : "$"}</Text>
          <TextInput
            value={raw ? rawText : text}
            onChangeText={
              raw
                ? onRawChange
                : (t) => {
                    setText(t);
                    setHistIdx(-1);
                  }
            }
            onKeyPress={raw ? (e) => onRawKeyPress(e.nativeEvent.key) : undefined}
            onSubmitEditing={raw ? submitRaw : submitLine}
            blurOnSubmit={false}
            placeholder={raw ? "raw keystrokes (no CJK IME)" : "command…"}
            placeholderTextColor={tokens.textFaint}
            autoCorrect={false}
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="off"
            textContentType="none"
            keyboardType={
              raw ? (Platform.OS === "ios" ? "ascii-capable" : "visible-password") : "default"
            }
            returnKeyType="send"
            style={{
              flex: 1,
              color: tokens.text,
              paddingVertical: 10,
              paddingHorizontal: 8,
              fontSize: 15,
            }}
          />
          {raw ? null : (
            <Pressable
              accessibilityLabel="Previous command"
              onPress={browseHistory}
              style={{ padding: 8 }}
            >
              <Text style={{ color: tokens.textMuted }}>↑</Text>
            </Pressable>
          )}
        </View>
        {raw ? null : (
          <Pressable
            accessibilityLabel="Send"
            onPress={submitLine}
            style={{
              width: 40,
              height: 40,
              borderRadius: tokens.radius.md,
              backgroundColor: text.trim() ? accent : tokens.surface2,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: text.trim() ? "#000" : tokens.textFaint, fontWeight: "700" }}>
              ↩
            </Text>
          </Pressable>
        )}
      </View>
    </Bar>
  );
}
