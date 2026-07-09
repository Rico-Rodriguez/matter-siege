import {
  ELEMENTS,
  MODIFIERS,
  PROJECTILE_BODIES,
  getElement,
  type MatchSnapshot,
  type MutationId,
  type PlayerId,
  type ProjectileRecipe,
  type SimEvent,
} from "@matter-siege/shared";

export type GameMode = "duel" | "lab" | "online";

interface HudCallbacks {
  mode: (mode: GameMode) => void;
  mutation: (mutation: MutationId) => void;
  recipe: (recipe: ProjectileRecipe) => void;
  primary: () => void;
  quickLaunch: () => void;
  rematch: () => void;
  sound: () => boolean;
}

const required = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element;
};

export class Hud {
  recipe: ProjectileRecipe = { body: "stone", element: "fire", modifier: "heavy" };
  mutation: MutationId = "reinforce";
  private mode: GameMode = "duel";
  private toastTimer = 0;
  private readonly callbacks: HudCallbacks;

  constructor(callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    this.populateChoices();
    this.bind();
    this.updateRecipeChip();
  }

  reveal(): void {
    required("#hud").classList.add("ready");
    required("#hud").setAttribute("aria-hidden", "false");
    required("#splash").classList.add("leaving");
  }

  setMode(mode: GameMode): void {
    this.mode = mode;
    document.querySelectorAll<HTMLButtonElement>(".mode").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
    required("#winPanel").classList.remove("visible");
  }

  setNetworkStatus(message: string, connected = false): void {
    const label = required("#networkStatus");
    label.textContent = message;
    label.classList.toggle("connected", connected);
  }

  setRendererLabel(label: string): void {
    required("#rendererLabel").textContent = label;
  }

  update(snapshot: MatchSnapshot, localPlayer: PlayerId): void {
    document.body.dataset.phase = snapshot.phase;
    const isMine = snapshot.activePlayer === localPlayer;
    const phaseNames = { build: "FORTIFY", craft: "FORGE", aim: "TAKE AIM", resolve: "IMPACT", finished: "RESOLVED" } as const;
    const phaseNumbers = { build: "1", craft: "2", aim: "3", resolve: "4", finished: "5" } as const;
    const phaseCopy = {
      build: ["FORTIFY YOUR TOWER", "Choose a treatment", "Select a treatment, then touch one of your tower blocks. Two actions are available."],
      craft: ["COMPOSE THE ORDNANCE", "Forge a reaction", "Combine a physical body, elemental charge, and flight modifier."],
      aim: ["CALIBRATE THE TRAJECTORY", "Pull. Read. Release.", "Drag backward from your glowing launcher. Moderate power lands the cleanest shot."],
      resolve: ["REACTION IN PROGRESS", "Observe the chain", "The physical result is authoritative. Sparks, smoke, and debris are visual interpretation."],
      finished: ["THE LATTICE HAS FAILED", "Match resolved", "Review the ruin, then recalibrate the arena for another duel."],
    } as const;

    required("#phaseLabel").textContent = phaseNames[snapshot.phase];
    required("#phaseNumber").textContent = phaseNumbers[snapshot.phase];
    required("#phaseEyebrow").textContent = `${isMine ? "YOUR TURN" : "RIVAL TURN"} · PHASE 0${phaseNumbers[snapshot.phase]}`;
    required("#turnLabel").textContent = `TURN ${String(snapshot.turn).padStart(2, "0")}`;
    required("#phaseKicker").textContent = phaseCopy[snapshot.phase][0];
    required("#phaseTitle").textContent = phaseCopy[snapshot.phase][1];
    required("#phaseDescription").textContent = phaseCopy[snapshot.phase][2];
    required("#seedLabel").textContent = `SEED ${snapshot.seed}`;

    this.setCoreMeter("left", snapshot.coreHealth[0]);
    this.setCoreMeter("right", snapshot.coreHealth[1]);
    required("#actionPip1").classList.toggle("spent", snapshot.buildPoints < 1);
    required("#actionPip2").classList.toggle("spent", snapshot.buildPoints < 2);
    required("#enemyBanner").classList.toggle("visible", !isMine && snapshot.phase !== "finished");

    const primary = required<HTMLButtonElement>("#primaryAction");
    primary.disabled = !isMine || snapshot.phase === "resolve";
    primary.querySelector("span")!.textContent = snapshot.phase === "build" ? "OPEN THE FORGE" : snapshot.phase === "craft" ? "CHAMBER THIS RECIPE" : snapshot.phase === "aim" ? "CALIBRATED LAUNCH" : "WAIT FOR RESOLUTION";
    required<HTMLButtonElement>("#quickLaunch").disabled = !isMine;

    if (snapshot.phase === "finished") this.showWinner(snapshot.winner, localPlayer);
  }

  setAim(angle: number, power: number): void {
    required("#angleValue").textContent = `${Math.round(angle)}°`;
    required("#powerValue").textContent = `${Math.round(power * 100)}%`;
  }

