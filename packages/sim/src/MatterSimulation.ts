import RAPIER from "@dimforge/rapier2d-compat";
import {
  FORTIFICATION_CONFIG,
  getMaterial,
  getGuardianTier,
  getModifier,
  getProjectileBody,
  LAUNCH_CONFIG,
  type BlockRuntimeState,
  type ElementId,
  type LoggedCommand,
  type MatchPhase,
  type MatchSnapshot,
  type MaterialId,
  type MutationId,
  type PlayerCommand,
  type PlayerId,
  type ProjectileRecipe,
  type ProjectileRuntimeState,
  type ReplayData,
  type SimEvent,
} from "@matter-siege/shared";
import { SeededRandom } from "./rng.js";

export const SIM_VERSION = "sim-0.3.0";
export const SIM_HZ = 30;
const DT = 1 / SIM_HZ;
const TOWER_CENTERS: [number, number] = [-8, 8];

let rapierInitialization: Promise<void> | undefined;

interface InternalBlock {
  state: BlockRuntimeState;
  body: RAPIER.RigidBody;
}

interface InternalProjectile {
  state: ProjectileRuntimeState;
  body: RAPIER.RigidBody;
  bornTick: number;
  firstImpactTick: number | null;
  hits: Set<string>;
  impacted: boolean;
}

export interface SimulationOptions {
  seed?: number;
  labMode?: boolean;
}

export interface CommandResult {
  ok: boolean;
  error?: string;
}

const DEFAULT_RECIPE: ProjectileRecipe = {
  body: "stone",
  element: "fire",
  modifier: "heavy",
};

const round = (value: number): number => Math.round(value * 10_000) / 10_000;
const roundStat = (value: number): number => Math.round(value * 100) / 100;
const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

export class MatterSimulation {
  readonly seed: number;
  readonly labMode: boolean;

  private readonly world: RAPIER.World;
  private readonly random: SeededRandom;
  private readonly blocks = new Map<string, InternalBlock>();
  private readonly projectiles = new Map<string, InternalProjectile>();
  private readonly events: SimEvent[] = [];
  private readonly commands: LoggedCommand[] = [];
  private readonly initialTowerMass: [number, number] = [0, 0];
  private readonly selectedRecipes: [ProjectileRecipe, ProjectileRecipe] = [
    { ...DEFAULT_RECIPE },
    { body: "metal", element: "lightning", modifier: "heavy" },
  ];

  private tickValue = 0;
  private phaseValue: MatchPhase = "build";
  private activePlayerValue: PlayerId = 0;
  private buildPointsValue = 2;
  private turnValue = 1;
  private winnerValue: PlayerId | null = null;
  private projectileSequence = 0;

  private constructor(world: RAPIER.World, options: SimulationOptions) {
    this.world = world;
    this.seed = options.seed ?? 918_273;
    this.labMode = options.labMode ?? false;
    this.random = new SeededRandom(this.seed);
    this.createArena();
  }

  static async create(options: SimulationOptions = {}): Promise<MatterSimulation> {
    rapierInitialization ??= RAPIER.init({});
    await rapierInitialization;
    return new MatterSimulation(new RAPIER.World({ x: 0, y: -9.81 }), options);
  }

  get phase(): MatchPhase {
    return this.phaseValue;
  }

  get activePlayer(): PlayerId {
    return this.activePlayerValue;
  }

  get tick(): number {
    return this.tickValue;
  }

  applyCommand(playerId: PlayerId, command: PlayerCommand): CommandResult {
    if (this.phaseValue === "finished") return { ok: false, error: "The match has ended" };
    if (playerId !== this.activePlayerValue) return { ok: false, error: "It is not this player's turn" };

    let result: CommandResult;
    switch (command.type) {
      case "mutate":
        result = this.mutateBlock(playerId, command.blockId, command.mutation);
        break;
      case "upgradeGuardian":
        result = this.upgradeGuardian(playerId);
        break;
      case "endBuild":
        result = this.endBuild();
        break;
      case "craft":
        result = this.craft(playerId, command.recipe);
        break;
      case "launch":
        result = this.launch(playerId, command.angle, command.power);
        break;
      default: {
        const exhaustive: never = command;
        return { ok: false, error: `Unknown command: ${String(exhaustive)}` };
      }
    }

    if (result.ok) {
      this.commands.push({ tick: this.tickValue, playerId, command: structuredClone(command) });
    }
    return result;
  }

