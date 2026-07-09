import {
  AbstractEngine,
  Color3,
  Color4,
  DefaultRenderingPipeline,
  DirectionalLight,
  DynamicTexture,
  Engine,
  FreeCamera,
  GlowLayer,
  HemisphericLight,
  Matrix,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  PBRMaterial,
  Plane,
  PointLight,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  TransformNode,
  Vector3,
  WebGPUEngine,
} from "@babylonjs/core";
import {
  ELEMENTS,
  getElement,
  getMaterial,
  getModifier,
  getProjectileBody,
  type BlockRuntimeState,
  type ElementId,
  type MatchSnapshot,
  type MaterialId,
  type PlayerId,
  type ProjectileRecipe,
  type ProjectileRuntimeState,
  type SimEvent,
} from "@matter-siege/shared";

interface VisualBlock {
  root: TransformNode;
  meshes: Mesh[];
  material: PBRMaterial;
  braceAdded: boolean;
}

interface VisualProjectile {
  root: TransformNode;
  meshes: Mesh[];
  light: PointLight;
}

interface DebrisPiece {
  mesh: Mesh;
  velocity: Vector3;
  spin: Vector3;
  life: number;
}

const LAUNCHER_X: [number, number] = [-13.4, 13.4];

const hex = (value: string): Color3 => Color3.FromHexString(value);
const elementColor = (element: ElementId): Color3 => hex(getElement(element).color);

export class SceneWorld {
  rendererLabel = "WEBGL2 FALLBACK";

  private engine!: AbstractEngine;
  private scene!: Scene;
  private camera!: FreeCamera;
  private shadow!: ShadowGenerator;
  private glow!: GlowLayer;
  private readonly cameraBase = new Vector3(0, 7.3, -28);
  private readonly cameraTarget = new Vector3(0, 3.05, 0);
  private readonly blocks = new Map<string, VisualBlock>();
  private readonly projectiles = new Map<string, VisualProjectile>();
  private readonly materials = new Map<MaterialId, PBRMaterial>();
  private readonly burning = new Map<string, ParticleSystem>();
  private readonly coreLights = new Map<string, PointLight>();
  private readonly debris: DebrisPiece[] = [];
  private readonly aimDots: Mesh[] = [];
  private particleTexture!: DynamicTexture;
  private aimMaterial!: StandardMaterial;
  private frameCallback: (deltaSeconds: number) => void = () => undefined;
  private shake = 0;
  private elapsed = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  async initialize(): Promise<void> {
    const canTryWebGpu = "gpu" in navigator;
    if (canTryWebGpu && (await WebGPUEngine.IsSupportedAsync)) {
      try {
        const webGpu = new WebGPUEngine(this.canvas, { antialias: true, adaptToDeviceRatio: true });
        await webGpu.initAsync();
        this.engine = webGpu;
        this.rendererLabel = "WEBGPU · HIGH FIDELITY";
      } catch {
        this.engine = new Engine(this.canvas, true, { preserveDrawingBuffer: false, stencil: true, adaptToDeviceRatio: true });
        this.rendererLabel = "WEBGL2 · GPU FALLBACK";
      }
    } else {
      this.engine = new Engine(this.canvas, true, { preserveDrawingBuffer: false, stencil: true, adaptToDeviceRatio: true });
      this.rendererLabel = "WEBGL2 · COMPATIBILITY";
    }

    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.018, 0.035, 0.038, 1);
    this.scene.ambientColor = new Color3(0.08, 0.11, 0.11);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.scene.fogDensity = 0.012;
    this.scene.fogColor = new Color3(0.025, 0.055, 0.058);
    this.scene.skipPointerMovePicking = true;

    this.camera = new FreeCamera("sideView", this.cameraBase.clone(), this.scene);
    this.camera.setTarget(this.cameraTarget);
    this.camera.fov = 0.56;
    this.camera.minZ = 0.1;
    this.camera.maxZ = 120;

    this.createLights();
    this.createTexturesAndMaterials();
    this.createDiorama();
    this.createLaunchers();
    this.createAimDots();
    this.createPostProcessing();
    this.createAmbientDust();

