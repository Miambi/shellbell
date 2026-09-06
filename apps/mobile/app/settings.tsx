import { runVectorChecks, type Vectors } from "@shellbell/protocol";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { loadOrCreateIdentity } from "../src/identity/keys";
import { useUiStore } from "../src/store/computers";
import { tokens } from "../src/theme/tokens";
import vectors from "../src/util/vectors.json";

const REPO_URL = "https://github.com/Miambi/shellbell";
const COFFEE_URL = "https://buymeacoffee.com/bilaldev";

export default function SettingsScreen() {
  const [results, setResults] = useState<{ name: string; ok: boolean }[] | null>(null);
  const [fp, setFp] = useState<string | null>(null);
  const fontSize = useUiStore((s) => s.fontSize);
  const setFontSize = useUiStore((s) => s.setFontSize);
  const fitWidth = useUiStore((s) => s.fitWidth);
  const setFitWidth = useUiStore((s) => s.setFitWidth);

  useEffect(() => {
    void loadOrCreateIdentity().then((r) => setFp(r.fp));
  }, []);

  const runSelfTest = () => {
    setResults(runVectorChecks(vectors as Vectors));
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View style={styles.section}>
        <Text style={styles.label}>THIS PHONE</Text>
        <Text style={styles.text}>{Device.deviceName ?? "My phone"}</Text>
        <Text style={styles.textMuted}>{fp ? `fp ${fp.slice(0, 12)}…` : "…"}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>TERMINAL DISPLAY</Text>
        <View style={styles.row}>
          <Text style={styles.text}>Font size</Text>
          <View style={styles.stepper}>
            <Pressable
              accessibilityLabel="Decrease font size"
              onPress={() => setFontSize(fontSize - 1)}
              style={styles.stepperButton}
            >
              <Text style={styles.text}>−</Text>
            </Pressable>
            <Text style={[styles.text, styles.stepperValue]}>{fontSize}</Text>
            <Pressable
              accessibilityLabel="Increase font size"
              onPress={() => setFontSize(fontSize + 1)}
              style={styles.stepperButton}
            >
              <Text style={styles.text}>+</Text>
            </Pressable>
          </View>
        </View>
        <View style={styles.row}>
          <Text style={styles.text}>Fit width</Text>
          <Switch accessibilityLabel="Fit width" value={fitWidth} onValueChange={setFitWidth} />
        </View>
        <Text style={styles.textFaint}>
          Raw mode does not support CJK IME composition — switch to line mode to type CJK text.
        </Text>
      </View>

      {__DEV__ && (
        <View style={styles.section}>
          <Text style={styles.label}>DEVELOPER</Text>
          <Pressable onPress={runSelfTest} style={styles.button}>
            <Text style={styles.buttonText}>Run crypto self-test</Text>
          </Pressable>
          {results && (
            <View style={styles.results}>
              {results.map((r) => (
                <Text key={r.name} style={styles.text}>
                  {r.ok ? "✓" : "✗"} {r.name}
                </Text>
              ))}
            </View>
          )}
          <Link href="/dev/render-spike" style={styles.link}>
            Render spike
          </Link>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.label}>ABOUT</Text>
        <Text style={styles.text}>
          Shellbell v{Constants.expoConfig?.version ?? "0.1.0"} · MIT License
        </Text>
        <Pressable onPress={() => void Linking.openURL(REPO_URL)}>
          <Text style={styles.link}>github.com/Miambi/shellbell</Text>
        </Pressable>
        <Pressable onPress={() => void Linking.openURL(COFFEE_URL)}>
          <Text style={styles.link}>Buy me a coffee</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: tokens.bg,
  },
  content: {
    padding: tokens.space[4],
    gap: tokens.space[5],
  },
  section: {
    gap: tokens.space[2],
  },
  label: {
    color: tokens.textMuted,
    fontSize: 12,
    letterSpacing: 1,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space[3],
  },
  stepperButton: {
    width: 32,
    height: 32,
    borderRadius: tokens.radius.sm,
    borderWidth: 1,
    borderColor: tokens.border,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperValue: {
    minWidth: 24,
    textAlign: "center",
  },
  text: {
    color: tokens.text,
  },
  textMuted: {
    color: tokens.textMuted,
    fontSize: 13,
  },
  textFaint: {
    color: tokens.textFaint,
    fontSize: 12,
  },
  link: {
    color: tokens.accents.blue,
  },
  button: {
    paddingVertical: tokens.space[2],
    paddingHorizontal: tokens.space[3],
    backgroundColor: tokens.accents.blue,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonText: {
    color: tokens.bg,
  },
  results: {
    alignItems: "flex-start",
    gap: 2,
  },
});
