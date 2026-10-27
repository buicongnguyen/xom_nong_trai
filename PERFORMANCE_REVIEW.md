# Farm performance review — 2026-10-25

## Outcome and scope

Reviewed `xom_nong_trai` using `C:\Users\n\.claude\skills\smooth-dense-scenes\SKILL.md` and its CPU/buffer reference. The requested `C:\Users\n.claude\...` path did not exist; the installed skill is under `n\.claude`.

Implemented local pose caching and selective instance/opacity uploads. In the frozen desktop and phone-sized fixtures, matrix compositions fell **686 → 141 per frame**, matrix multiplications fell **712 → 311 desktop / 693 → 292 mobile**, and unchanged buffer uploads fell **8 calls / 2,488 bytes → zero**. Draws, triangles and geometry storage stayed unchanged. These are measured work reductions, **not proven FPS improvements**. Timing results were inconsistent on this shared machine.

This review was completed locally without publishing on 2026-10-25. Publication to GitHub Pages was subsequently requested on 2026-10-28. Baseline: commit `46277368247c823100b6635e2ebffd89426335a7`, which already includes firefly instancing and the composer texture cleanup. This review does not count those earlier improvements again.

## Engine and architecture

The preserved compiled client contains **Three.js r186**, confirmed in the actual engine implementation, rather than the skill recipes' r180/r185. Original React/TypeScript sources are unavailable. Changes are kept in readable helper modules and a guarded, idempotent patch script; no engine prototypes are modified in production.

Existing architecture already uses BatchedMesh/material batching, instanced ambient animals, flora culling, adaptive quality, throttled shadows, pause behavior and an effect sprite pool. The prior firefly batch is retained. Graphics quality, densities, textures, shadows, resolution, animation cadence and gameplay rules were not lowered.

## Method

- Chrome/ANGLE D3D11, NVIDIA RTX 4080 SUPER. Desktop viewport 1440×1000, DPR 1; mobile emulation 390×844, DPR 2. Both use High quality and **4× CPU throttling**. This is not physical-phone GPU, thermal or battery testing.
- Fresh isolated browser farms; before/after arms share the same farm, camera, quality and loaded assets. Different runs can generate different scenery. Within each comparison, cosmetic time is fixed for frozen work and images; moving samples advance it and ambient simulation by 1/60 second. Moving arms are successive simulation intervals, not a replay of identical random animal trajectories.
- Eight warm-up frames, 20 frozen samples, 30 moving samples. Shadow rendering is explicitly requested on every sampled frame: this includes its cost and represents a shadow-updating frame, not the game's normal amortized shadow cadence.
- Instrument actual WebGL draws, including `WEBGL_multi_draw`, shadow and postprocessing passes. One multi-draw API submission is counted as one call; its contained triangles are summed. Count `Matrix4.compose` and `multiplyMatrices`, `bufferData` allocation and `bufferSubData` traffic, including WebGL2 element-offset/length overloads. Also observe typed-array `texSubImage2D` updates.
- Remove all operation-count wrappers before timing. For each scenario use 12 interleaved original/optimized pairs, four frames per arm, and 12 identical optimized/optimized pairs. Before each arm, warm once after switching paths. The original mode uses the original calculation/upload behavior through the same small dispatch hooks.
- Profile the real running loop for four seconds with CDP, separately from work-count instrumentation. Record geometry/texture/program counts, unique geometry/instance array bytes, and garbage-collected JS heap/backing storage over three low→high quality cycles.
- Compare frozen day/night, selection and active splash screenshots against both original and unchanged-control captures. The test tolerates at most two RGB levels; measured differences were no greater than one.

## Findings and implementation

### Repeated transforms

The normal Three traversal recomposed unchanged local transforms, marking whole descendant trees dirty, including hidden nodes and repeated postprocessing scene traversal. This was the largest clearly removable arithmetic workload. Native WebGL submission/state changes also appear prominently in CPU samples; fewer matrix operations do not establish that transforms dominate total frame time. Initial profiles also contain shader-program completion work and idle time, so sample percentages are not a clean frame-cost attribution.

