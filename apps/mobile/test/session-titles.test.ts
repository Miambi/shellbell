import { describe, expect, it } from "vitest";
import {
  lookupSessionTitle,
  saveSessionTitles,
  type TitleStorage,
} from "../src/notifications/sessionTitles";

function memory(): TitleStorage {
  const m = new Map<string, string>();
  return {
    getItemSync: (k) => m.get(k) ?? null,
    setItemSync: (k, v) => void m.set(k, v),
  };
}
const s = (id: string, title: string, backend = "tmux") => ({ id, title, backend });

describe("session title persistence", () => {
  it("round-trips a title so a backgrounded app can name the session", () => {
    const st = memory();
    saveSessionTitles("fp1", [s("s1", "claude-code", "herdr")], st);
    expect(lookupSessionTitle("fp1", "s1", st)).toEqual({ title: "claude-code", backend: "herdr" });
  });

  it("returns undefined for an unseen session", () => {
    expect(lookupSessionTitle("fp1", "nope", memory())).toBeUndefined();
  });

  it("keeps computers separate", () => {
    const st = memory();
    saveSessionTitles("fp1", [s("s1", "one")], st);
    saveSessionTitles("fp2", [s("s1", "two")], st);
    expect(lookupSessionTitle("fp1", "s1", st)?.title).toBe("one");
    expect(lookupSessionTitle("fp2", "s1", st)?.title).toBe("two");
  });

  it("evicts sessions absent from the latest list", () => {
    const st = memory();
    saveSessionTitles("fp1", [s("s1", "one"), s("s2", "two")], st);
    saveSessionTitles("fp1", [s("s1", "one")], st);
    expect(lookupSessionTitle("fp1", "s2", st)).toBeUndefined();
  });

  it("survives corrupt stored JSON instead of throwing", () => {
    const st = memory();
    st.setItemSync("shellbell.sessionTitles", "{not json");
    expect(lookupSessionTitle("fp1", "s1", st)).toBeUndefined();
    saveSessionTitles("fp1", [s("s1", "ok")], st);
    expect(lookupSessionTitle("fp1", "s1", st)?.title).toBe("ok");
  });
});
