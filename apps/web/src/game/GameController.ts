import {
  LAUNCH_CONFIG,
  type MatchSnapshot,
  type MutationId,
  type PlayerCommand,
  type PlayerId,
  type ProjectileRecipe,
  type SimEvent,
} from "@matter-siege/shared";
import { MatterSimulation, SIM_HZ } from "@matter-siege/sim";
import { AudioDirector } from "./AudioDirector.js";
import { Hud, type GameMode } from "./Hud.js";
import { NetworkSession } from "./NetworkSession.js";
import { SceneWorld } from "./SceneWorld.js";

const AIM_DEADZONE_PX = 16;
const AIM_DEADZONE_WORLD = 0.18;
const AIM_FULL_PULL_WORLD = 4.8;

const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));

export class GameController {
  readonly hud: Hud;

  private simulation?: MatterSimulation;
  private network?: NetworkSession;
  private snapshot?: MatchSnapshot;
  private mode: GameMode = "duel";
  private localPlayer: PlayerId = 0;
  private accumulator = 0;
  private aiTimer = 0;
  private aiKey = "";
  private generation = 0;
  private aimPointerId: number | null = null;
  private aimStartWorld?: { x: number; y: number };
  private aimStartClient?: { x: number; y: number };
  private aimReady = false;
  private aimAngle = LAUNCH_CONFIG.recommendedAngle;
  private aimPower = LAUNCH_CONFIG.recommendedPower;
  private selectedMutation: MutationId = "reinforce";
  private selectedBlockId: string | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly world: SceneWorld,
    private readonly audio: AudioDirector,
  ) {
    this.hud = new Hud({
      mode: (mode) => void this.startMode(mode),
      mutation: (mutation) => {
        this.selectedMutation = mutation;
        this.applySelectedMutation();
      },
      guardian: () => this.upgradeGuardian(),
      recipe: () => this.audio.ui(610),
      primary: () => this.primaryAction(),
      rematch: () => void this.startMode(this.mode),
      sound: () => this.audio.toggle(),
    });
    this.bindPointerControls();
    this.world.setFrameCallback((delta) => this.update(delta));
    window.addEventListener("keydown", (event) => {
      if (event.shiftKey && event.key.toLowerCase() === "r") this.downloadReplay();
    });
  }

  async startMode(mode: GameMode): Promise<void> {
    const generation = ++this.generation;
    this.mode = mode;
    this.hud.setMode(mode);
    this.resetAimGesture();
    this.clearBlockSelection();
    this.world.clearAim();
    this.world.setActiveLauncher(null);
    this.snapshot = undefined;
    this.accumulator = 0;
    this.aiTimer = 0;
    this.aiKey = "";
    await this.network?.leave();
    this.network = undefined;
    this.simulation = undefined;
    this.localPlayer = 0;

    if (mode === "online") {
      this.hud.setNetworkStatus("CONNECTING", false);
      const session = new NetworkSession({
        snapshot: (snapshot) => {
          if (generation !== this.generation) return;
          this.localPlayer = session.playerId;
          this.receiveSnapshot(snapshot);
        },
        events: (events) => this.processEvents(events),
        status: (message, connected) => this.hud.setNetworkStatus(message, connected),
        rejected: (reason) => this.hud.showToast(reason),
      });
      this.network = session;
      try {
        await session.connect();
        if (generation !== this.generation) await session.leave();
        else this.hud.showToast("Authority connected · waiting for rival");
        return;
      } catch {
        if (generation !== this.generation) return;
        this.hud.showToast("Online authority unavailable · returning to local duel");
        this.hud.setNetworkStatus("OFFLINE", false);
        window.setTimeout(() => void this.startMode("duel"), 900);
        return;
      }
    }

    this.hud.setNetworkStatus(mode === "lab" ? "SANDBOX" : "LOCAL AI", false);
    const seed = Math.floor(Date.now() % 2_147_483_647);
    this.simulation = await MatterSimulation.create({ seed, labMode: mode === "lab" });
    if (generation !== this.generation) return;
    this.receiveSnapshot(this.simulation.snapshot());
    this.processEvents(this.simulation.drainEvents());
  }

  private update(deltaSeconds: number): void {
    if (this.simulation) {
      this.accumulator += Math.min(deltaSeconds, 0.05);
      const fixedDelta = 1 / SIM_HZ;
      while (this.accumulator >= fixedDelta) {
        this.simulation.step();
        this.accumulator -= fixedDelta;
      }
      const events = this.simulation.drainEvents();
      this.receiveSnapshot(this.simulation.snapshot());
      this.processEvents(events);
    }
    this.updateAi(deltaSeconds);
  }

  private receiveSnapshot(snapshot: MatchSnapshot): void {
    const previousPhase = this.snapshot?.phase;
    const wasLocalAim = this.isLocalAim(this.snapshot);
    this.snapshot = snapshot;
    this.world.sync(snapshot);
    this.hud.update(snapshot, this.localPlayer);
    if (previousPhase && previousPhase !== snapshot.phase && snapshot.phase !== "build") this.clearBlockSelection();
    if (this.selectedBlockId) {
      const selected = snapshot.blocks.find((block) => block.id === this.selectedBlockId && block.owner === this.localPlayer && block.kind === "block");
      if (selected) this.hud.selectBlock(selected);
      else this.clearBlockSelection();
    }
    const isLocalAim = this.isLocalAim(snapshot);
    this.world.setActiveLauncher(isLocalAim ? this.localPlayer : null);
    if (isLocalAim && !wasLocalAim) this.showRecommendedAim();
    else if (!isLocalAim && (wasLocalAim || this.aimPointerId !== null)) {
      this.resetAimGesture();
      this.world.clearAim();
    }
  }

  private processEvents(events: SimEvent[]): void {
    if (events.length === 0) return;
    this.world.processEvents(events);
    this.hud.feed(events);
    for (const event of events) {
      this.audio.event(event);
      if (event.type === "phase") this.audio.phase();
    }
  }

  private command(command: PlayerCommand): boolean {
    if (this.network) {
      this.network.send(command);
      return true;
    }
    if (!this.simulation) return false;
    const result = this.simulation.applyCommand(this.localPlayer, command);
    if (!result.ok) {
      this.hud.showToast(result.error ?? "Command rejected");
      return false;
    }
    this.receiveSnapshot(this.simulation.snapshot());
    this.processEvents(this.simulation.drainEvents());
    return true;
  }

  private primaryAction(): void {
    if (!this.snapshot || this.snapshot.activePlayer !== this.localPlayer) return;
    this.audio.ui();
    if (this.snapshot.phase === "build") this.command({ type: "endBuild" });
    else if (this.snapshot.phase === "craft") this.command({ type: "craft", recipe: { ...this.hud.recipe } });
    else if (this.snapshot.phase === "aim") this.fireRecommendedShot();
  }

  private fireRecommendedShot(): void {
    if (!this.snapshot || this.snapshot.phase !== "aim" || this.snapshot.activePlayer !== this.localPlayer) return;
    const recipe = this.snapshot.selectedRecipes[this.localPlayer];
    if (this.command({ type: "launch", angle: LAUNCH_CONFIG.recommendedAngle, power: LAUNCH_CONFIG.recommendedPower })) {
      this.audio.launch(recipe.element);
      this.world.clearAim();
    }
  }

  private applySelectedMutation(): void {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.phase !== "build" || snapshot.activePlayer !== this.localPlayer) return;
    if (!this.selectedBlockId) {
      this.hud.showToast("Tap one of your tower blocks first");
      return;
    }
    const block = snapshot.blocks.find((entry) => entry.id === this.selectedBlockId);
    if (!block || block.owner !== this.localPlayer || block.kind !== "block") {
      this.clearBlockSelection();
      this.hud.showToast("Select an available block in your tower");
      return;
    }
    if (this.command({ type: "mutate", blockId: block.id, mutation: this.selectedMutation })) this.audio.ui(360);
  }

  private upgradeGuardian(): void {
    if (!this.snapshot || this.snapshot.phase !== "build" || this.snapshot.activePlayer !== this.localPlayer) return;
    if (this.command({ type: "upgradeGuardian" })) {
      this.audio.phase();
      this.world.setSelectedBlock(`p${this.localPlayer}_core`);
    }
  }

  private clearBlockSelection(): void {
    this.selectedBlockId = null;
    this.world.setSelectedBlock(null);
    this.hud.selectBlock();
  }

  private bindPointerControls(): void {
    this.canvas.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || (event.pointerType !== "touch" && event.button !== 0) || this.aimPointerId !== null) return;
      const snapshot = this.snapshot;
      if (!snapshot || snapshot.activePlayer !== this.localPlayer) return;
      if (snapshot.phase === "build") {
        const blockId = this.world.pickBlock(event.clientX, event.clientY);
        const block = snapshot.blocks.find((entry) => entry.id === blockId);
        if (!block || block.owner !== this.localPlayer) {
          this.hud.showToast("Tap one of the highlighted blocks in your tower");
          return;
        }
        if (block.kind === "core") {
          this.clearBlockSelection();
          this.world.setSelectedBlock(block.id);
          this.hud.showToast("Aether Regent selected · use Ascend Regent below");
          return;
        }
        this.selectedBlockId = block.id;
        this.world.setSelectedBlock(block.id);
        this.hud.selectBlock(block);
        this.audio.ui(430);
        return;
      }
      if (snapshot.phase !== "aim") return;
      const point = this.world.screenToWorld(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      this.aimPointerId = event.pointerId;
      this.aimStartWorld = point;
      this.aimStartClient = { x: event.clientX, y: event.clientY };
      this.aimReady = false;
      this.hud.setAimInteraction(true);
      if (this.canvas.isConnected) this.canvas.setPointerCapture(event.pointerId);
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (event.pointerId === this.aimPointerId) {
        event.preventDefault();
        this.updateAim(event.clientX, event.clientY);
      }
    });

    const release = (event: PointerEvent): void => {
      if (event.pointerId !== this.aimPointerId) return;
      const ready = this.updateAim(event.clientX, event.clientY);
      const angle = this.aimAngle;
      const power = this.aimPower;
      this.resetAimGesture();
      if (!ready) {
        this.showRecommendedAim();
        this.hud.showToast("Drag farther, then release to fire");
        return;
      }
      const recipe = this.snapshot?.selectedRecipes[this.localPlayer] ?? this.hud.recipe;
      if (this.command({ type: "launch", angle, power })) {
        this.audio.launch(recipe.element);
        this.world.clearAim();
      }
    };
    this.canvas.addEventListener("pointerup", release);
    this.canvas.addEventListener("pointercancel", (event) => {
      if (event.pointerId !== this.aimPointerId) return;
      this.resetAimGesture();
      this.showRecommendedAim();
    });
    this.canvas.addEventListener("lostpointercapture", (event) => {
      if (event.pointerId !== this.aimPointerId) return;
      this.resetAimGesture(false);
      this.showRecommendedAim();
    });
  }

  private updateAim(clientX: number, clientY: number): boolean {
    const startWorld = this.aimStartWorld;
    const startClient = this.aimStartClient;
    if (!startWorld || !startClient || !this.isLocalAim(this.snapshot)) {
      this.aimReady = false;
      return false;
    }
    const point = this.world.screenToWorld(clientX, clientY);
    if (!point) {
      this.aimReady = false;
      return false;
    }
    const direction = this.localPlayer === 0 ? 1 : -1;
    const horizontalPull = Math.max(0, (startWorld.x - point.x) * direction);
    const verticalPull = Math.max(0, startWorld.y - point.y);
    const pullDistance = Math.hypot(horizontalPull, verticalPull);
    const screenDistance = Math.hypot(clientX - startClient.x, clientY - startClient.y);
    this.aimReady = screenDistance >= AIM_DEADZONE_PX && pullDistance >= AIM_DEADZONE_WORLD;
    this.hud.setAimInteraction(true, this.aimReady);
    if (!this.aimReady) return false;

    this.aimAngle = clamp((Math.atan2(verticalPull, horizontalPull) * 180) / Math.PI, LAUNCH_CONFIG.minAngle, LAUNCH_CONFIG.maxAngle);
    this.aimPower = clamp(pullDistance / AIM_FULL_PULL_WORLD, LAUNCH_CONFIG.minPower, LAUNCH_CONFIG.maxPower);
    this.hud.setAim(this.aimAngle, this.aimPower);
    const recipe = this.snapshot?.selectedRecipes[this.localPlayer] ?? this.hud.recipe;
    this.world.showAim(this.localPlayer, this.aimAngle, this.aimPower, recipe);
    return true;
  }

  private isLocalAim(snapshot?: MatchSnapshot): boolean {
    return snapshot?.phase === "aim" && snapshot.activePlayer === this.localPlayer;
  }

  private showRecommendedAim(): void {
    const snapshot = this.snapshot;
    if (!this.isLocalAim(snapshot) || !snapshot) return;
    this.aimAngle = LAUNCH_CONFIG.recommendedAngle;
    this.aimPower = LAUNCH_CONFIG.recommendedPower;
    this.aimReady = false;
    this.hud.setAimInteraction(false);
    this.hud.setAim(this.aimAngle, this.aimPower);
    this.world.showAim(this.localPlayer, this.aimAngle, this.aimPower, snapshot.selectedRecipes[this.localPlayer]);
  }

  private resetAimGesture(releaseCapture = true): void {
    const pointerId = this.aimPointerId;
    this.aimPointerId = null;
    this.aimStartWorld = undefined;
    this.aimStartClient = undefined;
    this.aimReady = false;
    this.hud.setAimInteraction(false);
    if (releaseCapture && pointerId !== null && this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId);
  }

  private updateAi(deltaSeconds: number): void {
    const snapshot = this.snapshot;
    if (!this.simulation || this.mode !== "duel" || !snapshot || snapshot.activePlayer !== 1 || snapshot.phase === "finished" || snapshot.phase === "resolve") return;
    const key = `${snapshot.turn}:${snapshot.phase}:${snapshot.buildPoints}`;
    if (key !== this.aiKey) {
      this.aiKey = key;
      this.aiTimer = 0;
    }
    this.aiTimer += deltaSeconds;
    if (this.aiTimer < 0.62) return;
    this.aiTimer = 0;

    if (snapshot.phase === "build") {
      if (snapshot.buildPoints > 0) {
        const guardian = snapshot.blocks.find((block) => block.id === "p1_core");
        if (guardian && guardian.upgradeLevel < 3 && snapshot.buildPoints === 2) {
          this.simulation.applyCommand(1, { type: "upgradeGuardian" });
          return;
        }
        const candidates = snapshot.blocks.filter((block) => block.owner === 1 && block.kind === "block");
        const block = candidates[(snapshot.turn * 3 + snapshot.buildPoints * 5) % candidates.length];
        const mutations: MutationId[] = ["reinforce", "wet", "frozen", "reinforce"];
        const mutation = mutations[snapshot.turn % mutations.length] ?? "reinforce";
        if (block) this.simulation.applyCommand(1, { type: "mutate", blockId: block.id, mutation });
      } else this.simulation.applyCommand(1, { type: "endBuild" });
    } else if (snapshot.phase === "craft") {
      const recipes: ProjectileRecipe[] = [
        { body: "metal", element: "lightning", modifier: "heavy" },
        { body: "glass", element: "ice", modifier: "split" },
        { body: "stone", element: "acid", modifier: "sticky" },
        { body: "stone", element: "fire", modifier: "heavy" },
      ];
      this.simulation.applyCommand(1, { type: "craft", recipe: recipes[snapshot.turn % recipes.length] ?? recipes[0]! });
    } else if (snapshot.phase === "aim") {
      const angleOffset = (((snapshot.seed + snapshot.turn * 17) % 21) - 10) / 10;
      const powerOffset = (((snapshot.seed + snapshot.turn * 11) % 9) - 4) / 100;
      const angle = clamp(LAUNCH_CONFIG.recommendedAngle + angleOffset, LAUNCH_CONFIG.minAngle, LAUNCH_CONFIG.maxAngle);
      const power = clamp(LAUNCH_CONFIG.recommendedPower + powerOffset, LAUNCH_CONFIG.minPower, LAUNCH_CONFIG.maxPower);
      const recipe = snapshot.selectedRecipes[1];
      if (this.simulation.applyCommand(1, { type: "launch", angle, power }).ok) this.audio.launch(recipe.element);
    }
  }

  private downloadReplay(): void {
    if (!this.simulation) {
      this.hud.showToast("Replay export is available for local deterministic matches");
      return;
    }
    const blob = new Blob([JSON.stringify(this.simulation.exportReplay(), null, 2)], { type: "application/json" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `matter-siege-${this.simulation.seed}.replay.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    this.hud.showToast("Replay command log exported");
  }
}
