import { useLocalSearchParams, useRouter } from "expo-router";
import { Alert, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { deletePairSecret } from "../../../src/identity/keys";
import { connectionManager } from "../../../src/net/manager";
import { useComputersStore } from "../../../src/store/computers";
import { useConnectionsStore } from "../../../src/store/connections";
import { tokens } from "../../../src/theme/tokens";
import { backendLabel } from "../../../src/util/backends";

const ACCENT_KEYS = Object.keys(tokens.accents) as (keyof typeof tokens.accents)[];

export default function ComputerSettings() {
  const { fp } = useLocalSearchParams<{ fp: string }>();
  const router = useRouter();
  const computer = useComputersStore((s) => s.computers.find((c) => c.fp === fp));
  const update = useComputersStore((s) => s.update);
  const remove = useComputersStore((s) => s.remove);
  const conn = useConnectionsStore((s) => s.byComputer[fp ?? ""]);
  const backends = conn?.hello?.backends ?? [];

  if (!fp || !computer) return null;

  const unpair = () => {
    Alert.alert(
      "Unpair this computer?",
      "You can re-pair any time by scanning its QR code again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unpair",
          style: "destructive",
          onPress: () => {
            connectionManager.get(fp)?.close("user");
            void deletePairSecret(fp);
            remove(fp);
            router.replace("/");
          },
        },
      ],
    );
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.bg }}
      contentContainerStyle={{ padding: 16, gap: 24 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View style={{ gap: 4 }}>
        <Text style={{ color: tokens.textMuted, fontSize: 12, letterSpacing: 1 }}>COMPUTER</Text>
        <Text style={{ color: tokens.text, fontSize: 17 }}>{computer.name}</Text>
      </View>

      {backends.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: tokens.textMuted, fontSize: 12, letterSpacing: 1 }}>BACKENDS</Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {backends.map((b) => (
              <View
                key={b.name}
                style={{
                  borderWidth: 1,
                  borderColor: tokens.border,
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                }}
              >
                <Text style={{ color: tokens.text, fontSize: 13 }}>{backendLabel(b.name)}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <View style={{ gap: 8 }}>
        <Text style={{ color: tokens.textMuted, fontSize: 12, letterSpacing: 1 }}>ACCENT</Text>
        <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
          {ACCENT_KEYS.map((key) => (
            <Pressable
              key={key}
              accessibilityLabel={`Accent ${key}`}
              onPress={() => update(fp, { accent: key })}
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                backgroundColor: tokens.accents[key],
                borderWidth: computer.accent === key ? 3 : 0,
                borderColor: tokens.text,
              }}
            />
          ))}
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: tokens.text, fontSize: 15 }}>Notifications for this computer</Text>
        <Switch
          accessibilityLabel="Notifications for this computer"
          value={computer.pushEnabled}
          onValueChange={(v) => update(fp, { pushEnabled: v })}
        />
      </View>

      <View style={{ gap: 8 }}>
        <Pressable
          onPress={unpair}
          style={{
            backgroundColor: tokens.surface2,
            borderColor: tokens.accents.rose,
            borderWidth: 1,
            borderRadius: tokens.radius.md,
            paddingVertical: 12,
            alignItems: "center",
          }}
        >
          <Text style={{ color: tokens.accents.rose, fontSize: 15 }}>Unpair</Text>
        </Pressable>
        <Text style={{ color: tokens.textFaint, fontSize: 12 }}>
          This only forgets the computer on this phone — the Mac still has it paired until you run
          `shellbell unpair` there.
        </Text>
      </View>
    </ScrollView>
  );
}
