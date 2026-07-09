import type {
  MatchSnapshot,
  MutationId,
  PlayerCommand,
  PlayerId,
  ProjectileRecipe,
  SimEvent,
} from "@matter-siege/shared";
import { MatterSimulation, SIM_HZ } from "@matter-siege/sim";
import { AudioDirector } from "./AudioDirector.js";
import { Hud, type GameMode } from "./Hud.js";
import { NetworkSession } from "./NetworkSession.js";
import { SceneWorld } from "./SceneWorld.js";

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
  private aiming = false;
  private aimAngle = 40;
  private aimPower = 0.52;
  private selectedMutation: MutationId = "reinforce";

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly world: SceneWorld,
    private readonly audio: AudioDirector,
  ) {
    this.hud = new Hud({
      mode: (mode) => void this.startMode(mode),
      mutation: (mutation) => {
        this.selectedMutation = mutation;
        this.audio.ui(480);
      },
      recipe: () => this.audio.ui(610),
      primary: () => this.primaryAction(),
      quickLaunch: () => this.quickLaunch(),
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
    this.world.clearAim();
    this.aiming = false;
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
    this.snapshot = snapshot;
    this.world.sync(snapshot);
    this.hud.update(snapshot, this.localPlayer);
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
    else if (this.snapshot.phase === "aim") this.quickLaunch();
  }

  private quickLaunch(): void {
    if (!this.snapshot || this.snapshot.phase !== "aim" || this.snapshot.activePlayer !== this.localPlayer) return;
    if (this.command({ type: "launch", angle: 40, power: 0.52 })) {
      this.audio.launch(this.hud.recipe.element);
      this.world.clearAim();
    }
  }

  private bindPointerControls(): void {
    this.canvas.addEventListener("pointerdown", (event) => {
      const snapshot = this.snapshot;
      if (!snapshot || snapshot.activePlayer !== this.localPlayer) return;
      if (snapshot.phase === "build") {
        const blockId = this.world.pickBlock(event.clientX, event.clientY);
        const block = snapshot.blocks.find((entry) => entry.id === blockId);
        if (!block || block.owner !== this.localPlayer) {
          this.hud.showToast("Select a non-core block in your own tower");
          return;
        }
        if (block.kind === "core") {
          this.hud.showToast("Aether cores reject direct treatment");
          return;
        }
        if (this.command({ type: "mutate", blockId: block.id, mutation: this.selectedMutation })) this.audio.ui(360);
        return;
      }
      if (snapshot.phase !== "aim") return;
      const point = this.world.screenToWorld(event.clientX, event.clientY);
      if (!point) return;
      const launcher = this.world.getLauncher(this.localPlayer);
      if (Math.hypot(point.x - launcher.x, point.y - launcher.y) > 2.8) {
        this.hud.showToast("Begin the pull at the glowing launcher");
        return;
      }
      this.aiming = true;
      this.canvas.setPointerCapture(event.pointerId);
      this.updateAim(event.clientX, event.clientY);
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (this.aiming) this.updateAim(event.clientX, event.clientY);
    });

    const release = (event: PointerEvent): void => {
      if (!this.aiming) return;
      this.updateAim(event.clientX, event.clientY);
      this.aiming = false;
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      if (this.aimPower < 0.2) {
        this.world.clearAim();
        return;
      }
      if (this.command({ type: "launch", angle: this.aimAngle, power: this.aimPower })) {
        this.audio.launch(this.hud.recipe.element);
        this.world.clearAim();
      }
    };
    this.canvas.addEventListener("pointerup", release);
    this.canvas.addEventListener("pointercancel", release);
  }

  private updateAim(clientX: number, clientY: number): void {
    const point = this.world.screenToWorld(clientX, clientY);
    if (!point) return;
    const launcher = this.world.getLauncher(this.localPlayer);
    const direction = this.localPlayer === 0 ? 1 : -1;
    const horizontalPull = Math.max(0.01, (launcher.x - point.x) * direction);
    const verticalPull = Math.max(0.01, launcher.y - point.y);
    this.aimAngle = Math.max(15, Math.min(78, (Math.atan2(verticalPull, horizontalPull) * 180) / Math.PI));
    this.aimPower = Math.max(0.2, Math.min(1, Math.hypot(horizontalPull, verticalPull) / 4.8));
    this.hud.setAim(this.aimAngle, this.aimPower);
    this.world.showAim(this.localPlayer, this.aimAngle, this.aimPower, this.hud.recipe);
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
      const angle = 38.5 + ((snapshot.seed + snapshot.turn * 17) % 35) / 10;
      const power = 0.47 + ((snapshot.seed + snapshot.turn * 11) % 9) / 100;
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

