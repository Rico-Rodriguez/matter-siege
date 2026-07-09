import type { MatchSnapshot, ReplayData } from "@matter-siege/shared";
import { MatterSimulation, SIM_HZ } from "./MatterSimulation.js";

export async function simulateReplay(replay: ReplayData, tailSeconds = 2): Promise<MatchSnapshot> {
  const simulation = await MatterSimulation.create({ seed: replay.seed, labMode: replay.labMode });
  const commands = [...replay.commands].sort((a, b) => a.tick - b.tick);
  const finalCommandTick = commands.at(-1)?.tick ?? 0;
  const finalTick = finalCommandTick + tailSeconds * SIM_HZ;
  let commandIndex = 0;

  while (simulation.tick < finalTick) {
    while (commands[commandIndex]?.tick === simulation.tick) {
      const entry = commands[commandIndex];
      if (entry) simulation.applyCommand(entry.playerId, entry.command);
      commandIndex += 1;
    }
    simulation.step();
  }
  return simulation.snapshot();
}
