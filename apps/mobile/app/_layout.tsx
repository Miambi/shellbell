import "../src/bootstrap/crypto";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { loadOrCreateIdentity } from "../src/identity/keys";
import { connectionManager } from "../src/net/manager";
import { useComputersStore, useUiStore } from "../src/store/computers";
import { tokens } from "../src/theme/tokens";

void SplashScreen.preventAutoHideAsync();

// M1: the manifest version, not a hardcoded literal that would silently drift from the real
// build (the relay records `appVersion` on every phone socket).
const APP_VERSION = Constants.expoConfig?.version ?? "0.1.0";

export default function RootLayout() {
  // I6: a corrupt/unreadable keychain (or a locked one on Android) must not leave the app
  // silently stuck on "idle" forever with no connection manager ever started -- it gets an
  // honest, non-actionable-detail error screen instead. The message deliberately never includes
  // the underlying exception (it can name on-device key paths).
  const [identityError, setIdentityError] = useState(false);

  useEffect(() => {
    useComputersStore.getState().hydrate();
    useUiStore.getState().hydrate();
    // Fonts are natively embedded (expo-font config plugin, review I2) -- there is no JS font
    // load to gate on, so the splash can come down as soon as the tree is ready to paint.
    void SplashScreen.hideAsync();
  }, []);

  useEffect(() => {
    // Covers this cold start's paired computers' `K_pair`s in the same one-time keychain
    // migration pass as the identity key (review C1) -- safe because the hydrate effect above
    // runs first (declaration order within one commit).
    const pairedFps = useComputersStore.getState().computers.map((c) => c.fp);
    loadOrCreateIdentity(pairedFps)
      .then(({ identity, fp }) => {
        connectionManager.start({
          identity,
          phoneFp: fp,
          phoneName: Device.deviceName ?? "My phone",
          appVersion: APP_VERSION,
          pushToken: async () => null,
        });
      })
      .catch(() => setIdentityError(true));
  }, []);

  if (identityError) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          gap: 8,
          backgroundColor: tokens.bg,
        }}
      >
        <StatusBar style="light" />
        <Text style={{ color: tokens.text, textAlign: "center", fontSize: 16 }}>
          Could not access secure storage.
        </Text>
        <Text style={{ color: tokens.textMuted, textAlign: "center" }}>
          Restart Shellbell. If this keeps happening, reinstall the app and re-pair.
        </Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
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
    </SafeAreaProvider>
  );
}
