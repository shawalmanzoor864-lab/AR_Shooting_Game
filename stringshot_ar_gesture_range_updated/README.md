<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/29760aa2-68d0-4674-bd16-2fb1fd521bf5

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## 3D models

The game now uses two GLB models from `public/assets/models/`:

- `samurai-edge.glb` – the pistol held in your hand (1K textures; 2K version is ~20 MB)
- `shooting-range-target.glb` – the hanging target (scored from its texture: chest/head rings = 100/75/50, body = 25, wooden stand = no score)

Models are loaded with `loadGameModels()` in `src/game/models.ts`.