`public/assets/cpu-optimizations.mjs` opts live farm nodes into a ten-component, Float64 pose cache. It skips local composition only when position, quaternion and scale are unchanged. Native world traversal, dirty flags, explicit updates and parent propagation remain intact. Parent identity invalidates reparented objects. New children are registered through r186 `childadded` events, avoiding another full traversal every frame. Weak collections do not retain removed nodes.

Cameras, bones, skinned meshes and custom local/world update implementations are excluded. Manual local/world matrices and pivot transforms use the original path. The cache temporarily changes `matrixAutoUpdate` only during an unchanged traversal and restores it in `finally`. Explicit `updateMatrix` and `updateWorldMatrix` remain untouched, including parent-first picking updates.

### Unchanged instance uploads

Ambient `map_life` producers and the existing firefly batch marked their buffers dirty even for identical values. Selected instance writers now compare Float32-rounded matrix components with their stored slots. They copy only changed matrices and upload one bounded component range. New ranges union with pending ranges so hiding or culling an object before upload cannot lose an earlier edit. Other producers remain on their original path.

Firefly opacity is also compared at Float32 precision and uploads only its changed range. The existing camera-facing geometry, depth ordering, separate opacities, movement, fade-in/out and quality counts remain intact. Moving fireflies still require uploads; zero frozen uploads is not a claim about normal animated gameplay.

### Particle effects

Splash, poof and sparkle effects already reuse sprites and stop updating when their active list empties. They do not repeatedly upload a full empty particle buffer. Replacing this pool with another renderer was not justified by the measured workload and could alter rotation, transparency and effect ordering. Retained it, applied the safe transform handling to its live nodes, and verified expiry, removal and reuse. The previous firefly instancing remains the useful particle batching optimization.

## Work counts

Per-frame averages below. Draws include shadows and postprocessing. Values come from the final local reports; the exact scenery totals vary between fresh farms.

| Frozen fixture | Desktop before → after | Mobile before → after |
| --- | ---: | ---: |
| Matrix compositions | 686 → 141 | 686 → 141 |
| Matrix multiplications | 712 → 311 | 693 → 292 |
| Raw draw submissions | 111 → 111 | 92 → 92 |
| Shadow submissions | 16 → 16 | 16 → 16 |
| Postprocessing submissions | 15 → 15 | 15 → 15 |
| Triangles | 180,797 → 180,797 | 78,707 → 78,707 |
| Buffer upload calls | 8 → 0 | 8 → 0 |
| Buffer upload bytes | 2,488 → 0 | 2,488 → 0 |

| Moving fixture | Desktop before → after | Mobile before → after |
| --- | ---: | ---: |
| Matrix compositions | 686 → 154.93 | 686 → 154.93 |
| Matrix multiplications | 713.37 → 312.37 | 694.37 → 293.37 |
| Draw submissions | 112.37 → 112.37 | 93.37 → 93.37 |
| Buffer upload calls | 8 → 6 | 8 → 6.87 |
| Buffer upload bytes | 2,488 → 1,660.53 | 2,488 → 1,630.67 |

No new `bufferData` allocations or typed-array `texSubImage2D` calls occurred in these warmed sample windows. Moving upload savings depend on which animals/slots change; the frozen comparison is the stronger exact redundancy check.

## Timing and FPS limits

Final measurements, milliseconds of synchronous update/render work, not GPU completion time or display FPS:

| Fixture | Original median | Optimized median | Identical-arm medians | Median absolute identical-pair difference |
| --- | ---: | ---: | ---: | ---: |
| Desktop frozen | 5.3 | 7.4 | 7.3 / 7.9 | 3.2 |
| Desktop moving | 10.1 | 10.5 | 9.8 / 9.5 | 2.8 |
| Mobile frozen | 7.8 | 2.6 | 3.7 / 2.1 | 4.2 |
| Mobile moving | 6.2 | 4.9 | 3.1 / 3.8 | 6.8 |

These mixed directions must not be presented as a speedup. An earlier mobile run reported moving 1.6→2.3 ms, while the repeat reversed direction; an earlier desktop run reported moving 7.3→6.6 ms. Individual identical-arm pairs swung far more than their pooled medians suggest. The mobile frozen apparent gain also did not reproduce consistently. There is no established FPS improvement, and timing does not rule out a device-specific regression. The accepted result is less redundant work with unchanged tested behavior; physical-device profiling remains necessary before claiming faster gameplay.

