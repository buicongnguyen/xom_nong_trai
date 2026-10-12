# Xóm Nông Trại — local edition

A local single-player recreation of [nongtrai.jackle.dev](https://nongtrai.jackle.dev/), in this repository. It preserves the publicly served React/Three.js client, 3D models, textures, Vietnamese/English interface, fonts, and music, and supplies an independently implemented Node.js game server.

## Browser test on GitHub Pages

Play at **https://buicongnguyen.github.io/xom_nong_trai/** and choose **Chơi ngay**. The Pages edition runs the same farming engine in your browser, with automatic saves in this browser's localStorage. Progress stays on this device/browser. Growth uses real time and guest play; online accounts and multiplayer are unavailable. Browser locks serialize changes across tabs, and each tab refreshes completed timers and saved changes automatically.

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

Plant, tend, fertilize, and harvest crops; buy and care for animals; produce goods; grow fruit trees; buy, place, move, store, and sell farm objects; expand land; sell inventory; complete orders and quests; claim daily rewards; upgrade storage; and earn experience.

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
- `tests/`: persistent gameplay regression test.

Online multiplayer, original accounts, visits to real players, chat, leaderboards, payments, and multiplayer minigames require the original service and are not reproduced by this local server. Online-only actions return a local availability message. Local progress is independent of the original game. Cloudflare telemetry/challenge scripts were removed from the local HTML.

The review findings, fixes, and remaining local gaps are recorded in [REVIEW.md](REVIEW.md). This remains an independent single-player recreation, with reconstructed balance rather than the original server's rules. Refresh all existing game tabs after an update to load the latest saving logic.

## Verify

```powershell
npm run check
npm test
node scripts/validate-config.cjs
node scripts/backend-schema-smoke.mjs
node scripts/audit-assets.cjs
```

The browser QA report and desktop/mobile screenshots are in `reference/qa/`. The farm, API mutation schemas, crop/animal/production timers, transaction rollback, experience progression, and save/reload were checked.

Reference client and artwork: Xóm Nông Trại. The local server and configuration are independently implemented.
