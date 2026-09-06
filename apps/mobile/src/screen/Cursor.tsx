import { useEffect } from "react";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

const SOLID = 0.7;
/** spec 8.13/10.6: a herdr cursor is inferred from output, so it is drawn faintly. */
const INFERRED = 0.25;

export function Cursor({
  left,
  width,
  height,
  accent,
  blinking,
  inferred,
}: {
  left: number;
  width: number;
  height: number;
  accent: string;
  blinking: boolean;
  inferred: boolean;
}) {
  const base = inferred ? INFERRED : SOLID;
  const opacity = useSharedValue(base);
  useEffect(() => {
    opacity.value = blinking
      ? withRepeat(withTiming(0, { duration: 500 }), -1, true)
      : withTiming(base, { duration: 120 });
  }, [blinking, base, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: "absolute", left, top: 0, width, height, backgroundColor: accent },
        style,
      ]}
    />
  );
}
