import { describe, expect, it } from "vitest";
import { validateContent, type PlayerCommand } from "@matter-siege/shared";
import { MatterSimulation, simulateReplay } from "../index.js";

describe("MatterSimulation", () => {
  it("loads a complete and valid content catalog", () => {
    expect(validateContent()).toEqual([]);
  });

  it("enforces phase order and ownership", async () => {
    const simulation = await MatterSimulation.create({ seed: 42 });
    expect(simulation.applyCommand(1, { type: "endBuild" }).ok).toBe(false);
    expect(simulation.applyCommand(0, { type: "endBuild" }).ok).toBe(true);
    expect(simulation.phase).toBe("craft");
    expect(simulation.applyCommand(0, { type: "launch", angle: 40, power: 0.5 }).ok).toBe(false);
    expect(
      simulation.applyCommand(0, {
        type: "craft",
        recipe: { body: "stone", element: "fire", modifier: "heavy" },
      }).ok,
    ).toBe(true);
    expect(simulation.phase).toBe("aim");
  });

  it("produces the same snapshot from the same seed and command log", async () => {
    const simulation = await MatterSimulation.create({ seed: 91, labMode: true });
    const commands: PlayerCommand[] = [
      { type: "endBuild" },
      { type: "craft", recipe: { body: "metal", element: "lightning", modifier: "heavy" } },
      { type: "launch", angle: 40, power: 0.52 },
    ];
    for (const command of commands) simulation.applyCommand(0, command);
    simulation.step(180);

    const replayed = await simulateReplay(simulation.exportReplay(), 6);
    const direct = simulation.snapshot();
    expect(replayed.seed).toBe(direct.seed);
    expect(replayed.blocks.map((block) => [block.id, block.hp])).toEqual(
      direct.blocks.map((block) => [block.id, block.hp]),
    );
  });

  it("never emits non-finite physics state under repeated launches", async () => {
    const simulation = await MatterSimulation.create({ seed: 712, labMode: true });
    simulation.applyCommand(0, { type: "endBuild" });
    simulation.applyCommand(0, { type: "craft", recipe: { body: "glass", element: "acid", modifier: "split" } });
    simulation.applyCommand(0, { type: "launch", angle: 39, power: 0.5 });
    simulation.step(300);
    for (const block of simulation.snapshot().blocks) {
      expect(Number.isFinite(block.position.x)).toBe(true);
      expect(Number.isFinite(block.position.y)).toBe(true);
      expect(Number.isFinite(block.hp)).toBe(true);
    }
  });
});

