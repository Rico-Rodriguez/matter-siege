# Matter Siege agent rules

1. `packages/sim` must never import Babylon.js, DOM APIs, audio APIs, or client code.
2. All gameplay-affecting material and projectile values belong in `content/` JSON.
3. Server state is authoritative. Clients submit intents, never damage or win claims.
4. Cosmetic debris and particles are not synchronized. Synchronize the event that caused them.
5. Every gameplay change needs a deterministic simulation test.
6. Preserve the 2D simulation plane. Extra 3D motion is visual-only.
7. Keep the initial page useful at 1280×720 and at narrow desktop widths.

