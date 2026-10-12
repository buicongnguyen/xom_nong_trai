# Code, logic and frontend review — 2026-10-13

The published application is an independent single-player recreation. The public compiled client and artwork were mirrored; the original server and authenticated configuration were unavailable. Deployment and loading were verified earlier, but that did not establish complete gameplay parity.

## Confirmed issues fixed in this review

| Priority | Reproduction / consequence | Correction |
| --- | --- | --- |
| P1 | A second tab closed after a harvest restores its older save; simultaneous purchases/sales lose changes. | Serialize initialization and API transactions with a project-wide Web Lock, reload the latest save under the lock, remove unload writes, and synchronize world changes between tabs. A reset invalidates stale tabs. |
| P1 | Buying a field leaves m03 at zero. Producing and collecting feed leaves m08/m09 at zero. | Record BUY_FIELD, JOB_START and COLLECT_PRODUCT with the metadata required by quest definitions. Reconstruct historical field purchases when migrating older saves. |
| P1 | Tutorial freezes at index 12, accepts unrelated buildings or an unfertilized harvest, and asks for one-second crop actions. | Match all 25 client indices, action metadata and level gates; skip online-only steps; keep short timers readable with a 1× default. Completed sugar construction skips its now-impossible speed-up lesson. |
| P2 | Selecting a crop leaves a bright rectangle and a dark farm/HUD. | Remove the tutorial/quest spotlight's blanket dark shadow and background while retaining the target outline and instruction card. |
| P2 | Repeated care on a healthy or empty field grants XP, levels and gold. Actual care quests are impossible. | Generate scheduled crop problems, consume the configured repair tool, and award XP/FIX_PROBLEM only for an actual repair. |
| P2 | Daily quests remain claimed forever. | Reset daily progress and claims on the real Vietnam calendar day; preserve main quests. Fast growth does not accelerate daily rewards. |
| P2 | Cancelling a waiting production batch leaves its time gap. Speeding up a waiting batch completes it before the active batch. | Close the cancelled queue gap, keep queued speed-ups behind earlier jobs, and reject full refunds on running jobs. |
| P2 | Shop limits show two coops while purchases allow three; multiple buildings construct despite maxConcurrent=1. | Enforce ownership and construction limits before charging. |
| P2 | Fertilizer subtracts 20 seconds from the whole crop rather than its current stage; upgraded soil changes duration but not yield. | Apply the configured stage reduction cap and soil yield multiplier; preserve subsequent stage timings. |
| P2 | Valid layout swaps fail, invalid rotations pass, and storing objects can leave stale rendered objects. | Validate the final batch layout atomically, accept only rotations 0/1, and publish removals for stored objects. |
| P2 | Completed construction and stage changes require a reload. | Publish passive world changes every second in both browser and Node editions. |
| P2 | Notification failure reports an error after saving a purchase, leaving memory and disk inconsistent. A wrong-method request can partially mutate a batch. | Commit once after full validation/progression; roll back failed saves, isolate notification errors, and reject wrong methods. |
| P2 | Planting, feeding, field purchases and decor omit configured XP. | Award XP at the successful action; bag placement does not award purchase XP again. |
| P2 | Cached chunks can retain older behavior; inconsistent main-module URLs would separate lazy panels from the visible farm's stores. | Version the runtime and every client module URL consistently, including lazy imports and preloads. Browser checks confirm one module instance and one game canvas. |
| P2 | Another tab updates farm objects while this tab's money, storage and HUD remain stale. | Refresh the wallet and storage stores when the saved farm changes; resynchronize the world when owner, region, bag, zones or dog state changes. |
| P2 | Worker hire, crop uproot, peaceful mode and daily reroll controls call missing local routes. | Implement worker prices, ordered seats, renewals and parallel production; uproot growing crops without a seed refund; persist the boolean peaceful setting; replace one daily quest per slot for the configured Xu cost. |
| P2 | Each running worker's speed-up button targets queue index 0. | Pass the selected row's actual queue index; shorten only that worker's lane and preserve other workers' timers. |
| P2 | Seed purchases sent with `currency: "xu"` spend gold; quantities allowed by the UI fail above 99; quotas never decrease. | Honor the frontend currency field and configured request maximum, track daily allowances separately per crop/currency, and report the actual allowance remaining. Failed purchases consume neither money nor quota. |
| P2 | A purchased dog has no implemented feeding action or guard timer. | Consume configured dog food, add its duration to the remaining timer, enforce the stack cap atomically, and expire the active flag when food runs out. |
| P2 | Province IDs do not match the interactive map; home changes and some offline responses fail the client's response contracts. | Use the map's canonical province IDs, migrate saved aliases and return the direct Home response expected by the picker. Validate local and disabled responses against the original client's schemas. |
| P2 | Unsupported online panels make failing API calls, and level 3 automatically opens an unusable account registration form. | Explain online availability before opening those panels, suppress automatic registration prompts, and route manual account-save requests to the same dismissible notice. |

## Still incomplete

- The original React/TypeScript source, private backend, exact balance, prices, drop rates, and server rules have not been recovered.
- Online accounts/cloud saves, multiplayer visits/help, chat, trading/market, villages, leaderboards, payments, ads, and online events remain unavailable or empty placeholders.
- Home-change restrictions, order generation/rerolls, animal problem generation and some upgrade rules still need a full behavior specification and review.
- Quests depending on unavailable online actions cannot be completed. This review verifies supported early progression and the identified regressions, not all 200 levels or all original features.
- Browser saves remain device/browser-specific. A browser without Web Locks cannot safely run this edition; startup shows a reload/browser-storage message.

## Validation

- All 53 backend regression cases pass: the earlier 29 gameplay/save cases, 10 local-action cases, eight original-client contract cases and six dog/seed cases. New coverage includes worker prices/order/renewal/expiration, parallel lane scheduling and speed-ups, crop uprooting, daily rerolls, peaceful settings, dog feeding, selected seed currency, request maximums and persisted daily allowances.
- Seven isolated browser cases cover stale-tab unload, alternating transactions, simultaneous transactions, cross-tab world updates, passive construction completion, and reset/replacement protection. The reusable harness is `scripts/browser-save-qa.cjs` (requires Playwright; supports `XNT_PLAYWRIGHT_MODULE` and `XNT_CHROME_PATH`).
- 18 mobile panel-close checks pass. Desktop/mobile startup and the shared client-module build were also checked without page or console errors.
- Actual map and factory UI checks pass: selecting Cần Thơ updates the HUD and survives reload; hiring worker 2 starts two parallel jobs; speeding up the second row completes only its product. Two-tab wallet/storage synchronization and all eight guarded menu actions pass. Original client configuration/API schemas and local asset references pass validation. Visual evidence is stored in `reference/qa/frontend-2026-10-13/`.

Existing player saves are retained and migrated. Existing tabs must be refreshed to use the corrected runtime; an already-open old version still has its old unload handler.
