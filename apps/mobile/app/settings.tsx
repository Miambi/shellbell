import { ScrollView, StyleSheet, Text } from "react-native";
import { tokens } from "../src/theme/tokens";

export default function SettingsScreen() {
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Text style={styles.text}>Settings (Task 8)</Text>
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
});
