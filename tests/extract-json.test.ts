import { describe, it, expect } from "vitest";
import { extractJson } from "../src/classify.js";

describe("extractJson", () => {
  it("returns bare JSON unchanged", () => {
    expect(extractJson('{"value":"x","confidence":0.9}')).toBe('{"value":"x","confidence":0.9}');
  });

  it("strips markdown json fences", () => {
    const input = '```json\n{"value":"x","confidence":0.9}\n```';
    expect(extractJson(input)).toBe('{"value":"x","confidence":0.9}');
  });

  it("extracts JSON after prose", () => {
    const input = 'Here is the result:\n{"value":"x","confidence":0.5}';
    expect(extractJson(input)).toBe('{"value":"x","confidence":0.5}');
  });

  it("ignores braces inside <think> blocks", () => {
    const input =
      '<think>I should output { something like {"draft": true} }</think>\n{"value":"real","confidence":0.8}';
    expect(extractJson(input)).toBe('{"value":"real","confidence":0.8}');
  });

  it("returns null when no JSON present", () => {
    expect(extractJson("no braces here")).toBeNull();
  });
});
