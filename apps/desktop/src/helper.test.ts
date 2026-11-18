import { describe, expect, it } from "vitest";
import { helperCommandPath } from "./helper";

describe("helperCommandPath", () => {
  it("uses resources/helper in packaged mode", () => {
    expect(helperCommandPath("C:\\app", true, "C:\\app\\resources")).toBe(
      "C:\\app\\resources\\helper\\helper.cmd"
    );
  });

  it("uses the desktop resource directory in development", () => {
    expect(helperCommandPath("D:\\hearth-os", false, "ignored")).toBe(
      "D:\\hearth-os\\apps\\desktop\\resources\\helper\\helper.cmd"
    );
  });
});
