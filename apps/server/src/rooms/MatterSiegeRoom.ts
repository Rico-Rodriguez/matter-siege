import { Schema, defineTypes } from "@colyseus/schema";
import { Room, type Client } from "@colyseus/core";
import type { MatchSnapshot, PlayerId } from "@matter-siege/shared";
import { MatterSimulation, SIM_HZ } from "@matter-siege/sim";
import { isPlayerCommand } from "../protocol.js";

class MatterRoomState extends Schema {
  tick = 0;
  phase = "booting";
  activePlayer = 0;
  playerCount = 0;
  coreLeft = 100;
  coreRight = 100;
}

defineTypes(MatterRoomState, {
  tick: "number",
  phase: "string",
  activePlayer: "number",
  playerCount: "number",
  coreLeft: "number",
  coreRight: "number",
});

export class MatterSiegeRoom extends Room<{ state: MatterRoomState }> {
  maxClients = 2;
  private simulation!: MatterSimulation;
  private readonly players = new Map<string, PlayerId>();

  async onCreate(options: { seed?: number } = {}): Promise<void> {
    this.setState(new MatterRoomState());
    this.patchRate = 1000 / 15;
    this.simulation = await MatterSimulation.create({ seed: options.seed ?? Math.floor(Math.random() * 2_147_483_647) });
    this.state.phase = this.simulation.phase;

    this.onMessage("command", (client, payload: unknown) => {
      const playerId = this.players.get(client.sessionId);
      if (playerId === undefined || !isPlayerCommand(payload)) {
        client.send("commandRejected", { reason: "Malformed or unauthenticated command" });
        return;
      }
      const result = this.simulation.applyCommand(playerId, payload);
      if (!result.ok) client.send("commandRejected", { reason: result.error });
    });
    this.onMessage("sync", (client) => {
      const playerId = this.players.get(client.sessionId);
      if (playerId === undefined) return;
      client.send("welcome", { playerId, seed: this.simulation.seed, tickRate: SIM_HZ });
      client.send("snapshot", this.simulation.snapshot());
    });

    this.clock.setInterval(() => this.authoritativeTick(), 1000 / SIM_HZ);
  }

  onJoin(client: Client): void {
    const occupied = new Set(this.players.values());
    const playerId: PlayerId = occupied.has(0) ? 1 : 0;
    this.players.set(client.sessionId, playerId);
    this.state.playerCount = this.players.size;
  }

  onLeave(client: Client): void {
    this.players.delete(client.sessionId);
    this.state.playerCount = this.players.size;
  }

  onDispose(): void {
    const replay = this.simulation?.exportReplay();
    if (replay) this.broadcast("replay", replay);
  }

  private authoritativeTick(): void {
    this.simulation.step();
    const snapshot = this.simulation.snapshot();
    this.copyState(snapshot);
    const events = this.simulation.drainEvents();
    if (events.length > 0) this.broadcast("events", events);
    if (snapshot.tick % 2 === 0) this.broadcast("snapshot", snapshot);
  }

  private copyState(snapshot: MatchSnapshot): void {
    this.state.tick = snapshot.tick;
    this.state.phase = snapshot.phase;
    this.state.activePlayer = snapshot.activePlayer;
    this.state.coreLeft = snapshot.coreHealth[0];
    this.state.coreRight = snapshot.coreHealth[1];
  }
}
