import type { PlayerCommand, ProjectileRecipe } from "@matter-siege/shared";

const recipes = new Set(["stone", "glass", "metal"]);
const elements = new Set(["fire", "water", "ice", "acid", "lightning"]);
const modifiers = new Set(["heavy", "split", "sticky"]);
const mutations = new Set(["reinforce", "wet", "frozen", "oiled"]);

function isRecipe(value: unknown): value is ProjectileRecipe {
  if (!value || typeof value !== "object") return false;
  const recipe = value as Record<string, unknown>;
  return recipes.has(String(recipe.body)) && elements.has(String(recipe.element)) && modifiers.has(String(recipe.modifier));
}

export function isPlayerCommand(value: unknown): value is PlayerCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case "endBuild":
      return true;
    case "upgradeGuardian":
      return Object.keys(command).length === 1;
    case "mutate":
      return typeof command.blockId === "string" && command.blockId.length < 80 && mutations.has(String(command.mutation));
    case "craft":
      return isRecipe(command.recipe);
    case "launch":
      return typeof command.angle === "number" && typeof command.power === "number";
    default:
      return false;
  }
}
