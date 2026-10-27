# Xóm Nông Trại — local edition

A local single-player recreation of [nongtrai.jackle.dev](https://nongtrai.jackle.dev/), in this repository. It preserves the publicly served React/Three.js client, 3D models, textures, Vietnamese/English interface, fonts, and music, and supplies an independently implemented Node.js game server.

## Browser test on GitHub Pages

Play at **https://buicongnguyen.github.io/xom_nong_trai/** and choose **Chơi ngay**. The Pages edition runs the same farming engine in your browser, with automatic saves in this browser's localStorage. Progress stays on this device/browser. Growth uses real time and guest play; online accounts and multiplayer are unavailable. Browser locks serialize changes across tabs. Farm objects, wallet balances, storage and the HUD refresh when another tab changes the save. Deployment versions the runtime and client module URLs together so cached lazy panels share the current game state.

The public source repository is **https://github.com/buicongnguyen/xom_nong_trai**, with SSH remote `git@github.com:buicongnguyen/xom_nong_trai.git`, matching the neighboring `cute_game` repo. Pushes to `main` test and build the app, then deploy it through `.github/workflows/pages.yml`.

```powershell
npm ci
npm run build:pages
```

The browser build is `.pages/`. Its routing settings are in `config/pages.json`; `browser/` adapts the shared backend to browser storage and local events. The existing Node server remains available below.
## Run

Requires Node.js 22 or newer. There are no runtime packages to install.

```powershell
cd C:\Users\n\source\repos\xom_nong_trai
npm start
```

Open **http://127.0.0.1:5173** and choose **Chơi ngay**. Use the existing tutorial or **Để sau** to explore freely. Drag the farm to pan, scroll to zoom, and select fields/buildings to interact. The interface also supports touch controls and English in settings.

`npm run dev` restarts the server when its source changes.

## Local gameplay

Plant, tend, fertilize, harvest or uproot crops; buy and care for animals; produce goods with rented factory workers; grow fruit trees; feed your farm dog; buy, place, move, store, and sell farm objects; expand land; sell inventory; complete orders and quests; reroll daily quests; claim daily rewards; upgrade storage; and earn experience. Peaceful mode can be changed in settings.

Factory workers run parallel batches, can be renewed, and finish an active batch when their rental expires. Uprooting discards the crop and its seeds. A daily quest slot can be rerolled once for Xu. Seed purchases charge the selected currency, apply the configured request maximum and daily allowance, and reset their allowances on the real Vietnam calendar day. Dog food extends its guard timer up to the configured 24-hour stack limit.

Progress is saved automatically to **`.local/farm.json`** and survives server restarts. This edition uses one local farm shared by browsers connecting to this server. QA uses a separate save directory.

Time runs at **1×** by default so tutorial actions can be completed before crops mature. To accelerate growth for testing or use another port:

```powershell
$env:GAME_SPEED = '30'
$env:PORT = '5180'
npm start
```

Optional variables: `GAME_SPEED` (positive multiplier), `PORT` (default 5173), `HOST` (default 127.0.0.1), and `DATA_DIR` (save folder).

## Source and scope

- `src/backend.mjs`: editable farming rules, persistence, inventory, economy, and client API adapter.
- `config/game.json`: editable local definitions and balance. The original server's authenticated configuration was unavailable, so these values were reconstructed to fit the public client's schemas.
- `server.mjs`: HTTP/static server and local WebSocket events.
- `public/`: mirrored public browser build and self-contained assets. This is compiled client code; the original React/TypeScript source and server source were not available.
- `reference/`: preserved original HTML/client and asset provenance.
- `scripts/`: asset audits and configuration/schema validation tools.
- `tests/`: gameplay, persistence, client contract and local action regression tests.

Online multiplayer, original accounts, visits to real players, chat, leaderboards, payments, and multiplayer minigames require the original service and are not reproduced by this local server. Unsupported online panels show a local availability notice and can be closed. Local progress is independent of the original game. Cloudflare telemetry/challenge scripts were removed from the local HTML.

The review findings, fixes, and remaining local gaps are recorded in [REVIEW.md](REVIEW.md). This remains an independent single-player recreation, with reconstructed balance rather than the original server's rules. Refresh all existing game tabs after an update to load the latest saving logic.

## Verify

```powershell
npm run check
npm test
node scripts/validate-config.cjs
node scripts/backend-schema-smoke.mjs
node scripts/audit-assets.cjs
```

The browser QA report and desktop/mobile screenshots are in `reference/qa/`. Regression coverage includes farming and production, worker rentals, dog timers, seed allowances, tutorial and quest progression, client response schemas, failed transactions, saves and migration. Browser checks cover cross-tab saving and 18 mobile panel-close flows. See [REVIEW.md](REVIEW.md) for validation status and remaining limits.

Optional browser regressions require Playwright and Chrome (or Playwright's installed Chromium). They create isolated browser contexts and disposable farms. Point `XNT_QA_URL` at a served Pages build; the flow test requires browser-local saves and does not modify the Node server's farm.

```powershell
$env:XNT_QA_URL = 'https://buicongnguyen.github.io/xom_nong_trai/'
# Set XNT_PLAYWRIGHT_MODULE or XNT_CHROME_PATH if they are installed elsewhere.
node scripts/browser-save-qa.cjs
node scripts/frontend-browser-qa.cjs
node scripts/frontend-menu-qa.cjs
node scripts/frontend-flow-qa.cjs
```

Reports from these scripts go into ignored `.local/review-qa/`. `npm run build:pages` also applies the guarded, repeatable fixes to the preserved compiled client.

Reference client and artwork: Xóm Nông Trại. The local server and configuration are independently implemented.

## Renderer performance review

`npm run qa:render` runs isolated mobile renderer checks against a running Pages preview (default port 4198). It requires Playwright; set `XNT_PLAYWRIGHT_MODULE` and `XNT_CHROME_PATH` for existing installations, `XNT_QA_URL` for another deployment, and `XNT_PERF_DESKTOP=1` for desktop. Reports and comparison images go into `.local/review-qa/`. The harness counts WebGL submissions including shadows and WEBGL_multi_draw, compares frozen images and null controls, tests quality changes, and checks texture disposal. It uses a disposable browser profile.

The review adapts Claude’s shared `smooth-dense-scenes` skill, also used by `3D_game_scene`, to this client’s Three.js r186. Existing scenery batching is retained. Fireflies now share one instanced draw; postprocessing teardown disposes all passes and both composer targets. Changes are guarded by `scripts/patch-client.mjs`.

The local CPU/buffer review and measured limitations are in [PERFORMANCE_REVIEW.md](PERFORMANCE_REVIEW.md). Run `npm run qa:cpu` for transform/upload, visual and memory checks; `node scripts/performance-controls-qa.cjs` checks desktop and touch camera controls. Both use the same QA environment variables described above.
