# Matter Siege

Matter Siege is a browser-native 2.5D physics duel: reinforce a miniature material tower, forge elemental ammunition, and collapse the rival core with readable chain reactions.

This repository is a playable vertical slice and production foundation built around a strict rule: gameplay is deterministic 2D simulation; Babylon.js renders the cinematic 3D interpretation.

## What is playable

- A complete local duel against an alchemist AI, with build, forge, aim, launch, resolve, win, and rematch phases.
- A Lab mode for rapidly testing recipes and material reactions.
- Seven tower materials, five elements, three projectile bodies, three modifiers, and wet/frozen/burning/charged/corroded states.
- Rapier2D tower and projectile physics under a procedural Babylon.js miniature diorama.
- Fire spread, water extinguishing, ice brittleness, acid corrosion, lightning conduction, break events, debris, particles, bloom, camera shake, and synthesized sound.
- Seeded simulation snapshots and command logs suitable for deterministic replays.
- A Colyseus authoritative room that accepts player commands and broadcasts compact snapshots/events.

## Run it

```bash
npm install
npm run dev
```

Open the Vite URL, select **Enter the workshop**, then drag backward from the glowing launcher and release.

For the multiplayer server:

```bash
npm run dev:server
```

The server exposes a health endpoint at `http://localhost:2567/health` and the `matter_siege` Colyseus room over WebSockets.

## GitHub Pages

The local duel and Lab are deployable as a static GitHub Pages build. The repository includes a Pages workflow at `.github/workflows/deploy-pages.yml`.

GitHub Pages cannot run the Node/Colyseus authority, so the published Online mode requires a separately hosted server with `VITE_SERVER_URL` configured at build time.

## Verification

```bash
npm run verify
```

## Architecture

- `apps/web`: Babylon.js renderer, HUD, local duel/Lab controller, audio, VFX.
- `apps/server`: Colyseus authoritative room and command validation.
- `packages/shared`: protocols, content types, and canonical content loading.
- `packages/sim`: Babylon-free Rapier2D simulation and replay support.
- `content`: gameplay-affecting JSON catalogs.

See [AGENTS.md](./AGENTS.md), [CONTENT_RULES.md](./CONTENT_RULES.md), [NETCODE_RULES.md](./NETCODE_RULES.md), and [VISUAL_STYLE_GUIDE.md](./VISUAL_STYLE_GUIDE.md) before extending the game.
