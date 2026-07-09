# Netcode rules

- Simulation steps at 30 Hz on the server.
- Snapshots broadcast at 15 Hz; clients interpolate transforms.
- Inputs contain player ID by server association, never by client authority.
- Store match seed, simulation version, and accepted command log for replay.
- Synchronize block/projectile transforms, statuses, phase, timer, core health, and semantic VFX events.
- Never synchronize individual smoke puffs, sparks, shards, or camera motion.

