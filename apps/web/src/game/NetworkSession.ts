import { Client, type Room } from "@colyseus/sdk";
import type { MatchSnapshot, PlayerCommand, PlayerId, SimEvent } from "@matter-siege/shared";

export interface NetworkHandlers {
  snapshot: (snapshot: MatchSnapshot) => void;
  events: (events: SimEvent[]) => void;
  status: (message: string, connected: boolean) => void;
  rejected: (reason: string) => void;
}

export class NetworkSession {
  playerId: PlayerId = 0;
  private room?: Room;

  constructor(private readonly handlers: NetworkHandlers) {}

  async connect(): Promise<void> {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const endpoint = import.meta.env.VITE_SERVER_URL ?? `${protocol}://${window.location.hostname}:2567`;
    this.handlers.status("CONNECTING", false);
    const client = new Client(endpoint);
    const room = await client.joinOrCreate("matter_siege");
    this.room = room;

    room.onMessage("welcome", (message: { playerId: PlayerId }) => {
      this.playerId = message.playerId;
      this.handlers.status(`ONLINE · P${message.playerId + 1}`, true);
    });
    room.onMessage("snapshot", (snapshot: MatchSnapshot) => this.handlers.snapshot(snapshot));
    room.onMessage("events", (events: SimEvent[]) => this.handlers.events(events));
    room.onMessage("commandRejected", (message: { reason?: string }) => this.handlers.rejected(message.reason ?? "Command rejected"));
    room.onLeave(() => this.handlers.status("DISCONNECTED", false));
    room.onError((_code, message) => this.handlers.status(message || "NETWORK ERROR", false));
    room.send("sync");
  }

  send(command: PlayerCommand): void {
    this.room?.send("command", command);
  }

  async leave(): Promise<void> {
    if (this.room) await this.room.leave();
    this.room = undefined;
  }
}
