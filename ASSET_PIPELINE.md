# Asset pipeline

Runtime combat geometry is procedural. External GLB cosmetics must pass these budgets before inclusion:

```json
{
  "maxTriangles": 5000,
  "maxTextureSize": 1024,
  "maxFileSizeMb": 2,
  "requiresLod": true,
  "requiresKtx2": true,
  "requiresPbrMaps": ["baseColor", "normal", "roughness"]
}
```

Generated assets must be validated, optimized, thumbnail-rendered, and manually approved. No generated asset may affect simulation dimensions or collision rules.

