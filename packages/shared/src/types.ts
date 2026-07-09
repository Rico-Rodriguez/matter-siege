export type PlayerId = 0 | 1;
export type MatchPhase = "build" | "craft" | "aim" | "resolve" | "finished";
export type MaterialId = "hay" | "wood" | "clay" | "stone" | "glass" | "metal" | "ice" | "core";
export type ProjectileBodyId = "stone" | "glass" | "metal";
export type ElementId = "fire" | "water" | "ice" | "acid" | "lightning";
export type ModifierId = "heavy" | "split" | "sticky";
export type MutationId = "reinforce" | "wet" | "frozen" | "oiled";

export interface MaterialDef {
  id: MaterialId;
  displayName: string;
  density: number;
  maxHp: number;
  toughness: number;
  brittleness: number;
  elasticity: number;
  friction: number;
  flammability: number;
  burnRate: number;
  heatResistance: number;
  waterAbsorption: number;
  conductivity: number;
  corrosionResistance: number;
  color: string;
  roughness: number;
  metallic: number;
  impactVfx: string;
  breakVfx: string;
}

export interface ProjectileBodyDef {
  id: ProjectileBodyId;
  displayName: string;
  mass: number;
  radius: number;
  damageScale: number;
  color: string;
}

export interface ElementDef {
  id: ElementId;
  displayName: string;
  color: string;
  glyph: string;
}

export interface ModifierDef {
  id: ModifierId;
  displayName: string;
  powerScale: number;
  damageScale: number;
  projectileCount: number;
}

export interface ProjectileRecipe {
  body: ProjectileBodyId;
  element: ElementId;
  modifier: ModifierId;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface BlockRuntimeState {
  id: string;
  owner: PlayerId;
  material: MaterialId;
  kind: "block" | "core";
  position: Vec2;
  rotation: number;
  size: Vec2;
  hp: number;
  maxHp: number;
  temperature: number;
  wetness: number;
  charge: number;
  corrosion: number;
  brittleness: number;
  burning: boolean;
  frozen: boolean;
  oiled: boolean;
  reinforced: boolean;
  broken: boolean;
}

export interface ProjectileRuntimeState {
  id: string;
  owner: PlayerId;
  recipe: ProjectileRecipe;
  position: Vec2;
  velocity: Vec2;
  rotation: number;
  radius: number;
}

export interface MatchSnapshot {
  version: string;
  seed: number;
  tick: number;
  phase: MatchPhase;
  activePlayer: PlayerId;
  buildPoints: number;
  turn: number;
  winner: PlayerId | null;
  blocks: BlockRuntimeState[];
  projectiles: ProjectileRuntimeState[];
  coreHealth: [number, number];
  selectedRecipes: [ProjectileRecipe, ProjectileRecipe];
}

export type SimEvent =
  | { type: "impact"; tick: number; position: Vec2; element: ElementId; impulse: number; material: MaterialId }
  | { type: "break"; tick: number; position: Vec2; material: MaterialId; blockId: string }
  | { type: "ignite"; tick: number; position: Vec2; blockId: string }
  | { type: "extinguish"; tick: number; position: Vec2; blockId: string }
  | { type: "arc"; tick: number; from: Vec2; to: Vec2 }
  | { type: "phase"; tick: number; phase: MatchPhase; activePlayer: PlayerId }
  | { type: "win"; tick: number; winner: PlayerId };

export type PlayerCommand =
  | { type: "mutate"; blockId: string; mutation: MutationId }
  | { type: "endBuild" }
  | { type: "craft"; recipe: ProjectileRecipe }
  | { type: "launch"; angle: number; power: number };

export interface LoggedCommand {
  tick: number;
  playerId: PlayerId;
  command: PlayerCommand;
}

export interface ReplayData {
  version: string;
  seed: number;
  labMode: boolean;
  commands: LoggedCommand[];
}