  step(steps = 1): void {
    for (let index = 0; index < steps; index += 1) this.stepOnce();
  }

  snapshot(): MatchSnapshot {
    const blocks = [...this.blocks.values()]
      .map(({ state }) => ({
        ...state,
        hp: roundStat(state.hp),
        maxHp: roundStat(state.maxHp),
        temperature: roundStat(state.temperature),
        wetness: roundStat(state.wetness),
        charge: roundStat(state.charge),
        corrosion: roundStat(state.corrosion),
        brittleness: roundStat(state.brittleness),
        position: { x: round(state.position.x), y: round(state.position.y) },
        rotation: round(state.rotation),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const projectiles = [...this.projectiles.values()]
      .map(({ state }) => ({
        ...state,
        position: { x: round(state.position.x), y: round(state.position.y) },
        velocity: { x: round(state.velocity.x), y: round(state.velocity.y) },
        rotation: round(state.rotation),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    return {
      version: SIM_VERSION,
      seed: this.seed,
      tick: this.tickValue,
      phase: this.phaseValue,
      activePlayer: this.activePlayerValue,
      buildPoints: this.buildPointsValue,
      turn: this.turnValue,
      winner: this.winnerValue,
      blocks,
      projectiles,
      coreHealth: [this.coreHealth(0), this.coreHealth(1)],
      selectedRecipes: [structuredClone(this.selectedRecipes[0]), structuredClone(this.selectedRecipes[1])],
    };
  }

  drainEvents(): SimEvent[] {
    return this.events.splice(0, this.events.length);
  }

  exportReplay(): ReplayData {
    return {
      version: SIM_VERSION,
      seed: this.seed,
      labMode: this.labMode,
      commands: structuredClone(this.commands),
    };
  }

  private createArena(): void {
    const groundBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.35));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.35).setFriction(1.1), groundBody);

    this.createTower(0);
    this.createTower(1);

    for (let index = 0; index < 150; index += 1) this.world.step();
    for (const block of this.blocks.values()) {
      this.syncBlockTransform(block);
      block.body.sleep();
    }
  }

  private createTower(owner: PlayerId): void {
    const center = TOWER_CENTERS[owner];
    const columns = [-1.74, -0.58, 0.58, 1.74];
    const palette: MaterialId[] = ["stone", "wood", "clay", "glass", "metal", "ice", "hay"];
    let blockIndex = 0;

    for (let row = 0; row < 6; row += 1) {
      for (let column = 0; column < columns.length; column += 1) {
        if (row === 5 && (column === 0 || column === 3)) continue;
        const material: MaterialId = row === 0 ? "stone" : palette[(row * 2 + column) % palette.length] ?? "wood";
        const width = 1.06;
        const height = 0.68;
        const x = center + (columns[column] ?? 0);
        const y = 0.36 + row * 0.71;
        this.createBlock(`p${owner}_b${blockIndex++}`, owner, material, "block", x, y, width, height);
      }
    }

    // The Regent is a physical rooftop objective. Destroy it or drop it to the arena floor to win.
    this.createBlock(`p${owner}_core`, owner, "core", "core", center, 4.72, 1.18, 0.92);
  }

  private createBlock(
    id: string,
    owner: PlayerId,
    material: MaterialId,
    kind: "block" | "core",
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const definition = getMaterial(material);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y)
        .setLinearDamping(0.22)
        .setAngularDamping(0.56)
        .setCanSleep(true),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(width / 2, height / 2)
        .setDensity(Math.max(0.2, definition.density))
        .setFriction(definition.friction)
        .setRestitution(definition.elasticity),
      body,
    );
    const state: BlockRuntimeState = {
      id,
      owner,
      material,
      kind,
      position: { x, y },
      rotation: 0,
      size: { x: width, y: height },
      hp: definition.maxHp,
      maxHp: definition.maxHp,
      upgradeLevel: 1,
      temperature: 20,
      wetness: 0,
      charge: 0,
      corrosion: 0,
      brittleness: definition.brittleness,
      burning: false,
      frozen: false,
      oiled: false,
      reinforced: false,
      broken: false,
    };
    this.blocks.set(id, { state, body });
    this.initialTowerMass[owner] += definition.density * width * height;
  }

