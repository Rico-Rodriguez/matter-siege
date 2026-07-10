import { describe, expect, it } from "vitest";
import { FORTIFICATION_CONFIG, LAUNCH_CONFIG, validateContent, type MatchSnapshot, type PlayerCommand, type PlayerId } from "@matter-siege/shared";
import { MatterSimulation, SIM_HZ, simulateReplay } from "../index.js";

const towerIntegrity = (snapshot: MatchSnapshot, owner: PlayerId) =>
  snapshot.blocks
    .filter((block) => block.owner === owner)
    .map(({ id, hp, position, rotation }) => ({ id, hp, position, rotation }));

const towerHp = (snapshot: MatchSnapshot, owner: PlayerId): number =>
  snapshot.blocks.filter((block) => block.owner === owner).reduce((total, block) => total + block.hp, 0);

const advanceThroughResolve = (simulation: MatterSimulation): number => {
  const maxResolveTicks = Math.ceil((LAUNCH_CONFIG.maxFlightSeconds + LAUNCH_CONFIG.postImpactSeconds) * SIM_HZ);
  let elapsed = 0;
  while (simulation.phase === "resolve" && elapsed <= maxResolveTicks) {
    simulation.step();
    elapsed += 1;
  }
  expect(elapsed).toBeLessThanOrEqual(maxResolveTicks);
  expect(simulation.phase).not.toBe("resolve");
  return elapsed;
};

