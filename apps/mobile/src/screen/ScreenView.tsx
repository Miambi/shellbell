import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useUiStore } from "../store/computers";
import type { KeyedLine, ViewState } from "../store/screen";
import { tokens } from "../theme/tokens";
import { type RowCursor, ScreenRow } from "./ScreenRow";

export function ScreenView({
  view,
  accent,
  blinking,
  inferredCursor,
  onLoadOlder,
}: {
  view: ViewState;
  accent: string;
  blinking: boolean;
  inferredCursor: boolean;
  onLoadOlder: () => void;
}) {
  const { width } = useWindowDimensions();
  const fontSizeSetting = useUiStore((s) => s.fontSize);
  const fitWidth = useUiStore((s) => s.fitWidth);
  const setFontSize = useUiStore((s) => s.setFontSize);
  const fontSize = fitWidth ? Math.max(5, (width - 16) / view.state.cols / 0.6) : fontSizeSetting;
  const charWidth = fontSize * 0.6;
  const lineHeight = fontSize * 1.25;
  const contentWidth = Math.max(width, view.state.cols * charWidth + 16);
  const list = useRef<FlashListRef<KeyedLine>>(null);
  const [following, setFollowing] = useState(true);
  const startScale = useRef(fontSizeSetting);
  const histLen = view.state.history.length;

  const pinch = Gesture.Pinch()
    .onStart(() => {
      startScale.current = fontSizeSetting;
    })
    .onUpdate((e) => setFontSize(Math.round(startScale.current * e.scale)))
    .runOnJS(true);

  useEffect(() => {
    if (following) list.current?.scrollToEnd({ animated: false });
  }, [following]);

  const cursor: RowCursor | null =
    view.state.cursor.y >= 0
      ? {
          x: view.state.cursor.x,
          y: view.state.cursor.y,
          accent,
          blinking,
          inferred: inferredCursor,
        }
      : null;

  const renderItem = useCallback(
    ({ item, index }: { item: KeyedLine; index: number }) => (
      <ScreenRow line={item} fontSize={fontSize} screenIndex={index - histLen} cursor={cursor} />
    ),
    [fontSize, histLen, cursor],
  );

  return (
    <GestureDetector gesture={pinch}>
      <View style={{ flex: 1 }}>
        <ScrollView
          horizontal
          bounces={false}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ flexGrow: 1, width: contentWidth }}
        >
          <View style={{ flex: 1, width: contentWidth }}>
            <FlashList
              ref={list}
              data={view.keyed}
              keyExtractor={(l) => l.key}
              renderItem={renderItem}
              maintainVisibleContentPosition={{
                startRenderingFromBottom: true,
                autoscrollToBottomThreshold: 0.1,
              }}
              onStartReached={onLoadOlder}
              onStartReachedThreshold={0.2}
              onScroll={(e) => {
                const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                const atEnd =
                  contentOffset.y + layoutMeasurement.height >= contentSize.height - lineHeight * 2;
                setFollowing(atEnd);
              }}
              scrollEventThrottle={100}
              contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 4 }}
            />
          </View>
        </ScrollView>
        {following ? null : (
          <Pressable
            onPress={() => {
              setFollowing(true);
              list.current?.scrollToEnd({ animated: true });
            }}
            style={{
              position: "absolute",
              alignSelf: "center",
              bottom: 12,
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: tokens.radius.lg,
              backgroundColor: tokens.surface2,
              borderWidth: 1,
              borderColor: tokens.border,
            }}
          >
            <Text style={{ color: tokens.text }}>↓ Jump to live</Text>
          </Pressable>
        )}
      </View>
    </GestureDetector>
  );
}
