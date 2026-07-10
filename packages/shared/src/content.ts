import materialCatalog from "../../../content/materials/catalog.json" with { type: "json" };
import projectileCatalog from "../../../content/projectiles/catalog.json" with { type: "json" };
import type {
  ElementDef,
  ElementId,
  LaunchConfig,
  MaterialDef,
  MaterialId,
  ModifierDef,
  ModifierId,
  ProjectileBodyDef,
  ProjectileBodyId,
} from "./types.js";

export const LAUNCH_CONFIG = projectileCatalog.launchConfig as LaunchConfig;
export const MATERIALS = materialCatalog as MaterialDef[];
export const PROJECTILE_BODIES = projectileCatalog.bodies as ProjectileBodyDef[];
export const ELEMENTS = projectileCatalog.elements as ElementDef[];
export const MODIFIERS = projectileCatalog.modifiers as ModifierDef[];

export const getMaterial = (id: MaterialId): MaterialDef => {
  const value = MATERIALS.find((entry) => entry.id === id);
  if (!value) throw new Error(`Unknown material: ${id}`);
  return value;
};

export const getProjectileBody = (id: ProjectileBodyId): ProjectileBodyDef => {
  const value = PROJECTILE_BODIES.find((entry) => entry.id === id);
  if (!value) throw new Error(`Unknown projectile body: ${id}`);
  return value;
};

export const getElement = (id: ElementId): ElementDef => {
  const value = ELEMENTS.find((entry) => entry.id === id);
  if (!value) throw new Error(`Unknown element: ${id}`);
  return value;
};

export const getModifier = (id: ModifierId): ModifierDef => {
  const value = MODIFIERS.find((entry) => entry.id === id);
  if (!value) throw new Error(`Unknown modifier: ${id}`);
  return value;
};

export function validateContent(): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const material of MATERIALS) {
    if (ids.has(material.id)) errors.push(`Duplicate material id: ${material.id}`);
    ids.add(material.id);
    if (material.maxHp <= 0) errors.push(`${material.id} must have positive HP`);
    if (material.toughness <= 0) errors.push(`${material.id} must have positive toughness`);
    if (!material.impactVfx || !material.breakVfx) errors.push(`${material.id} requires VFX references`);
  }
  if (LAUNCH_CONFIG.positions.length !== 2 || LAUNCH_CONFIG.positions.some((value) => !Number.isFinite(value))) {
    errors.push("Launch config requires one finite launcher position per player");
  }
  if (!Number.isFinite(LAUNCH_CONFIG.height) || LAUNCH_CONFIG.height <= 0) errors.push("Launcher height must be positive");
  if (!(LAUNCH_CONFIG.minAngle < LAUNCH_CONFIG.recommendedAngle && LAUNCH_CONFIG.recommendedAngle < LAUNCH_CONFIG.maxAngle)) {
    errors.push("Recommended launch angle must be inside the legal angle range");
  }
  if (!(LAUNCH_CONFIG.minPower <= LAUNCH_CONFIG.recommendedPower && LAUNCH_CONFIG.recommendedPower <= LAUNCH_CONFIG.maxPower)) {
    errors.push("Recommended launch power must be inside the legal power range");
  }
  if (LAUNCH_CONFIG.baseSpeed <= 0 || LAUNCH_CONFIG.powerSpeed <= 0) errors.push("Launch speed values must be positive");
  if (LAUNCH_CONFIG.maxFlightSeconds <= 0 || LAUNCH_CONFIG.postImpactSeconds <= 0) {
    errors.push("Projectile lifetimes must be positive");
  }
  if (MATERIALS.length < 8) errors.push("The launch catalog requires seven materials plus the core");
  if (ELEMENTS.length < 5) errors.push("The launch catalog requires five elements");
  return errors;
}