    this.engine.runRenderLoop(() => {
      const delta = Math.min(0.05, this.engine.getDeltaTime() / 1000);
      this.elapsed += delta;
      this.frameCallback(delta);
      this.updateVisuals(delta);
      this.scene.render();
    });
    window.addEventListener("resize", () => this.engine.resize());
  }

  setFrameCallback(callback: (deltaSeconds: number) => void): void {
    this.frameCallback = callback;
  }

  sync(snapshot: MatchSnapshot): void {
    const activeBlockIds = new Set(snapshot.blocks.map((block) => block.id));
    for (const block of snapshot.blocks) this.syncBlock(block);
    for (const [id, visual] of this.blocks) {
      if (activeBlockIds.has(id)) continue;
      this.stopBurning(id);
      this.coreLights.get(id)?.dispose();
      this.coreLights.delete(id);
      visual.root.dispose(false, true);
      this.blocks.delete(id);
    }

    const activeProjectileIds = new Set(snapshot.projectiles.map((projectile) => projectile.id));
    for (const projectile of snapshot.projectiles) this.syncProjectile(projectile);
    for (const [id, visual] of this.projectiles) {
      if (activeProjectileIds.has(id)) continue;
      visual.light.dispose();
      visual.root.dispose(false, true);
      this.projectiles.delete(id);
    }
  }

  processEvents(events: SimEvent[]): void {
    for (const event of events) {
      if (event.type === "impact") {
        this.burst(event.position.x, event.position.y, event.element, Math.min(95, 32 + event.impulse * 1.2));
        this.shake = Math.max(this.shake, Math.min(0.32, event.impulse / 130));
      } else if (event.type === "break") {
        this.breakDebris(event.position.x, event.position.y, event.material);
        this.burst(event.position.x, event.position.y, event.material === "ice" ? "ice" : event.material === "metal" ? "lightning" : "fire", 48);
        this.shake = Math.max(this.shake, 0.2);
      } else if (event.type === "arc") {
        this.drawArc(event.from.x, event.from.y, event.to.x, event.to.y);
      } else if (event.type === "extinguish") {
        this.stopBurning(event.blockId);
        this.steam(event.position.x, event.position.y);
      } else if (event.type === "win") {
        this.shake = 0.48;
      }
    }
  }

  getLauncher(player: PlayerId): { x: number; y: number } {
    return { x: LAUNCHER_X[player], y: 1.05 };
  }

  screenToWorld(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * this.engine.getRenderWidth();
    const y = ((clientY - rect.top) / rect.height) * this.engine.getRenderHeight();
    const ray = this.scene.createPickingRay(x, y, Matrix.Identity(), this.camera, false);
    const hitDistance = ray.intersectsPlane(new Plane(0, 0, 1, 0));
    if (hitDistance === null) return null;
    const point = ray.origin.add(ray.direction.scale(hitDistance));
    return { x: point.x, y: point.y };
  }

  pickBlock(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * this.engine.getRenderWidth();
    const y = ((clientY - rect.top) / rect.height) * this.engine.getRenderHeight();
    const result = this.scene.pick(x, y, (mesh) => typeof mesh.metadata?.blockId === "string", false, this.camera);
    return result?.pickedMesh?.metadata?.blockId ?? null;
  }

  showAim(player: PlayerId, angle: number, power: number, recipe: ProjectileRecipe): void {
    const direction = player === 0 ? 1 : -1;
    const radians = (angle * Math.PI) / 180;
    const modifier = getModifier(recipe.modifier);
    const speed = (9 + power * 15) * modifier.powerScale;
    const velocityX = Math.cos(radians) * speed * direction;
    const velocityY = Math.sin(radians) * speed;
    const origin = this.getLauncher(player);
    this.aimMaterial.emissiveColor = elementColor(recipe.element);
    this.aimMaterial.diffuseColor = elementColor(recipe.element).scale(0.5);

    for (let index = 0; index < this.aimDots.length; index += 1) {
      const t = index * 0.115;
      const y = origin.y + velocityY * t - 4.905 * t * t;
      const dot = this.aimDots[index];
      if (!dot) continue;
      dot.position.set(origin.x + velocityX * t, y, -0.2);
      dot.isVisible = y > 0 && Math.abs(dot.position.x) < 19;
      const scale = 1 - index / (this.aimDots.length * 1.45);
      dot.scaling.setAll(Math.max(0.45, scale));
    }
  }

  clearAim(): void {
    for (const dot of this.aimDots) dot.isVisible = false;
  }

  private createLights(): void {
    const moon = new HemisphericLight("moonFill", new Vector3(-0.3, 1, -0.2), this.scene);
    moon.intensity = 1.12;
    moon.diffuse = new Color3(0.42, 0.58, 0.64);
    moon.groundColor = new Color3(0.08, 0.055, 0.035);
    const key = new DirectionalLight("warmKey", new Vector3(-0.42, -0.8, 0.45), this.scene);
    key.position = new Vector3(5, 13, -9);
    key.diffuse = new Color3(1, 0.74, 0.48);
    key.intensity = 2.6;
    this.shadow = new ShadowGenerator(2048, key);
    this.shadow.useBlurExponentialShadowMap = true;
    this.shadow.blurKernel = 24;
    this.shadow.bias = 0.0004;
    const rim = new PointLight("cyanRim", new Vector3(-1, 6, 3), this.scene);
    rim.diffuse = new Color3(0.25, 0.82, 0.79);
    rim.intensity = 44;
    rim.range = 18;
    for (const side of [-1, 1]) {
      const towerFill = new PointLight(`towerFill_${side}`, new Vector3(side * 8, 5.8, -6), this.scene);
      towerFill.diffuse = side < 0 ? new Color3(0.5, 0.82, 0.75) : new Color3(1, 0.62, 0.38);
      towerFill.intensity = 72;
      towerFill.range = 13;
    }
  }

  private createTexturesAndMaterials(): void {
    this.particleTexture = this.radialTexture("particle", "#ffffff");
    for (const id of ["hay", "wood", "clay", "stone", "glass", "metal", "ice", "core"] as MaterialId[]) {
      const definition = getMaterial(id);
      const material = new PBRMaterial(`pbr_${id}`, this.scene);
      material.albedoColor = hex(definition.color);
      material.roughness = definition.roughness;
      material.metallic = definition.metallic;
      material.albedoTexture = this.patternTexture(id, definition.color);
      material.environmentIntensity = 0.75;
      if (id === "glass" || id === "ice") {
        material.alpha = id === "glass" ? 0.62 : 0.82;
        material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
        material.indexOfRefraction = id === "glass" ? 1.5 : 1.31;
      }
      if (id === "core") {
        material.emissiveColor = new Color3(0.65, 0.28, 0.045);
        material.environmentIntensity = 1.2;
      }
      this.materials.set(id, material);
    }
  }

  private createDiorama(): void {
    const backdropTexture = new DynamicTexture("backdropGradient", { width: 64, height: 512 }, this.scene, false);
    const backdropContext = backdropTexture.getContext();
    const gradient = backdropContext.createLinearGradient(0, 0, 0, 512);
    gradient.addColorStop(0, "#12272c");
    gradient.addColorStop(0.48, "#0b171a");
    gradient.addColorStop(1, "#050b0d");
    backdropContext.fillStyle = gradient;
    backdropContext.fillRect(0, 0, 64, 512);
    backdropTexture.update();
    const backdropMaterial = new StandardMaterial("backdropMaterial", this.scene);
    backdropMaterial.diffuseTexture = backdropTexture;
    backdropMaterial.emissiveColor = new Color3(0.08, 0.11, 0.12);
    backdropMaterial.disableLighting = true;
    const backdrop = MeshBuilder.CreatePlane("backdrop", { width: 48, height: 19 }, this.scene);
    backdrop.position.set(0, 7.1, 6.2);
    backdrop.material = backdropMaterial;

    const baseMaterial = new PBRMaterial("slatePlinth", this.scene);
    baseMaterial.albedoColor = new Color3(0.055, 0.075, 0.073);
    baseMaterial.roughness = 0.72;
    baseMaterial.metallic = 0.12;
    const ground = MeshBuilder.CreateBox("arenaSlab", { width: 40, height: 0.58, depth: 7.2 }, this.scene);
    ground.position.y = -0.3;
    ground.material = baseMaterial;
    ground.receiveShadows = true;
    const lower = MeshBuilder.CreateBox("plinth", { width: 41, height: 0.7, depth: 7.9 }, this.scene);
    lower.position.y = -0.92;
    lower.material = baseMaterial;

    const brass = new PBRMaterial("brassTrim", this.scene);
    brass.albedoColor = new Color3(0.58, 0.37, 0.14);
    brass.metallic = 0.88;
    brass.roughness = 0.28;
    for (const z of [-3.64, 3.64]) {
      const trim = MeshBuilder.CreateBox(`trim_${z}`, { width: 40.5, height: 0.07, depth: 0.08 }, this.scene);
      trim.position.set(0, -0.09, z);
      trim.material = brass;
    }
    for (const x of [-10, 0, 10]) {
      const mark = MeshBuilder.CreateBox(`inlay_${x}`, { width: 0.025, height: 0.012, depth: 6.7 }, this.scene);
      mark.position.set(x, 0.012, 0.25);
      mark.material = brass;
    }

    const workshopWood = new PBRMaterial("workshopWood", this.scene);
    workshopWood.albedoColor = new Color3(0.16, 0.095, 0.055);
    workshopWood.roughness = 0.9;
    for (const side of [-1, 1]) {
      const shelf = MeshBuilder.CreateBox(`shelf_${side}`, { width: 9, height: 0.25, depth: 1.1 }, this.scene);
      shelf.position.set(side * 12.6, 6.8, 4.7);
      shelf.material = workshopWood;
      for (let index = 0; index < 5; index += 1) {
        const bottleMaterial = new PBRMaterial(`bottleMat_${side}_${index}`, this.scene);
        const color = elementColor(ELEMENTS[index]?.id ?? "fire");
        bottleMaterial.albedoColor = color.scale(0.35);
        bottleMaterial.emissiveColor = color.scale(0.22);
        bottleMaterial.alpha = 0.78;
        bottleMaterial.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
        const bottle = MeshBuilder.CreateCylinder(`bottle_${side}_${index}`, { height: 0.8 + (index % 2) * 0.28, diameter: 0.36, tessellation: 12 }, this.scene);
        bottle.position.set(side * 12.6 - 3.3 + index * 1.5, 7.32, 4.6);
        bottle.material = bottleMaterial;
      }
    }

    const moonMaterial = new StandardMaterial("moonWindow", this.scene);
    moonMaterial.diffuseColor = new Color3(0.18, 0.39, 0.43);
    moonMaterial.emissiveColor = new Color3(0.12, 0.28, 0.31);
    const moon = MeshBuilder.CreateDisc("moonWindow", { radius: 2.5, tessellation: 48 }, this.scene);
    moon.position.set(0, 8.3, 5.9);
    moon.material = moonMaterial;
    const ring = MeshBuilder.CreateTorus("windowRing", { diameter: 5.3, thickness: 0.16, tessellation: 64 }, this.scene);
    ring.position.copyFrom(moon.position);
    ring.rotation.x = Math.PI / 2;
    ring.material = brass;
    for (const x of [-16.5, 16.5]) {
      const pipe = MeshBuilder.CreateCylinder(`pipe_${x}`, { height: 10, diameter: 0.22, tessellation: 12 }, this.scene);
      pipe.position.set(x, 5, 5.1);
      pipe.material = brass;
    }
  }

  private createLaunchers(): void {
    const wood = this.materials.get("wood")!;
    const brass = new PBRMaterial("launcherBrass", this.scene);
    brass.albedoColor = new Color3(0.52, 0.31, 0.11);
    brass.metallic = 0.82;
    brass.roughness = 0.3;
    for (const player of [0, 1] as const) {
      const x = LAUNCHER_X[player];
      const direction = player === 0 ? 1 : -1;
      const root = new TransformNode(`launcher_${player}`, this.scene);
      root.position.x = x;
      for (const offset of [-0.34, 0.34]) {
        const arm = MeshBuilder.CreateCylinder(`launcherArm_${player}_${offset}`, { height: 2.25, diameter: 0.21, tessellation: 10 }, this.scene);
        arm.parent = root;
        arm.position.set(offset, 0.98, 0);
        arm.rotation.z = offset * -0.22;
        arm.material = wood;
        this.shadow.addShadowCaster(arm);
      }
      const cup = MeshBuilder.CreateSphere(`launcherCup_${player}`, { diameter: 0.38, segments: 16 }, this.scene);
      cup.parent = root;
      cup.position.set(0, 1.05, -0.06);
      cup.material = brass;
      const glowLight = new PointLight(`launcherGlow_${player}`, new Vector3(x, 1.1, -0.6), this.scene);
      glowLight.diffuse = player === 0 ? new Color3(0.25, 0.9, 0.78) : new Color3(0.92, 0.36, 0.22);
      glowLight.intensity = 5;
      glowLight.range = 3.3;
      root.rotation.y = direction === 1 ? 0 : Math.PI;
    }
  }

  private createAimDots(): void {
    this.aimMaterial = new StandardMaterial("trajectoryMaterial", this.scene);
    this.aimMaterial.disableLighting = true;
    this.aimMaterial.emissiveColor = elementColor("fire");
    for (let index = 0; index < 26; index += 1) {
      const dot = MeshBuilder.CreateSphere(`arcDot_${index}`, { diameter: index % 4 === 0 ? 0.095 : 0.055, segments: 6 }, this.scene);
      dot.material = this.aimMaterial;
      dot.isVisible = false;
      this.aimDots.push(dot);
    }
  }

  private createPostProcessing(): void {
    this.glow = new GlowLayer("materialGlow", this.scene, { blurKernelSize: 48 });
    this.glow.intensity = 0.58;
    const pipeline = new DefaultRenderingPipeline("cinematic", true, this.scene, [this.camera]);
    pipeline.samples = 2;
    pipeline.fxaaEnabled = true;
    pipeline.bloomEnabled = true;
    pipeline.bloomThreshold = 0.72;
    pipeline.bloomWeight = 0.34;
    pipeline.bloomKernel = 48;
    pipeline.imageProcessingEnabled = true;
    pipeline.imageProcessing.contrast = 1.28;
    pipeline.imageProcessing.exposure = 1.08;
    pipeline.chromaticAberrationEnabled = true;
    pipeline.chromaticAberration.aberrationAmount = 2.2;
  }

  private createAmbientDust(): void {
    const dust = new ParticleSystem("ambientDust", 280, this.scene);
    dust.particleTexture = this.particleTexture;
    dust.emitter = new Vector3(0, 4, 2);
    dust.minEmitBox = new Vector3(-19, -3.5, -2);
    dust.maxEmitBox = new Vector3(19, 5, 3);
    dust.color1 = new Color4(0.68, 0.74, 0.65, 0.18);
    dust.color2 = new Color4(0.35, 0.58, 0.55, 0.1);
    dust.minSize = 0.012;
    dust.maxSize = 0.045;
    dust.minLifeTime = 5;
    dust.maxLifeTime = 12;
    dust.emitRate = 16;
    dust.direction1 = new Vector3(-0.04, 0.025, 0);
    dust.direction2 = new Vector3(0.07, 0.08, 0);
    dust.minEmitPower = 0.04;
    dust.maxEmitPower = 0.14;
    dust.start();
  }

  private syncBlock(state: BlockRuntimeState): void {
    let visual = this.blocks.get(state.id);
    if (!visual) {
      visual = this.createBlockVisual(state);
      this.blocks.set(state.id, visual);
    }
    visual.root.position.x += (state.position.x - visual.root.position.x) * 0.62;
    visual.root.position.y += (state.position.y - visual.root.position.y) * 0.62;
    visual.root.rotation.z = state.rotation;
    const material = visual.material;
    const base = getMaterial(state.material);
    material.albedoColor = hex(base.color);
    material.roughness = state.wetness > 0.2 || state.oiled ? 0.16 : base.roughness;
    let emissive = hex(base.color).scale(state.material === "glass" || state.material === "ice" ? 0.055 : 0.025);
    if (state.burning) emissive = new Color3(0.8, 0.11, 0.015);
    else if (state.charge > 0.08) emissive = new Color3(0.22, 0.12, 0.65).scale(Math.min(1, state.charge));
    else if (state.frozen) emissive = new Color3(0.06, 0.33, 0.55);
    else if (state.corrosion > 0.08) emissive = new Color3(0.18, 0.42, 0.035).scale(Math.min(1, state.corrosion));
    else if (state.material === "core") emissive = new Color3(0.66, 0.29, 0.04);
    material.emissiveColor = emissive;

    if (state.burning && !this.burning.has(state.id)) this.startBurning(state.id, visual.root);
    if (!state.burning && this.burning.has(state.id)) this.stopBurning(state.id);
    if (state.reinforced && !visual.braceAdded) {
      this.addBrace(visual, state);
      visual.braceAdded = true;
    }
    const fire = this.burning.get(state.id);
    if (fire) fire.emitter = new Vector3(state.position.x, state.position.y + 0.28, -0.5);
    const light = this.coreLights.get(state.id);
    if (light) {
      light.position.x = state.position.x;
      light.position.y = state.position.y;
      light.intensity = 5.5 + Math.sin(this.elapsed * 4 + state.owner) * 1.4;
    }
  }

  private createBlockVisual(state: BlockRuntimeState): VisualBlock {
    const root = new TransformNode(`blockRoot_${state.id}`, this.scene);
    root.position.set(state.position.x, state.position.y, 0);
    const base = this.materials.get(state.material)!;
    const material = base.clone(`blockMaterial_${state.id}`) as PBRMaterial;
    const meshes: Mesh[] = [];
    if (state.kind === "core") {
      const cage = MeshBuilder.CreateBox(`coreCage_${state.id}`, { width: state.size.x, height: state.size.y, depth: 1.48 }, this.scene);
      cage.parent = root;
      cage.material = material;
      cage.visibility = 0.38;
      cage.enableEdgesRendering();
      cage.edgesWidth = 2;
      cage.edgesColor = new Color4(0.93, 0.68, 0.24, 0.8);
      const crystal = MeshBuilder.CreatePolyhedron(`coreCrystal_${state.id}`, { type: 1, size: 0.48 }, this.scene);
      crystal.parent = root;
      crystal.position.z = -0.48;
      crystal.material = material;
      meshes.push(cage, crystal);
      const light = new PointLight(`coreLight_${state.id}`, new Vector3(state.position.x, state.position.y, -0.8), this.scene);
      light.diffuse = new Color3(1, 0.48, 0.12);
      light.intensity = 6;
      light.range = 4.2;
      this.coreLights.set(state.id, light);
    } else {
      const mesh = MeshBuilder.CreateBox(`block_${state.id}`, { width: state.size.x, height: state.size.y, depth: 1.5 }, this.scene);
      mesh.parent = root;
      mesh.material = material;
      mesh.enableEdgesRendering();
      mesh.edgesWidth = 0.45;
      mesh.edgesColor = new Color4(0.03, 0.06, 0.06, state.material === "glass" ? 0.25 : 0.72);
      meshes.push(mesh);
    }
    for (const mesh of meshes) {
      mesh.metadata = { blockId: state.id };
      this.shadow.addShadowCaster(mesh);
    }
    return { root, meshes, material, braceAdded: false };
  }

  private addBrace(visual: VisualBlock, state: BlockRuntimeState): void {
    const braceMaterial = new PBRMaterial(`brace_${state.id}`, this.scene);
    braceMaterial.albedoColor = new Color3(0.62, 0.4, 0.14);
    braceMaterial.metallic = 0.92;
    braceMaterial.roughness = 0.27;
    for (const direction of [-1, 1]) {
      const bar = MeshBuilder.CreateBox(`braceBar_${state.id}_${direction}`, { width: state.size.x * 0.9, height: 0.055, depth: 0.055 }, this.scene);
      bar.parent = visual.root;
      bar.position.z = -0.79;
      bar.rotation.z = direction * 0.48;
      bar.material = braceMaterial;
      bar.metadata = { blockId: state.id };
      visual.meshes.push(bar);
    }
  }

  private syncProjectile(state: ProjectileRuntimeState): void {
    let visual = this.projectiles.get(state.id);
    if (!visual) {
      visual = this.createProjectileVisual(state);
      this.projectiles.set(state.id, visual);
    }
    visual.root.position.set(state.position.x, state.position.y, -0.35);
    visual.root.rotation.z = state.rotation;
    visual.light.position.set(state.position.x, state.position.y, -0.8);
  }

  private createProjectileVisual(state: ProjectileRuntimeState): VisualProjectile {
    const root = new TransformNode(`projectileRoot_${state.id}`, this.scene);
    const bodyDef = getProjectileBody(state.recipe.body);
    const material = new PBRMaterial(`projectileMaterial_${state.id}`, this.scene);
    material.albedoColor = hex(bodyDef.color);
    material.metallic = state.recipe.body === "metal" ? 0.85 : 0.08;
    material.roughness = state.recipe.body === "glass" ? 0.12 : 0.48;
    material.emissiveColor = elementColor(state.recipe.element).scale(0.32);
    const body = MeshBuilder.CreateSphere(`projectile_${state.id}`, { diameter: state.radius * 2, segments: 20 }, this.scene);
    body.parent = root;
    body.material = material;
    const ringMaterial = new StandardMaterial(`projectileRingMat_${state.id}`, this.scene);
    ringMaterial.disableLighting = true;
    ringMaterial.emissiveColor = elementColor(state.recipe.element);
    const ring = MeshBuilder.CreateTorus(`projectileRing_${state.id}`, { diameter: state.radius * 2.5, thickness: 0.025, tessellation: 28 }, this.scene);
    ring.parent = root;
    ring.rotation.x = Math.PI / 2;
    ring.material = ringMaterial;
    const light = new PointLight(`shotLight_${state.id}`, new Vector3(state.position.x, state.position.y, -0.8), this.scene);
    light.diffuse = elementColor(state.recipe.element);
    light.intensity = 4;
    light.range = 3.2;
    return { root, meshes: [body, ring], light };
  }

  private startBurning(id: string, root: TransformNode): void {
    const fire = new ParticleSystem(`burn_${id}`, 100, this.scene);
    fire.particleTexture = this.particleTexture;
    fire.emitter = new Vector3(root.position.x, root.position.y, -0.4);
    fire.minEmitBox = new Vector3(-0.35, -0.12, -0.3);
    fire.maxEmitBox = new Vector3(0.35, 0.1, 0.3);
    fire.color1 = new Color4(1, 0.36, 0.05, 0.9);
    fire.color2 = new Color4(1, 0.76, 0.14, 0.8);
    fire.colorDead = new Color4(0.08, 0.075, 0.07, 0);
    fire.minSize = 0.08;
    fire.maxSize = 0.24;
    fire.minLifeTime = 0.25;
    fire.maxLifeTime = 0.75;
    fire.emitRate = 34;
    fire.direction1 = new Vector3(-0.12, 0.8, -0.08);
    fire.direction2 = new Vector3(0.12, 1.4, 0.08);
    fire.minEmitPower = 0.4;
    fire.maxEmitPower = 0.9;
    fire.addSizeGradient(0, 0.4);
    fire.addSizeGradient(0.4, 1);
    fire.addSizeGradient(1, 0);
    fire.start();
    this.burning.set(id, fire);
  }

  private stopBurning(id: string): void {
    const fire = this.burning.get(id);
    if (!fire) return;
    fire.stop();
    window.setTimeout(() => {
      fire.particleTexture = null;
      fire.dispose();
    }, 900);
    this.burning.delete(id);
  }

  private burst(x: number, y: number, element: ElementId, count: number): void {
    const color = elementColor(element);
    const system = new ParticleSystem(`impact_${performance.now()}`, Math.max(80, count * 2), this.scene);
    system.particleTexture = this.particleTexture;
    system.emitter = new Vector3(x, y, -0.65);
    system.color1 = new Color4(color.r, color.g, color.b, 1);
    system.color2 = new Color4(Math.min(1, color.r * 1.5), Math.min(1, color.g * 1.35), Math.min(1, color.b * 1.2), 0.9);
    system.colorDead = new Color4(color.r * 0.08, color.g * 0.08, color.b * 0.08, 0);
    system.minSize = 0.035;
    system.maxSize = element === "fire" ? 0.27 : 0.13;
    system.minLifeTime = 0.22;
    system.maxLifeTime = element === "fire" ? 1.25 : 0.72;
    system.minEmitPower = 1.8;
    system.maxEmitPower = 7.2;
    system.direction1 = new Vector3(-1, -0.35, -0.7);
    system.direction2 = new Vector3(1, 1, 0.7);
    system.gravity = new Vector3(0, element === "fire" ? 0.7 : -5.2, 0);
    system.manualEmitCount = Math.round(count);
    system.targetStopDuration = 0.08;
    system.start();
    window.setTimeout(() => {
      system.particleTexture = null;
      system.dispose();
    }, 1600);
  }

  private steam(x: number, y: number): void {
    const system = new ParticleSystem(`steam_${performance.now()}`, 70, this.scene);
    system.particleTexture = this.particleTexture;
    system.emitter = new Vector3(x, y, -0.6);
    system.color1 = new Color4(0.72, 0.88, 0.9, 0.5);
    system.color2 = new Color4(0.4, 0.65, 0.68, 0.22);
    system.minSize = 0.14;
    system.maxSize = 0.5;
    system.minLifeTime = 0.6;
    system.maxLifeTime = 1.4;
    system.direction1 = new Vector3(-0.2, 0.5, 0);
    system.direction2 = new Vector3(0.2, 1.2, 0);
    system.manualEmitCount = 38;
    system.targetStopDuration = 0.05;
    system.start();
    window.setTimeout(() => {
      system.particleTexture = null;
      system.dispose();
    }, 1700);
  }

  private breakDebris(x: number, y: number, materialId: MaterialId): void {
    const base = this.materials.get(materialId) ?? this.materials.get("stone")!;
    for (let index = 0; index < 8; index += 1) {
      const mesh = MeshBuilder.CreateBox(`debris_${performance.now()}_${index}`, { size: 0.12 + Math.random() * 0.16 }, this.scene);
      mesh.position.set(x, y, -0.55 + Math.random() * 0.5);
      mesh.material = base;
      this.debris.push({
        mesh,
        velocity: new Vector3((Math.random() - 0.5) * 5, 1.2 + Math.random() * 4.4, (Math.random() - 0.5) * 2.2),
        spin: new Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 8),
        life: 2.2 + Math.random(),
      });
    }
  }

  private drawArc(fromX: number, fromY: number, toX: number, toY: number): void {
    const midpoint = new Vector3((fromX + toX) / 2, Math.max(fromY, toY) + 0.45, -1.05);
    const points = [new Vector3(fromX, fromY, -1.05), midpoint, new Vector3(toX, toY, -1.05)];
    const arc = MeshBuilder.CreateLines(`arc_${performance.now()}`, { points }, this.scene);
    arc.color = new Color3(0.62, 0.43, 1);
    arc.alpha = 0.95;
    window.setTimeout(() => arc.dispose(), 110);
  }

  private updateVisuals(delta: number): void {
    for (const [id, visual] of this.blocks) {
      if (id.includes("core")) {
        const crystal = visual.meshes[1];
        if (crystal) {
          crystal.rotation.y += delta * 1.15;
          crystal.rotation.x = Math.sin(this.elapsed * 1.4) * 0.18;
          crystal.scaling.setAll(1 + Math.sin(this.elapsed * 3.2) * 0.035);
        }
      }
    }
    for (const visual of this.projectiles.values()) {
      const ring = visual.meshes[1];
      if (ring) {
        ring.rotation.y += delta * 7;
        ring.scaling.setAll(1 + Math.sin(this.elapsed * 12) * 0.12);
      }
    }
    for (let index = this.debris.length - 1; index >= 0; index -= 1) {
      const piece = this.debris[index];
      if (!piece) continue;
      piece.life -= delta;
      piece.velocity.y -= 7.8 * delta;
      piece.mesh.position.addInPlace(piece.velocity.scale(delta));
      piece.mesh.rotation.x += piece.spin.x * delta;
      piece.mesh.rotation.y += piece.spin.y * delta;
      piece.mesh.rotation.z += piece.spin.z * delta;
      if (piece.mesh.position.y < 0) {
        piece.mesh.position.y = 0;
        piece.velocity.y *= -0.3;
        piece.velocity.x *= 0.72;
      }
      if (piece.life <= 0) {
        piece.mesh.dispose();
        this.debris.splice(index, 1);
      }
    }
    this.shake *= Math.pow(0.02, delta);
    const shakeX = (Math.random() - 0.5) * this.shake;
    const shakeY = (Math.random() - 0.5) * this.shake;
    this.camera.position.set(this.cameraBase.x + shakeX, this.cameraBase.y + shakeY, this.cameraBase.z);
    this.camera.setTarget(this.cameraTarget);
  }

  private patternTexture(id: MaterialId, baseColor: string): DynamicTexture {
    const texture = new DynamicTexture(`pattern_${id}`, { width: 256, height: 256 }, this.scene, false);
    const context = texture.getContext();
    context.fillStyle = baseColor;
    context.fillRect(0, 0, 256, 256);
    let seed = [...id].reduce((sum, character) => sum + character.charCodeAt(0), 0);
    const random = (): number => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    if (id === "wood") {
      for (let line = 0; line < 22; line += 1) {
        context.strokeStyle = `rgba(43, 18, 8, ${0.08 + random() * 0.22})`;
        context.lineWidth = 1 + random() * 3;
        context.beginPath();
        context.moveTo(0, random() * 256);
        context.lineTo(82, random() * 256);
        context.lineTo(174, random() * 256);
        context.lineTo(256, random() * 256);
        context.stroke();
      }
    } else if (id === "hay") {
      for (let line = 0; line < 90; line += 1) {
        context.strokeStyle = `rgba(91, 58, 12, ${0.15 + random() * 0.28})`;
        context.lineWidth = 1;
        const x = random() * 256;
        const y = random() * 256;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + 20 + random() * 42, y + (random() - 0.5) * 12);
        context.stroke();
      }
    } else {
      for (let spot = 0; spot < 180; spot += 1) {
        const light = random() > 0.5 ? 255 : 0;
        context.fillStyle = `rgba(${light}, ${light}, ${light}, ${0.018 + random() * 0.065})`;
        const size = 1 + random() * (id === "stone" || id === "clay" ? 8 : 3);
        context.fillRect(random() * 256, random() * 256, size, size);
      }
    }
    texture.update();
    return texture;
  }

  private radialTexture(name: string, centerColor: string): DynamicTexture {
    const texture = new DynamicTexture(name, { width: 64, height: 64 }, this.scene, false);
    const context = texture.getContext();
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, centerColor);
    gradient.addColorStop(0.25, "rgba(255,255,255,.9)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    texture.hasAlpha = true;
    texture.update();
    return texture;
  }
}
