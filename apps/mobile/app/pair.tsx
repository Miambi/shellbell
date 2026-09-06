import { CameraView, useCameraPermissions } from "expo-camera";
import * as Device from "expo-device";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Alert, Platform, Pressable, Text, View } from "react-native";
import { loadOrCreateIdentity, savePairSecret } from "../src/identity/keys";
import { type PairingCode, PairingError, parsePairingQr, runPairing } from "../src/net/pairing";
import { useComputersStore } from "../src/store/computers";
import { tokens } from "../src/theme/tokens";

const COPY: Record<PairingCode, string> = {
  "bad-qr": "That isn't a Shellbell pairing code.",
  "bad-code": "That code expired — run `shellbell pair` again.",
  declined: "The computer declined.",
  "no-window": "No pairing window is open on that computer.",
  "no-agent": "The computer isn't online.",
  "too-many": "That computer already has the maximum number of paired phones.",
  timeout: "Pairing timed out. Run `shellbell pair` again and rescan.",
  relay: "Couldn't reach the relay.",
};

export default function PairScreen() {
  const [perm, requestPerm] = useCameraPermissions();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scanned = useRef(false);
  const router = useRouter();
  const add = useComputersStore((s) => s.add);

  if (!perm?.granted) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: 24,
          backgroundColor: tokens.bg,
        }}
      >
        <Text style={{ color: tokens.text, textAlign: "center" }}>
          Shellbell needs the camera to scan the pairing code your computer shows.
        </Text>
        <Pressable
          onPress={() => void requestPerm()}
          style={{
            backgroundColor: tokens.accents.emerald,
            padding: 12,
            borderRadius: tokens.radius.md,
          }}
        >
          <Text style={{ color: "#000", fontWeight: "600" }}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  const confirm = (name: string, fpPrefix: string) =>
    new Promise<boolean>((resolve) => {
      Alert.alert(`Pair with "${name}"?`, `Fingerprint ${fpPrefix}`, [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Pair", onPress: () => resolve(true) },
      ]);
    });

  const onScan = async (data: string) => {
    if (scanned.current) return;
    scanned.current = true;
    setError(null);
    try {
      const { qr, displayName, fpPrefix } = parsePairingQr(data, { allowInsecure: __DEV__ });
      if (!(await confirm(displayName, fpPrefix))) {
        scanned.current = false;
        return;
      }
      setBusy("Pairing… confirm on your computer");
      const { identity, fp } = await loadOrCreateIdentity();
      const r = await runPairing({
        qr,
        identity,
        phoneFp: fp,
        phoneName: Device.deviceName ?? "My phone",
        platform: Platform.OS === "ios" ? "ios" : "android",
        appVersion: "0.1.0",
      });
      await savePairSecret(r.computerFp, r.secret);
      add({
        fp: r.computerFp,
        name: r.computerName,
        accent: r.accent,
        relayUrl: r.relayUrl,
        pairedAt: new Date().toISOString(),
        lastSeenAt: null,
        pushEnabled: true,
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace(`/c/${r.computerFp}`);
    } catch (e) {
      setError(e instanceof PairingError ? COPY[e.code] : COPY.relay);
      scanned.current = false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <CameraView
        style={{ flex: 1 }}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={(r) => void onScan(r.data)}
      />
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={{ color: tokens.textMuted, textAlign: "center" }}>
          {busy ?? "Run `npx shellbell` on your Mac and scan the code."}
        </Text>
        {error ? (
          <Text style={{ color: tokens.accents.rose, textAlign: "center" }}>{error}</Text>
        ) : null}
      </View>
    </View>
  );
}
