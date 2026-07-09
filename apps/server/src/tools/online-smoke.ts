import { Client } from "@colyseus/sdk";
import type { MatchSnapshot } from "@matter-siege/shared";

const endpoint = process.env.MATTER_SIEGE_SERVER ?? "ws://127.0.0.1:2567";
const room = await new Client(endpoint).joinOrCreate("matter_siege");
const snapshot = await new Promise<MatchSnapshot>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Timed out waiting for an authoritative snapshot")), 3_000);
  room.onMessage("welcome", () => undefined);
  room.onMessage("snapshot", (value: MatchSnapshot) => {
    clearTimeout(timeout);
    resolve(value);
  });
  room.send("sync");
});

console.log(JSON.stringify({ joined: true, roomId: room.roomId, tick: snapshot.tick, phase: snapshot.phase }));
await room.leave();
