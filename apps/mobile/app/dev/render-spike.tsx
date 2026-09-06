import { FlashList } from "@shopify/flash-list";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { LineView } from "../../src/screen/LineView";
import { tokens } from "../../src/theme/tokens";
import { cjkLines, htopScreen, logLines } from "../../src/util/fixtures";

const SETS = { htop: htopScreen(), cjk: cjkLines(), log: logLines(5000) };
const FONT_SIZE = 12;
const CONTENT_WIDTH = 160 * FONT_SIZE * 0.6 + 16;

export default function RenderSpike() {
  const [which, setWhich] = useState<keyof typeof SETS>("log");
  const [tick, setTick] = useState(0);
  const { width } = useWindowDimensions();
  const data = useMemo(() => {
    if (which !== "htop") return SETS[which];
    return SETS.htop.map((l, i) =>
      i === tick % SETS.htop.length ? { r: [{ t: `tick ${tick}`, fg: 5 as const }] } : l,
    );
  }, [which, tick]);
  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <View style={{ flexDirection: "row", gap: 8, padding: 8 }}>
        {(Object.keys(SETS) as (keyof typeof SETS)[]).map((k) => (
          <Pressable
            key={k}
            onPress={() => setWhich(k)}
            style={{
              padding: 8,
              backgroundColor: which === k ? tokens.accents.emerald : tokens.surface2,
              borderRadius: tokens.radius.sm,
            }}
          >
            <Text style={{ color: tokens.text }}>{k}</Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => setTick((t) => t + 1)}
          style={{ padding: 8, backgroundColor: tokens.surface2, borderRadius: tokens.radius.sm }}
        >
          <Text style={{ color: tokens.text }}>redraw</Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        bounces={false}
        contentContainerStyle={{ flexGrow: 1, width: Math.max(width, CONTENT_WIDTH) }}
      >
        <View style={{ flex: 1, width: Math.max(width, CONTENT_WIDTH) }}>
          <FlashList
            data={data}
            keyExtractor={(item, i) => `${i}:${item.r[0]?.t ?? ""}`}
            renderItem={({ item }) => <LineView line={item} fontSize={FONT_SIZE} />}
          />
        </View>
      </ScrollView>
    </View>
  );
}
