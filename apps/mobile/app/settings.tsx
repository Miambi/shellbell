import { runVectorChecks, type Vectors } from "@shellbell/protocol";
import { Link } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { tokens } from "../src/theme/tokens";
import vectors from "../src/util/vectors.json";

export default function SettingsScreen() {
  const [results, setResults] = useState<{ name: string; ok: boolean }[] | null>(null);

  const runSelfTest = () => {
    setResults(runVectorChecks(vectors as Vectors));
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Text style={styles.text}>Settings (Task 8)</Text>
      {__DEV__ && (
        <Link href="/dev/render-spike" style={styles.link}>
          Render spike
        </Link>
      )}
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: tokens.bg,
  },
  content: {
    alignItems: "center",
    justifyContent: "center",
    flexGrow: 1,
  },
  text: {
    color: tokens.text,
  },
  link: {
    marginTop: tokens.space[3],
    color: tokens.accents.blue,
  },
  button: {
    marginTop: tokens.space[3],
    paddingVertical: tokens.space[2],
    paddingHorizontal: tokens.space[3],
    backgroundColor: tokens.accents.blue,
    borderRadius: 8,
  },
  buttonText: {
    color: tokens.bg,
  },
  results: {
    marginTop: tokens.space[3],
    alignItems: "flex-start",
  },
});