  private mutateBlock(playerId: PlayerId, blockId: string, mutation: MutationId): CommandResult {
    if (this.phaseValue !== "build") return { ok: false, error: "Mutations are only available in build phase" };
    if (this.buildPointsValue <= 0) return { ok: false, error: "No build actions remain" };
    const block = this.blocks.get(blockId);
    if (!block || block.state.broken) return { ok: false, error: "That block is unavailable" };
    if (block.state.owner !== playerId) return { ok: false, error: "You can only mutate your own tower" };
    if (block.state.kind === "core") return { ok: false, error: "The aether core rejects direct mutations" };

    switch (mutation) {
      case "reinforce":
        if (block.state.upgradeLevel >= FORTIFICATION_CONFIG.block.maxLevel) {
          return { ok: false, error: "That block is already at maximum level" };
        }
        block.state.upgradeLevel += 1;
        block.state.maxHp += FORTIFICATION_CONFIG.block.hpBonusPerLevel;
        block.state.hp = Math.min(block.state.maxHp, block.state.hp + FORTIFICATION_CONFIG.block.repairPerLevel);
        block.state.reinforced = true;
        break;
      case "wet":
        block.state.wetness = 1;
        if (block.state.burning) this.extinguish(block);
        break;
      case "frozen":
        block.state.frozen = true;
        block.state.temperature = -20;
        block.state.brittleness = Math.min(1.7, block.state.brittleness + 0.38);
        break;
      case "oiled":
        block.state.oiled = true;
        break;
    }
    this.buildPointsValue -= 1;
    return { ok: true };
  }

  private upgradeGuardian(playerId: PlayerId): CommandResult {
    if (this.phaseValue !== "build") return { ok: false, error: "Guardian upgrades are only available while fortifying" };
    if (this.buildPointsValue <= 0) return { ok: false, error: "No build actions remain" };
    const guardian = this.blocks.get(`p${playerId}_core`);
    if (!guardian || guardian.state.broken) return { ok: false, error: "Your Aether Regent is unavailable" };
    const maximumLevel = FORTIFICATION_CONFIG.guardian.tiers.length;
    if (guardian.state.upgradeLevel >= maximumLevel) return { ok: false, error: "Your Aether Regent is fully ascended" };

    const nextTier = getGuardianTier(guardian.state.upgradeLevel + 1);
    guardian.state.upgradeLevel = nextTier.level;
    guardian.state.maxHp += nextTier.maxHpBonus;
    guardian.state.hp = Math.min(guardian.state.maxHp, guardian.state.hp + nextTier.maxHpBonus);
    this.buildPointsValue -= 1;
    return { ok: true };
  }

  private endBuild(): CommandResult {
    if (this.phaseValue !== "build") return { ok: false, error: "Build phase is not active" };
    this.setPhase("craft");
    return { ok: true };
  }

  private craft(playerId: PlayerId, recipe: ProjectileRecipe): CommandResult {
    if (this.phaseValue !== "craft") return { ok: false, error: "The forge is not ready" };
    try {
      getProjectileBody(recipe.body);
      getModifier(recipe.modifier);
      if (!["fire", "water", "ice", "acid", "lightning"].includes(recipe.element)) throw new Error("element");
    } catch {
      return { ok: false, error: "Illegal projectile recipe" };
    }
    this.selectedRecipes[playerId] = structuredClone(recipe);
    this.setPhase("aim");
    return { ok: true };
  }