## Memory

| Warm fixture resource | Desktop before → after | Mobile before → after |
| --- | ---: | ---: |
| Unique geometry/instance typed-array bytes | 11,639,898 → 11,639,898 | 11,567,636 → 11,567,636 |
| GPU geometry count | 70 → 70 | 55 → 55 |
| Texture count | 75 → 75 | 67 → 67 |
| Shader program count | 74 → 74 | 70 → 70 |

Typed-array bytes are an inventory of geometry/instance source storage, **not total GPU VRAM**. Texture/render-target byte allocation and driver memory are not measured. Pose caching adds 80 bytes of numeric pose storage per eligible node plus JS closure/listener overhead; it does not reduce heap usage by design.

After effects and quality variants were warmed, three low→high rebuild cycles retained constant GPU counts: desktop 81 geometries / 98 textures / 111 programs; mobile 66 / 90 / 107. Backing storage stayed constant at 40,259,219 desktop and 40,112,527 mobile bytes. Garbage-collected used JS heap moved from 26,006,672→26,335,340 desktop and 25,822,200→26,154,432 mobile bytes. This small growth is recorded, not treated as proof of zero leaks; three cycles are not a long-duration heap test. Weak ownership and explicit batch disposal avoid introducing an intentional object-retention list.

The existing composer regression check separately passed nine high/medium/low create/dispose cycles, each returning to its original texture count. Quality transitions preserve 14 fireflies on high/medium and eight on low/lite, with one corresponding instance batch and no duplicate sprite children.

## Correctness

- Twenty focused cases passed on desktop and mobile: unchanged/moving/turning transforms, animated children, construction scale, hidden/revealed parents, forced updates, reparenting, direct local and parent-first world updates, manual local/world matrices and return to automatic mode, pivots, removal/reuse, new descendants and ray picking. Buffer checks cover Float32 equality, pending range union, slot replacement and count shrink/growth. Effects cover splash/poof/sparkle expiry and pool reuse.
- Actual mouse drag/wheel and touch drag/pinch changed the camera as expected. Original/optimized picking agreed across the panned/zoomed farm: 106 desktop and 26 mobile hit samples.
- Day/night/effects before/after screenshots were pixel-identical in the final runs. Desktop selection was identical; mobile selection differed in nine of 1,316,640 pixels by one RGB level, exactly matching its unchanged control. Other controls showed up to five one-level pixel changes on desktop. No differences exceeded one level.
- Startup, seed purchase/reload, province change/reload, hiring a parallel worker and speeding up the selected worker passed without browser errors. Existing saves were not modified; tests used isolated farms.
- `npm run check`, all **53** regression tests, `npm run build:pages`, renderer lifecycle/disposal tests, and the guarded patch's repeated application passed. These cover the affected paths, not every object at all 200 levels.

## Reproduce and inspect

Build locally with `npm run build:pages`, then serve `.pages` with the `/xom_nong_trai/` base path. No deployment is required. The QA scripts need an available Playwright installation and browser:

```powershell
$env:XNT_PLAYWRIGHT_MODULE = '<path-to-playwright>'
$env:XNT_CHROME_PATH = '<path-to-chrome.exe>'
$env:XNT_QA_URL = 'http://127.0.0.1:4198/xom_nong_trai/'
npm run qa:cpu
$env:XNT_PERF_DESKTOP = '1'
npm run qa:cpu
node scripts/performance-controls-qa.cjs
npm run qa:render
```

`XNT_CHROME_PATH` can be omitted when Playwright has its own browser. Unset `XNT_PERF_DESKTOP` to return to mobile. Detailed counters, samples, CPU profiles and screenshots are under `.local/review-qa/cpu-performance-{desktop,mobile}/`. Portable before/after JSON, controls results and images are saved in `reference/qa/cpu-performance-2026-10-25/`. QA exposes the renderer only through a browser route override; the production app gains no global debug handle.

Remaining priorities: test representative physical phones and larger player farms; profile GPU/postprocessing time and longer-lived heap retention before further changes. Native submission/state work and 15 postprocessing submissions remain, but this review provides no evidence that lowering visual quality or rewriting the renderer is warranted.