const launchRecommendedShot = (simulation: MatterSimulation, owner: PlayerId): void => {
  expect(simulation.applyCommand(owner, { type: "endBuild" }).ok).toBe(true);
  expect(
    simulation.applyCommand(owner, {
      type: "craft",
      recipe: { body: "stone", element: "fire", modifier: "heavy" },
    }).ok,
  ).toBe(true);
  expect(
    simulation.applyCommand(owner, {
      type: "launch",
      angle: LAUNCH_CONFIG.recommendedAngle,
      power: LAUNCH_CONFIG.recommendedPower,
    }).ok,
  ).toBe(true);
};

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

  it("upgrades one selected block through visible, capped levels", async () => {
    const simulation = await MatterSimulation.create({ seed: 56, labMode: true });
    const before = simulation.snapshot().blocks.find((block) => block.id === "p0_b0")!;

    expect(simulation.applyCommand(0, { type: "mutate", blockId: before.id, mutation: "reinforce" }).ok).toBe(true);
    expect(simulation.applyCommand(0, { type: "mutate", blockId: before.id, mutation: "reinforce" }).ok).toBe(true);
    const upgraded = simulation.snapshot().blocks.find((block) => block.id === before.id)!;
    expect(upgraded.upgradeLevel).toBe(FORTIFICATION_CONFIG.block.maxLevel);
    expect(upgraded.maxHp).toBe(before.maxHp + FORTIFICATION_CONFIG.block.hpBonusPerLevel * 2);
    expect(simulation.snapshot().buildPoints).toBe(0);

    launchRecommendedShot(simulation, 0);
    advanceThroughResolve(simulation);
    const capped = simulation.applyCommand(0, { type: "mutate", blockId: before.id, mutation: "reinforce" });
    expect(capped.ok).toBe(false);
    expect(capped.error).toContain("maximum level");
  });

  it("places an upgradeable Aether Regent above the tower", async () => {
    const simulation = await MatterSimulation.create({ seed: 57, labMode: true });
    const initial = simulation.snapshot();
    const guardian = initial.blocks.find((block) => block.id === "p0_core")!;
    const highestBlock = Math.max(...initial.blocks.filter((block) => block.owner === 0 && block.kind === "block").map((block) => block.position.y));
    expect(guardian.position.y).toBeGreaterThan(highestBlock);
    expect(guardian.upgradeLevel).toBe(1);

    expect(simulation.applyCommand(0, { type: "upgradeGuardian" }).ok).toBe(true);
    expect(simulation.applyCommand(0, { type: "upgradeGuardian" }).ok).toBe(true);
    const ascended = simulation.snapshot().blocks.find((block) => block.id === "p0_core")!;
    expect(ascended.upgradeLevel).toBe(FORTIFICATION_CONFIG.guardian.tiers.length);
    expect(ascended.maxHp).toBe(
      guardian.maxHp + FORTIFICATION_CONFIG.guardian.tiers.slice(1).reduce((total, tier) => total + tier.maxHpBonus, 0),
    );
  });

  it("defeats a tower when its Aether Regent touches the arena floor", async () => {
    const simulation = await MatterSimulation.create({ seed: 58 });
    const internals = simulation as unknown as {
      blocks: Map<string, { body: { setTranslation(position: { x: number; y: number }, wakeUp: boolean): void } }>;
    };
    internals.blocks.get("p0_core")!.body.setTranslation({ x: -3, y: 0.45 }, true);
    simulation.step();
    expect(simulation.snapshot().winner).toBe(1);
    expect(simulation.phase).toBe("finished");
  });

  it("uses the Ascendant Regent's deterministic mending pulse", async () => {
    const simulation = await MatterSimulation.create({ seed: 59, labMode: true });
    simulation.applyCommand(0, { type: "upgradeGuardian" });
    simulation.applyCommand(0, { type: "upgradeGuardian" });
    const internals = simulation as unknown as {
      blocks: Map<string, { state: { hp: number; maxHp: number } }>;
    };
    const target = internals.blocks.get("p0_b0")!.state;
    target.hp -= 25;
    const damagedHp = target.hp;
    simulation.drainEvents();

    launchRecommendedShot(simulation, 0);
    advanceThroughResolve(simulation);

    expect(simulation.snapshot().blocks.find((block) => block.id === "p0_b0")!.hp).toBe(
      damagedHp + FORTIFICATION_CONFIG.guardian.tiers.at(-1)!.repairPerTurn,
    );
    expect(simulation.drainEvents().some((event) => event.type === "guardianPulse" && event.targetBlockId === "p0_b0")).toBe(true);
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

  it("rejects replay logs from a different simulation version", async () => {
    const simulation = await MatterSimulation.create({ seed: 92 });
    const incompatibleReplay = { ...simulation.exportReplay(), version: "sim-0.1.0" };
    await expect(simulateReplay(incompatibleReplay)).rejects.toThrow("incompatible");
  });

  it("launches player zero's recommended shot clear of its own tower and into the rival", async () => {
    const simulation = await MatterSimulation.create({ seed: 314 });
    const before = simulation.snapshot();

    launchRecommendedShot(simulation, 0);
    advanceThroughResolve(simulation);

    const after = simulation.snapshot();
    expect(towerIntegrity(after, 0)).toEqual(towerIntegrity(before, 0));
    expect(towerHp(after, 1)).toBeLessThan(towerHp(before, 1));
  });

  it("mirrors the recommended shot for player one without disturbing its own tower", async () => {
    const simulation = await MatterSimulation.create({ seed: 315 });
    expect(simulation.applyCommand(0, { type: "endBuild" }).ok).toBe(true);
    expect(
      simulation.applyCommand(0, {
        type: "craft",
        recipe: { body: "stone", element: "water", modifier: "heavy" },
      }).ok,
    ).toBe(true);
    expect(
      simulation.applyCommand(0, {
        type: "launch",
        angle: LAUNCH_CONFIG.maxAngle,
        power: LAUNCH_CONFIG.minPower,
      }).ok,
    ).toBe(true);
    advanceThroughResolve(simulation);
    expect(simulation.activePlayer).toBe(1);

    const before = simulation.snapshot();
    launchRecommendedShot(simulation, 1);
    advanceThroughResolve(simulation);

    const after = simulation.snapshot();
    expect(towerIntegrity(after, 1)).toEqual(towerIntegrity(before, 1));
    expect(towerHp(after, 0)).toBeLessThan(towerHp(before, 0));
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
