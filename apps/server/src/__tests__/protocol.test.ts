import { describe, expect, it } from "vitest";
import { isPlayerCommand } from "../protocol.js";

describe("network protocol validation", () => {
  it("accepts legal player intents", () => {
    expect(isPlayerCommand({ type: "launch", angle: 40, power: 0.5 })).toBe(true);
    expect(isPlayerCommand({ type: "craft", recipe: { body: "stone", element: "fire", modifier: "heavy" } })).toBe(true);
    expect(isPlayerCommand({ type: "upgradeGuardian" })).toBe(true);
  });

  it("rejects result claims and invalid content", () => {
    expect(isPlayerCommand({ type: "damage", blockId: "p1_core", amount: 9999 })).toBe(false);
    expect(isPlayerCommand({ type: "craft", recipe: { body: "nuke", element: "void", modifier: "win" } })).toBe(false);
    expect(isPlayerCommand({ type: "upgradeGuardian", level: 99 })).toBe(false);
  });
});
