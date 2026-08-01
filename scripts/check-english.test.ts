import { describe, expect, test } from "bun:test";
import { findJapaneseText } from "./check-english";

describe("findJapaneseText", () => {
  test("accepts English repository prose", () => {
    expect(findJapaneseText("Document behavior in English.")).toEqual([]);
  });

  test("detects Japanese ideographs", () => {
    expect(findJapaneseText("English\n\u65e5\u672c\u8a9e")).toEqual([
      { line: 2, text: "\u65e5\u672c\u8a9e" },
    ]);
  });

  test("detects Japanese kana", () => {
    expect(findJapaneseText("\u30ab\u30bf\u30ab\u30ca")).toHaveLength(1);
  });
});
