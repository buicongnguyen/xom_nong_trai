# Code and logic review — 2026-10-12

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

## Still incomplete

- The original React/TypeScript source, private backend, exact balance, prices, drop rates, and server rules have not been recovered.
- Online accounts/cloud saves, multiplayer visits/help, chat, trading/market, villages, leaderboards, payments, ads, and online events remain unavailable or empty placeholders.
- Some visible local client actions still lack implementations: hiring factory workers, uprooting crops, peaceful-mode changes, and rerolling daily quests.
- Seed-shop daily limits, home-change restrictions, order rerolls, animal problem generation, worker production, and some upgrade rules still need a full behavior specification and review.
- Quests depending on unavailable online actions cannot be completed. This review verifies supported early progression and the identified regressions, not all 200 levels or all original features.
- Browser saves remain device/browser-specific. A browser without Web Locks cannot safely run this edition; startup shows a reload/browser-storage message.

## Validation

- 29 deterministic backend tests cover farming/animals/production, queue scheduling, transaction and save failures, tutorial filters/levels, daily rollover, care, fertilizer/soil, placement limits and layouts, clock continuity, and existing-save migration.
- Seven isolated browser cases cover stale-tab unload, alternating transactions, simultaneous transactions, cross-tab world updates, passive construction completion, and reset/replacement protection. The reusable harness is `scripts/browser-save-qa.cjs` (requires Playwright; supports `XNT_PLAYWRIGHT_MODULE` and `XNT_CHROME_PATH`).
- Original client schema validation and desktop/mobile browser checks run before publication. Visual evidence is stored with the review QA artifacts.

Existing player saves are retained and migrated. Existing tabs must be refreshed to use the corrected runtime; an already-open old version still has its old unload handler.
