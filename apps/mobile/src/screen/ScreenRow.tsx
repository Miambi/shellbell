import { memo } from "react";
import { View } from "react-native";
import type { KeyedLine } from "../store/screen";
import { Cursor } from "./Cursor";
import { LineView } from "./LineView";

export interface RowCursor {
  x: number;
  y: number;
  accent: string;
  blinking: boolean;
  inferred: boolean;
}

/**
 * One list cell. `screenIndex` is the row's position on the live screen (negative for history
 * rows), so the cursor is drawn by the cell that owns it and scrolls with the list.
 */
export const ScreenRow = memo(function ScreenRow({
  line,
  fontSize,
  screenIndex,
  cursor,
}: {
  line: KeyedLine;
  fontSize: number;
  screenIndex: number;
  cursor: RowCursor | null;
}) {
  const lineHeight = fontSize * 1.25;
  const charWidth = fontSize * 0.6;
  const showCursor = cursor !== null && cursor.y === screenIndex;
  return (
    <View style={{ height: lineHeight }}>
      <LineView line={line} fontSize={fontSize} />
      {showCursor ? (
        <Cursor
          left={cursor.x * charWidth}
          width={charWidth}
          height={lineHeight}
          accent={cursor.accent}
          blinking={cursor.blinking}
          inferred={cursor.inferred}
        />
      ) : null}
    </View>
  );
});