  private launch(playerId: PlayerId, angle: number, power: number): CommandResult {
    if (this.phaseValue !== "aim") return { ok: false, error: "Aiming is not active" };
    if (!Number.isFinite(angle) || angle < LAUNCH_CONFIG.minAngle || angle > LAUNCH_CONFIG.maxAngle) {
      return { ok: false, error: "Launch angle is outside the legal arc" };
    }
    if (!Number.isFinite(power) || power < LAUNCH_CONFIG.minPower || power > LAUNCH_CONFIG.maxPower) {
      return { ok: false, error: "Launch power is outside the legal range" };
    }

    const recipe = this.selectedRecipes[playerId];
    const modifier = getModifier(recipe.modifier);
    const direction = playerId === 0 ? 1 : -1;
    const baseRadians = (angle * Math.PI) / 180;
    for (let index = 0; index < modifier.projectileCount; index += 1) {
      const spread = modifier.projectileCount === 1 ? 0 : (index - 1) * 0.075;
      this.spawnProjectile(playerId, recipe, baseRadians + spread, power, direction, index);
    }
    this.setPhase("resolve");
    return { ok: true };
  }

  private spawnProjectile(
    owner: PlayerId,
    recipe: ProjectileRecipe,
    radians: number,
    power: number,
    direction: number,
    spreadIndex: number,
  ): void {
    const bodyDef = getProjectileBody(recipe.body);
    const modifier = getModifier(recipe.modifier);
    const speed = (LAUNCH_CONFIG.baseSpeed + power * LAUNCH_CONFIG.powerSpeed) * modifier.powerScale;
    const x = LAUNCH_CONFIG.positions[owner];
    const y = LAUNCH_CONFIG.height + spreadIndex * 0.03;
    const rigidBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y)
        .setLinvel(Math.cos(radians) * speed * direction, Math.sin(radians) * speed)
        .setCcdEnabled(true)
        .setLinearDamping(recipe.modifier === "sticky" ? 0.2 : 0.035)
        .setAngularDamping(0.05),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(bodyDef.radius)
        .setDensity(bodyDef.mass * 1.8)
        .setFriction(recipe.modifier === "sticky" ? 1.2 : 0.36)
        .setRestitution(recipe.body === "glass" ? 0.42 : 0.16),
      rigidBody,
    );
    rigidBody.setAngvel(direction * speed * 1.8, true);
    const id = `shot_${this.tickValue}_${this.projectileSequence++}`;
    this.projectiles.set(id, {
      state: {
        id,
        owner,
        recipe: structuredClone(recipe),
        position: { x, y },
        velocity: { x: Math.cos(radians) * speed * direction, y: Math.sin(radians) * speed },
        rotation: 0,
        radius: bodyDef.radius,
      },
      body: rigidBody,
      bornTick: this.tickValue,
      firstImpactTick: null,
      hits: new Set(),
      impacted: false,
    });
  }

  private stepOnce(): void {
    this.world.step();
    this.tickValue += 1;

    for (const block of this.blocks.values()) this.syncBlockTransform(block);
    for (const projectile of [...this.projectiles.values()]) {
      this.syncProjectileTransform(projectile);
      if (!projectile.impacted) this.findProjectileImpact(projectile);
      this.expireProjectileIfNeeded(projectile);
    }

    this.updateStatuses();
    this.checkGuardianFloorDefeat();
    this.removeBrokenBlocks();
    this.checkCollapseWin();

    if (this.phaseValue === "resolve" && this.projectiles.size === 0 && this.winnerValue === null) {
      this.beginNextTurn();
    }
  }

  private syncBlockTransform(block: InternalBlock): void {
    const translation = block.body.translation();
    block.state.position.x = translation.x;
    block.state.position.y = translation.y;
    block.state.rotation = block.body.rotation();
  }

  private syncProjectileTransform(projectile: InternalProjectile): void {
    const translation = projectile.body.translation();
    const velocity = projectile.body.linvel();
    projectile.state.position.x = translation.x;
    projectile.state.position.y = translation.y;
    projectile.state.velocity.x = velocity.x;
    projectile.state.velocity.y = velocity.y;
    projectile.state.rotation = projectile.body.rotation();
  }

  private findProjectileImpact(projectile: InternalProjectile): void {
    for (const block of this.blocks.values()) {
      if (block.state.owner === projectile.state.owner || block.state.broken || projectile.hits.has(block.state.id)) continue;
      const dx = Math.abs(projectile.state.position.x - block.state.position.x);
      const dy = Math.abs(projectile.state.position.y - block.state.position.y);
      if (dx > block.state.size.x / 2 + projectile.state.radius + 0.1) continue;
      if (dy > block.state.size.y / 2 + projectile.state.radius + 0.1) continue;
      projectile.hits.add(block.state.id);
      projectile.firstImpactTick ??= this.tickValue;
      this.resolveImpact(projectile, block);
      if (projectile.state.recipe.modifier !== "heavy") projectile.impacted = true;
      if (projectile.state.recipe.modifier === "sticky") {
        projectile.body.setLinvel({ x: 0, y: 0 }, true);
        projectile.body.setAngvel(0, true);
        projectile.body.setGravityScale(0, true);
      }
      return;
    }
  }

  private resolveImpact(projectile: InternalProjectile, block: InternalBlock): void {
    const bodyDef = getProjectileBody(projectile.state.recipe.body);
    const modifier = getModifier(projectile.state.recipe.modifier);
    const material = getMaterial(block.state.material);
    const velocity = projectile.body.linvel();
    const speed = Math.max(3, Math.hypot(velocity.x, velocity.y));
    const brittleMultiplier = 1 + block.state.brittleness * (projectile.state.recipe.element === "ice" ? 0.18 : 0.08);
    let damage = (speed * 2.15 * bodyDef.damageScale * modifier.damageScale * brittleMultiplier) / material.toughness;

    switch (projectile.state.recipe.element) {
      case "fire":
        damage *= 0.76;
        block.state.temperature += 92;
        if ((material.flammability > 0.2 || block.state.oiled) && block.state.wetness < 0.48) this.ignite(block);
        if (block.state.frozen) damage *= 1.55;
        break;
      case "water":
        damage *= 0.66;
        block.state.wetness = Math.min(1.5, block.state.wetness + 0.92);
        block.state.temperature -= 55;
        if (block.state.burning) this.extinguish(block);
        if (block.state.material === "clay") damage += 18;
        break;
      case "ice":
        damage *= 0.74;
        block.state.frozen = true;
        block.state.temperature = -25;
        block.state.brittleness = Math.min(1.8, block.state.brittleness + 0.46);
        break;
      case "acid":
        damage *= 0.64;
        block.state.corrosion = Math.min(2, block.state.corrosion + 0.75);
        damage += (1 - material.corrosionResistance) * 25;
        break;
      case "lightning":
        damage *= 0.54 + material.conductivity * 0.64;
        block.state.charge = Math.min(2, block.state.charge + 1.1);
        this.chainLightning(block, projectile.state.owner);
        break;
    }

    if (block.state.kind === "core") {
      damage *= 1 - getGuardianTier(block.state.upgradeLevel).directDamageReduction;
    }

    block.state.hp -= damage;
    const direction = Math.sign(velocity.x) || (projectile.state.owner === 0 ? 1 : -1);
    block.body.wakeUp();
    block.body.applyImpulse(
      { x: direction * Math.min(6.5, speed * bodyDef.mass * 0.18), y: Math.min(3.2, Math.abs(velocity.y) * 0.12 + 0.45) },
      true,
    );
    this.events.push({
      type: "impact",
      tick: this.tickValue,
      position: { ...block.state.position },
      element: projectile.state.recipe.element,
      impulse: speed * bodyDef.mass,
      material: block.state.material,
    });
  }

  private chainLightning(origin: InternalBlock, projectileOwner: PlayerId): void {
    const candidates = [...this.blocks.values()]
      .filter((candidate) => {
        if (candidate === origin || candidate.state.owner === projectileOwner || candidate.state.broken) return false;
        const conductive = getMaterial(candidate.state.material).conductivity;
        return conductive > 0.22 && distance(origin.state.position, candidate.state.position) < 2.15;
      })
      .sort((a, b) => distance(origin.state.position, a.state.position) - distance(origin.state.position, b.state.position))
      .slice(0, 3);

    let from = origin;
    for (const candidate of candidates) {
      const conductivity = getMaterial(candidate.state.material).conductivity;
      candidate.state.charge = Math.min(2, candidate.state.charge + 0.75);
      candidate.state.hp -= 7 + conductivity * 11;
      candidate.body.wakeUp();
      candidate.body.applyImpulse({ x: projectileOwner === 0 ? 0.55 : -0.55, y: 0.35 }, true);
      this.events.push({ type: "arc", tick: this.tickValue, from: { ...from.state.position }, to: { ...candidate.state.position } });
      from = candidate;
    }
  }

  private updateStatuses(): void {
    for (const block of this.blocks.values()) {
      const material = getMaterial(block.state.material);
      block.state.wetness = Math.max(0, block.state.wetness - DT * 0.018);
      block.state.charge = Math.max(0, block.state.charge - DT * 0.24);
      block.state.temperature += (20 - block.state.temperature) * DT * 0.08;
      if (block.state.corrosion > 0.02) {
        block.state.hp -= block.state.corrosion * (1 - material.corrosionResistance) * DT * 5.5;
        block.state.corrosion = Math.max(0, block.state.corrosion - DT * 0.025);
      }
      if (block.state.burning) {
        if (block.state.wetness > 0.58) {
          this.extinguish(block);
        } else {
          const oilBoost = block.state.oiled ? 1.9 : 1;
          block.state.hp -= material.burnRate * Math.max(0.25, material.flammability) * oilBoost * DT * 7.5;
          block.state.temperature = Math.max(block.state.temperature, 185);
          if (this.tickValue % 24 === 0) this.spreadFire(block);
        }
      }
      if (block.state.frozen && block.state.temperature > 6) {
        block.state.frozen = false;
        block.state.brittleness = Math.max(material.brittleness, block.state.brittleness - 0.32);
      }
    }
  }

  private spreadFire(source: InternalBlock): void {
    const neighbors = [...this.blocks.values()].filter((candidate) => {
      if (candidate.state.broken || candidate.state.burning || candidate.state.wetness > 0.45) return false;
      const targetMaterial = getMaterial(candidate.state.material);
      return (targetMaterial.flammability > 0.3 || candidate.state.oiled) && distance(source.state.position, candidate.state.position) < 1.42;
    });
    for (const neighbor of neighbors) {
      const chance = (getMaterial(neighbor.state.material).flammability + (neighbor.state.oiled ? 0.5 : 0)) * 0.42;
      if (this.random.next() < chance) this.ignite(neighbor);
    }
  }

  private ignite(block: InternalBlock): void {
    if (block.state.burning) return;
    block.state.burning = true;
    this.events.push({ type: "ignite", tick: this.tickValue, position: { ...block.state.position }, blockId: block.state.id });
  }

  private extinguish(block: InternalBlock): void {
    if (!block.state.burning) return;
    block.state.burning = false;
    this.events.push({ type: "extinguish", tick: this.tickValue, position: { ...block.state.position }, blockId: block.state.id });
  }

  private removeBrokenBlocks(): void {
    for (const [id, block] of [...this.blocks.entries()]) {
      if (block.state.hp > 0 && block.state.position.y > -3 && Math.abs(block.state.position.x) < 22) continue;
      block.state.broken = true;
      this.events.push({
        type: "break",
        tick: this.tickValue,
        position: { ...block.state.position },
        material: block.state.material,
        blockId: id,
      });
      if (block.state.kind === "core" && this.winnerValue === null && !this.labMode) this.finish(block.state.owner === 0 ? 1 : 0);
      this.world.removeRigidBody(block.body);
      this.blocks.delete(id);
    }
  }

  private expireProjectileIfNeeded(projectile: InternalProjectile): void {
    const age = this.tickValue - projectile.bornTick;
    const position = projectile.body.translation();
    const speed = Math.hypot(projectile.body.linvel().x, projectile.body.linvel().y);
    const maxFlightTicks = Math.ceil(SIM_HZ * LAUNCH_CONFIG.maxFlightSeconds);
    const postImpactTicks = Math.ceil(SIM_HZ * LAUNCH_CONFIG.postImpactSeconds);
    const flightExpired = projectile.firstImpactTick === null && age >= maxFlightTicks;
    const impactSettled =
      projectile.firstImpactTick !== null && this.tickValue - projectile.firstImpactTick >= postImpactTicks;
    const stoppedMiss = projectile.firstImpactTick === null && age > 45 && speed < 0.38;
    if (flightExpired || impactSettled || position.y < -2 || Math.abs(position.x) > 21 || stoppedMiss) {
      this.world.removeRigidBody(projectile.body);
      this.projectiles.delete(projectile.state.id);
    }
  }

  private checkCollapseWin(): void {
    if (this.labMode || this.winnerValue !== null) return;
    for (const owner of [0, 1] as const) {
      let mass = 0;
      for (const block of this.blocks.values()) {
        if (block.state.owner !== owner) continue;
        const material = getMaterial(block.state.material);
        mass += material.density * block.state.size.x * block.state.size.y;
      }
      if (mass < this.initialTowerMass[owner] * 0.3) {
        this.finish(owner === 0 ? 1 : 0);
        return;
      }
    }
  }

  private checkGuardianFloorDefeat(): void {
    if (this.labMode || this.winnerValue !== null) return;
    for (const owner of [0, 1] as const) {
      const guardian = this.blocks.get(`p${owner}_core`);
      if (!guardian || guardian.state.broken) continue;
      const floorContactY = guardian.state.size.y / 2 + FORTIFICATION_CONFIG.guardian.floorMargin;
      if (guardian.state.position.y <= floorContactY) {
        this.finish(owner === 0 ? 1 : 0);
        return;
      }
    }
  }

  private coreHealth(owner: PlayerId): number {
    const core = this.blocks.get(`p${owner}_core`);
    if (!core) return 0;
    return Math.max(0, Math.round((core.state.hp / core.state.maxHp) * 100));
  }

  private beginNextTurn(): void {
    this.activePlayerValue = this.labMode ? 0 : this.activePlayerValue === 0 ? 1 : 0;
    this.turnValue += 1;
    this.buildPointsValue = 2;
    this.pulseGuardian(this.activePlayerValue);
    this.setPhase("build");
  }

  private pulseGuardian(owner: PlayerId): void {
    const guardian = this.blocks.get(`p${owner}_core`);
    if (!guardian) return;
    const amount = getGuardianTier(guardian.state.upgradeLevel).repairPerTurn;
    if (amount <= 0) return;
    const target = [...this.blocks.values()]
      .filter((block) => block.state.owner === owner && block.state.kind === "block" && block.state.hp < block.state.maxHp)
      .sort((a, b) => (b.state.maxHp - b.state.hp) - (a.state.maxHp - a.state.hp) || a.state.id.localeCompare(b.state.id))[0];
    if (!target) return;
    const repaired = Math.min(amount, target.state.maxHp - target.state.hp);
    target.state.hp += repaired;
    this.events.push({
      type: "guardianPulse",
      tick: this.tickValue,
      position: { ...target.state.position },
      guardianId: guardian.state.id,
      targetBlockId: target.state.id,
      amount: roundStat(repaired),
    });
  }

  private finish(winner: PlayerId): void {
    this.winnerValue = winner;
    this.phaseValue = "finished";
    for (const projectile of this.projectiles.values()) this.world.removeRigidBody(projectile.body);
    this.projectiles.clear();
    this.events.push({ type: "win", tick: this.tickValue, winner });
  }

  private setPhase(phase: MatchPhase): void {
    this.phaseValue = phase;
    this.events.push({ type: "phase", tick: this.tickValue, phase, activePlayer: this.activePlayerValue });
  }
}
