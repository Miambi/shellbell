import "../src/bootstrap/crypto";
import * as Device from "expo-device";
import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { loadOrCreateIdentity } from "../src/identity/keys";
import { connectionManager } from "../src/net/manager";
import { useComputersStore } from "../src/store/computers";
import { tokens } from "../src/theme/tokens";

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    "JetBrainsMonoNerdFont-Regular": require("../assets/fonts/JetBrainsMonoNerdFont-Regular.ttf"),
    "JetBrainsMonoNerdFont-Bold": require("../assets/fonts/JetBrainsMonoNerdFont-Bold.ttf"),
    "JetBrainsMonoNerdFont-Italic": require("../assets/fonts/JetBrainsMonoNerdFont-Italic.ttf"),
    "JetBrainsMonoNerdFont-BoldItalic": require("../assets/fonts/JetBrainsMonoNerdFont-BoldItalic.ttf"),
  });

  useEffect(() => {
    useComputersStore.getState().hydrate();
  }, []);

  useEffect(() => {
    if (!fontsLoaded) return;
    void SplashScreen.hideAsync();
    void loadOrCreateIdentity().then(({ identity, fp }) => {
      connectionManager.start({
        identity,
        phoneFp: fp,
        phoneName: Device.deviceName ?? "My phone",
        appVersion: "0.1.0",
        pushToken: async () => null,
      });
    });
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: tokens.bg }}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: tokens.bg },
          headerTintColor: tokens.text,
          contentStyle: { backgroundColor: tokens.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Computers" }} />
        <Stack.Screen name="pair" options={{ presentation: "modal", title: "Pair" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        <Stack.Screen name="c/[fp]" options={{ headerShown: false }} />
        <Stack.Screen name="dev/render-spike" options={{ title: "Render spike" }} />
      </Stack>
    </GestureHandlerRootView>
  );
}
