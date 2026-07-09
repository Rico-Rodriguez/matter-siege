import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import cors from "cors";
import express from "express";
import { MatterSiegeRoom } from "./rooms/MatterSiegeRoom.js";

const port = Number(process.env.PORT ?? 2567);
const gameServer = new Server({
  transport: new WebSocketTransport(),
  express: (app) => {
    app.use(cors());
    app.use(express.json({ limit: "32kb" }));
    app.get("/health", (_request, response) => {
      response.json({ ok: true, game: "Matter Siege", simulation: "authoritative", transport: "websocket" });
    });
  },
});

gameServer.define("matter_siege", MatterSiegeRoom);
await gameServer.listen(port);
console.log(`Matter Siege authority listening on http://localhost:${port}`);