  showToast(message: string): void {
    const toast = required("#toast");
    toast.textContent = message.toUpperCase();
    toast.classList.add("visible");
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 1900);
  }

  feed(events: SimEvent[]): void {
    const feed = required("#eventFeed");
    for (const event of events) {
      if (event.type === "phase" || event.type === "win") continue;
      const line = document.createElement("div");
      line.className = "event-line";
      if (event.type === "impact") {
        line.classList.add(event.element === "fire" || event.element === "acid" ? "hot" : event.element === "lightning" ? "volt" : "cold");
        line.textContent = `${event.element.toUpperCase()} IMPACT · ${Math.round(event.impulse)} kN`;
      } else if (event.type === "break") {
        line.classList.add("break");
        line.textContent = `${event.material.toUpperCase()} FRACTURE`;
      } else if (event.type === "arc") {
        line.classList.add("volt");
        line.textContent = "CONDUCTIVE ARC";
      } else {
        line.textContent = event.type === "ignite" ? "COMBUSTION STARTED" : "STEAM QUENCH";
      }
      feed.prepend(line);
      while (feed.children.length > 7) feed.lastElementChild?.remove();
      window.setTimeout(() => line.remove(), 5200);
    }
  }

  private bind(): void {
    document.querySelectorAll<HTMLButtonElement>(".mode").forEach((button) => button.addEventListener("click", () => this.callbacks.mode(button.dataset.mode as GameMode)));
    document.querySelectorAll<HTMLButtonElement>(".treatment").forEach((button) => button.addEventListener("click", () => {
      this.mutation = button.dataset.mutation as MutationId;
      document.querySelectorAll(".treatment").forEach((entry) => entry.classList.toggle("active", entry === button));
      this.callbacks.mutation(this.mutation);
    }));
    required("#primaryAction").addEventListener("click", this.callbacks.primary);
    required("#quickLaunch").addEventListener("click", this.callbacks.quickLaunch);
    required("#rematchButton").addEventListener("click", this.callbacks.rematch);
    required("#soundButton").addEventListener("click", () => {
      const enabled = this.callbacks.sound();
      required("#soundButton").textContent = enabled ? "SOUND ON" : "SOUND OFF";
    });
  }

  private populateChoices(): void {
    const bodyContainer = required("#bodyChoices");
    const elementContainer = required("#elementChoices");
    const modifierContainer = required("#modifierChoices");
    for (const body of PROJECTILE_BODIES) bodyContainer.append(this.choice(body.id, body.displayName, "body"));
    for (const element of ELEMENTS) {
      const button = this.choice(element.id, `${element.glyph}<small>${element.displayName}</small>`, "element");
      button.style.setProperty("--element-color", element.color);
      elementContainer.append(button);
    }
    for (const modifier of MODIFIERS) modifierContainer.append(this.choice(modifier.id, modifier.displayName, "modifier"));
  }

  private choice(id: string, label: string, part: "body" | "element" | "modifier"): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = `choice${part === "element" ? " element" : ""}${this.recipe[part] === id ? " active" : ""}`;
    button.dataset.part = part;
    button.dataset.value = id;
    button.innerHTML = label;
    button.addEventListener("click", () => {
      this.recipe = { ...this.recipe, [part]: id };
      document.querySelectorAll<HTMLButtonElement>(`.choice[data-part="${part}"]`).forEach((entry) => entry.classList.toggle("active", entry === button));
      this.updateRecipeChip();
      this.callbacks.recipe(this.recipe);
    });
    return button;
  }

  private updateRecipeChip(): void {
    const element = getElement(this.recipe.element);
    required("#recipeGlyph").textContent = element.glyph;
    required("#recipeGlyph").style.color = element.color;
    required("#recipeName").textContent = `${this.recipe.body} · ${this.recipe.element} · ${this.recipe.modifier}`.toUpperCase();
  }

  private setCoreMeter(side: "left" | "right", value: number): void {
    required(`#${side}CoreText`).textContent = String(Math.max(0, value));
    required<HTMLElement>(`#${side}CoreBar`).style.width = `${Math.max(0, value)}%`;
    required(`#${side}Status`).textContent = value > 65 ? "STABLE" : value > 30 ? "COMPROMISED" : "CRITICAL";
  }

  private showWinner(winner: PlayerId | null, localPlayer: PlayerId): void {
    const won = winner === localPlayer;
    required("#winTitle").textContent = this.mode === "lab" ? "EXPERIMENT COMPLETE" : won ? "RIVAL CORE COLLAPSED" : "YOUR CORE COLLAPSED";
    required("#winCopy").textContent = this.mode === "lab" ? "The laboratory is ready for another composition." : won ? "A clean reaction. The rival lattice has failed." : "The ruin is data. Rebuild, recraft, return.";
    required("#winPanel").classList.add("visible");
  }
}

