import {
  ELEMENTS,
  FORTIFICATION_CONFIG,
  LAUNCH_CONFIG,
  MODIFIERS,
  PROJECTILE_BODIES,
  getElement,
  getGuardianTier,
  getMaterial,
  type BlockRuntimeState,
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
  guardian: () => void;
  recipe: (recipe: ProjectileRecipe) => void;
  primary: () => void;
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
  private selectedBlockId: string | null = null;
  private toastTimer = 0;
  private readonly callbacks: HudCallbacks;

  constructor(callbacks: HudCallbacks) {
    this.callbacks = callbacks;
    this.populateChoices();
    this.bind();
    this.updateRecipeChip();
    this.setAim(LAUNCH_CONFIG.recommendedAngle, LAUNCH_CONFIG.recommendedPower);
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
    document.body.dataset.localTurn = String(isMine);
    document.body.dataset.localPlayer = String(localPlayer);
    const phaseNames = { build: "FORTIFY", craft: "FORGE", aim: "TAKE AIM", resolve: "IMPACT", finished: "RESOLVED" } as const;
    const phaseNumbers = { build: "1", craft: "2", aim: "3", resolve: "4", finished: "5" } as const;
    const phaseCopy = {
      build: ["STEP 1 · FORTIFY", "Build your tower", "Tap a block to inspect it, then spend an action to upgrade or treat it. Your Aether Regent can ascend too."],
      craft: ["STEP 2 · BUILD YOUR SHOT", "Choose your projectile", "Pick one body, one element, and one flight modifier, then chamber the recipe."],
      aim: ["STEP 3 · AIM AND FIRE", "Pull back, then release", "Drag down and back anywhere on the open battlefield, then release. Or fire the recommended shot below."],
      resolve: ["SHOT IN FLIGHT", "Watch the impact", "Win by destroying the rival Regent, dropping them to the arena floor, or collapsing 70% of the tower."],
      finished: ["MATCH COMPLETE", "Regent defeated", "An Aether Regent was destroyed, touched the arena floor, or lost too much of their tower."],
    } as const;
    const rivalPhaseCopy = {
      build: ["RIVAL TURN", "Rival is defending", "Your controls will return after the rival completes their shot."],
      craft: ["RIVAL TURN", "Rival is building a shot", "The rival is choosing a projectile recipe."],
      aim: ["RIVAL TURN", "Rival is aiming", "Watch the rival launcher. Your next turn begins after their shot settles."],
      resolve: ["RIVAL SHOT IN FLIGHT", "Watch the impact", "Your next turn begins after the rival shot settles."],
      finished: phaseCopy.finished,
    } as const;
    const currentCopy = isMine || snapshot.phase === "finished" ? phaseCopy[snapshot.phase] : rivalPhaseCopy[snapshot.phase];

    required("#phaseLabel").textContent = phaseNames[snapshot.phase];
    required("#phaseNumber").textContent = phaseNumbers[snapshot.phase];
    required("#phaseEyebrow").textContent = snapshot.phase === "finished"
      ? "MATCH COMPLETE · PHASE 05"
      : `${isMine ? "YOUR TURN" : "RIVAL TURN"} · PHASE 0${phaseNumbers[snapshot.phase]}`;
    required("#turnLabel").textContent = `TURN ${String(snapshot.turn).padStart(2, "0")}`;
    required("#phaseKicker").textContent = currentCopy[0];
    required("#phaseTitle").textContent = currentCopy[1];
    required("#phaseDescription").textContent = currentCopy[2];
    required("#seedLabel").textContent = `SEED ${snapshot.seed}`;

    this.setCoreMeter("left", snapshot.coreHealth[0]);
    this.setCoreMeter("right", snapshot.coreHealth[1]);
    const leftGuardian = snapshot.blocks.find((block) => block.id === "p0_core");
    const rightGuardian = snapshot.blocks.find((block) => block.id === "p1_core");
    required("#leftCoreLabel").textContent = `${localPlayer === 0 ? "YOUR" : "RIVAL"} ${leftGuardian ? getGuardianTier(leftGuardian.upgradeLevel).title : "Aether Regent"} · LV ${leftGuardian?.upgradeLevel ?? 1}`;
    required("#rightCoreLabel").textContent = `${localPlayer === 1 ? "YOUR" : "RIVAL"} ${rightGuardian ? getGuardianTier(rightGuardian.upgradeLevel).title : "Aether Regent"} · LV ${rightGuardian?.upgradeLevel ?? 1}`;
    required("#actionPip1").classList.toggle("spent", snapshot.buildPoints < 1);
    required("#actionPip2").classList.toggle("spent", snapshot.buildPoints < 2);
    required("#actionCount").textContent = `${snapshot.buildPoints} / 2 ACTIONS`;
    required("#enemyBanner").classList.toggle("visible", !isMine && snapshot.phase !== "finished");

    const primary = required<HTMLButtonElement>("#primaryAction");
    primary.disabled = !isMine || snapshot.phase === "resolve" || snapshot.phase === "finished";
    const recommendedShot = `${Math.round(LAUNCH_CONFIG.recommendedAngle)}° / ${Math.round(LAUNCH_CONFIG.recommendedPower * 100)}%`;
    let primaryLabel = "WAIT FOR THE SHOT";
    if (!isMine && snapshot.phase !== "finished") primaryLabel = "RIVAL TURN IN PROGRESS";
    else if (snapshot.phase === "build") primaryLabel = "CONTINUE TO THE FORGE";
    else if (snapshot.phase === "craft") primaryLabel = "CHAMBER THIS RECIPE";
    else if (snapshot.phase === "aim") primaryLabel = `FIRE RECOMMENDED SHOT · ${recommendedShot}`;
    else if (snapshot.phase === "finished") primaryLabel = "MATCH COMPLETE";
    primary.querySelector("span")!.textContent = primaryLabel;
    primary.setAttribute("aria-label", snapshot.phase === "aim" && isMine ? `Fire recommended shot at ${recommendedShot}` : primary.textContent?.trim() ?? "Continue");

    const aimPrompt = required("#aimPrompt");
    const showAimHelp = snapshot.phase === "aim" && isMine;
    aimPrompt.hidden = !showAimHelp;
    aimPrompt.style.display = showAimHelp ? "" : "none";
    aimPrompt.setAttribute("aria-hidden", String(!showAimHelp));

    const guardian = snapshot.blocks.find((block) => block.id === `p${localPlayer}_core`);
    if (guardian) this.updateGuardian(guardian, snapshot.buildPoints, isMine && snapshot.phase === "build");
    if (this.selectedBlockId) {
      const selected = snapshot.blocks.find((block) => block.id === this.selectedBlockId && block.owner === localPlayer && block.kind === "block");
      this.selectBlock(selected);
    }

    if (snapshot.phase === "finished") this.showWinner(snapshot.winner, localPlayer);
  }

  setAim(angle: number, power: number): void {
    required("#angleValue").textContent = `${Math.round(angle)}°`;
    required("#powerValue").textContent = `${Math.round(power * 100)}%`;
  }

  setAimInteraction(active: boolean, ready = false): void {
    document.body.dataset.aimGesture = ready ? "ready" : active ? "pulling" : "idle";
    required("#aimInstruction").textContent = ready ? "RELEASE TO FIRE" : active ? "PULL DOWN AND BACK" : "DRAG · RELEASE TO FIRE";
  }

  selectBlock(block?: BlockRuntimeState): void {
    this.selectedBlockId = block?.id ?? null;
    const inspector = required("#blockInspector");
    const hint = required("#selectionHint");
    inspector.hidden = !block;
    hint.hidden = Boolean(block);
    if (!block) {
      required("#blockUpgradeCopy").textContent = "Select a block first";
      return;
    }
    const material = getMaterial(block.material);
    const health = Math.max(0, block.hp / block.maxHp);
    required("#selectedBlockName").textContent = material.displayName.toUpperCase();
    required("#selectedBlockLevel").textContent = `LV ${block.upgradeLevel}`;
    required("#selectedBlockHealth").textContent = `${Math.ceil(block.hp)} / ${Math.ceil(block.maxHp)} HP`;
    required<HTMLElement>("#selectedBlockHealthBar").style.width = `${health * 100}%`;
    const atMaximum = block.upgradeLevel >= FORTIFICATION_CONFIG.block.maxLevel;
    required("#selectedBlockState").textContent = atMaximum ? "MAX LEVEL" : `UPGRADE AVAILABLE · +${FORTIFICATION_CONFIG.block.hpBonusPerLevel} MAX HP`;
    required("#blockUpgradeCopy").textContent = atMaximum
      ? "Maximum level reached"
      : `LV ${block.upgradeLevel + 1} · +${FORTIFICATION_CONFIG.block.hpBonusPerLevel} HP · 1 action`;
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
      } else if (event.type === "guardianPulse") {
        line.classList.add("cold");
        line.textContent = `REGENT MENDS +${Math.round(event.amount)} HP`;
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
    required("#guardianUpgrade").addEventListener("click", this.callbacks.guardian);
    required("#primaryAction").addEventListener("click", this.callbacks.primary);
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

  private updateGuardian(guardian: BlockRuntimeState, buildPoints: number, canAct: boolean): void {
    const tier = getGuardianTier(guardian.upgradeLevel);
    const nextTier = guardian.upgradeLevel < FORTIFICATION_CONFIG.guardian.tiers.length
      ? getGuardianTier(guardian.upgradeLevel + 1)
      : null;
    required("#guardianLevel").textContent = `${tier.title.toUpperCase()} · LV ${guardian.upgradeLevel}`;
    required("#guardianUpgradeTitle").textContent = nextTier ? `ASCEND TO ${nextTier.title.toUpperCase()}` : "FULLY ASCENDED";
    required("#guardianUpgradeCopy").textContent = nextTier ? `${nextTier.description} · 1 action` : tier.description;
    required<HTMLButtonElement>("#guardianUpgrade").disabled = !canAct || buildPoints <= 0 || !nextTier;
  }

  private showWinner(winner: PlayerId | null, localPlayer: PlayerId): void {
    const won = winner === localPlayer;
    required("#winTitle").textContent = this.mode === "lab" ? "EXPERIMENT COMPLETE" : won ? "RIVAL TOWER DEFEATED" : "YOUR TOWER FELL";
    required("#winCopy").textContent = this.mode === "lab"
      ? "The laboratory is ready for another composition."
      : won
        ? "You destroyed the rival core or collapsed enough of its structure."
        : "Your core was destroyed or too much of your structure collapsed.";
    required("#winPanel").classList.add("visible");
  }
}
