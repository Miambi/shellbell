import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, Text } from "react-native";
import { useComputersStore } from "../../../src/store/computers";
import { tokens } from "../../../src/theme/tokens";

export default function ComputerLayout() {
  const { fp } = useLocalSearchParams<{ fp: string }>();
  const router = useRouter();
  const computer = useComputersStore((s) => s.computers.find((c) => c.fp === fp));
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: tokens.bg },
        headerTintColor: tokens.text,
        contentStyle: { backgroundColor: tokens.bg },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: computer?.name ?? "Computer",
          headerRight: () => (
            <Pressable onPress={() => router.push("/settings")} hitSlop={8}>
              <Text style={{ color: tokens.textMuted, fontSize: 20 }}>⋯</Text>
            </Pressable>
          ),
        }}
      />
    </Stack>
  );
}
