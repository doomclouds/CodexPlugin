# Asset Manifest Schema

Design slug: `{{DESIGN_SLUG}}`

Use this reference when a UI design package needs runtime bitmap assets.

## Strategies

- `none`: the UI uses standard controls and icon libraries only.
- `atomic-generated-assets`: the UI needs package-local bitmap textures, photos, decorations, avatars, product imagery, or other generated assets.

## Required Rich Asset Shape

```json
{
  "id": "paper-texture",
  "role": "paper grain material",
  "target_region": "WritingSanctuary",
  "display_intent": "cover editor paper surface",
  "target_size": "1024x1024",
  "final_path": "assets/component-assets/paper-texture.png",
  "prototype_path": "prototype/src/assets/generated/paper-texture.png",
  "transparent": false,
  "validation": "pending"
}
```

## Hard Rules

- The approved source image is visual truth, not a sprite sheet.
- Do not crop final runtime assets from the full-screen mock.
- Do not point manifest paths outside the design package.
- Transparent PNG assets must contain an alpha channel.
- Rich packages with bitmap assets use `atomic-generated-assets`.
