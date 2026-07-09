import "./styles.css";
import { AudioDirector } from "./game/AudioDirector.js";
import { GameController } from "./game/GameController.js";
import { SceneWorld } from "./game/SceneWorld.js";

const canvas = document.querySelector<HTMLCanvasElement>("#renderCanvas");
const enterButton = document.querySelector<HTMLButtonElement>("#enterButton");
if (!canvas || !enterButton) throw new Error("Matter Siege could not mount its battlefield");

enterButton.disabled = true;
enterButton.querySelector("span")!.textContent = "Preparing the workshop";

const audio = new AudioDirector();
const world = new SceneWorld(canvas);
await world.initialize();
const game = new GameController(canvas, world, audio);
game.hud.setRendererLabel(world.rendererLabel);

enterButton.disabled = false;
enterButton.querySelector("span")!.textContent = "Enter the workshop";
const enterWorkshop = async (unlockAudio = true): Promise<void> => {
  enterButton.disabled = true;
  if (unlockAudio) await audio.unlock().catch(() => undefined);
  await game.startMode("duel");
  game.hud.reveal();
};
enterButton.addEventListener("click", () => void enterWorkshop());

if (new URLSearchParams(window.location.search).has("autostart")) await enterWorkshop(false);
