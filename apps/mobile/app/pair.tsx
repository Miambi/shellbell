import { StyleSheet, Text, View } from "react-native";
import { tokens } from "../src/theme/tokens";

export default function PairScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Pair (Task 5)</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: tokens.bg,
  },
  text: {
    color: tokens.text,
  },
});
