import { StyleSheet, Text, View } from "react-native";
import { tokens } from "../src/theme/tokens";

export default function ComputersScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.text}>Shellbell</Text>
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
