# Material realism overhaul — design

**Goal:** every one of SphereLab's 22 materials physically real and *distinct*,
with three layers per material: (1) real bulk constants, (2) a genuine
behavioural model for its defining trait, (3) audio + visuals that match the
physics. Jelly's soft-body depth is the bar; its execution is fixed first.

**Constraints:** `npm test` green at every commit; contact solver stays pure
(no audio/DOM); 260-ball cap; 240 Hz budget; one commit per phase/family;
property tests (conservation / ordering / settling), never magic numbers.

## Approved decisions

1. **Jelly core = shape matching + gas pressure** (not denser springs).
2. **Balloon = pop-on-burst disk model** (not lattice membranes — budget).
3. **Honey = parameterized SPH rheology** (generalize `applySPH` per material).
4. **Brittle fragments render as angular shards** (physics stays disks).

## Phase 1 — Jelly

Diagnosis: ring nodes permanently overlap (nodeR 0.42R vs spacing ~0.45R at
N=14) so the rigid solver fights the lattice on ~14 bogus intra-blob contacts
per blob → faceting, jitter, wasted iterations. Springs-only restoring force
needs high stiffness to avoid buckling → reads rubbery. Damping is radial-only.
15 balls/blob.

Changes:
- Contact solver skips same-blob pairs (`a.soft === b.soft`); internal
  structure belongs to springs/pressure/shape-matching.
- Replace spoke + brace springs with **shape matching** (Müller 2005): best-fit
  rotation of the rest ring onto current nodes each step, pull nodes toward
  goal positions with stiffness β. Keep perimeter springs (membrane) + gas
  pressure (volume).
- Drop the center ball (centroid from nodes); N → 10. **≤ 12 balls/blob.**
- Shear damping: damp only deviation from the blob's rigid-body mode, so it
  bounces freely but wobbles 2–4 cycles and settles. Gelatin = low β, strong
  pressure, light damping.

Done: invariants T/U/V/X stay green; new tests — no intra-blob solver
contacts, blob-on-blob stack settles, large-deformation recovery, ≤12
balls/blob; browser check: smooth outline, gelatinous wobble.

## Phase 2 — Bulk-constants audit (all 22)

Real density (g/cm³), restitution, friction, cross-checked. Fix steel (0.86 →
~0.65) vs rubber (→ ~0.85) inversion; re-rank neighbours. Regenerate CLAUDE.md
table from code. New table-driven ordering test (rubber > steel > gold on
restitution; sand > rubber friction; gold > mercury > steel density; …).

## Phase 3 — Fluid rheology (water / mercury / honey / lava)

- Water: PBF stays; polish only.
- Mercury: keep merge + add **impact splitting** (slammed blob → beads,
  area-conserving).
- Honey: off the merge model, onto SPH with per-material
  `{viscosity, cohesion, restSpacing}`; very high viscosity + wall-cling.
- Lava: merge stays; viscosity/restitution track heat (runny hot → stiff cold
  → existing rock phase change).

Done: dam-break comparison — honey spreads ≪ water; mercury split conserves
area; lava stiffens monotonically as it cools.

## Phase 4 — Brittle fracture (glass / ice / obsidian)

Impulse-based (mass-aware) criterion; power-law fragment size distribution,
area-conserving, no KE injection; brittle fragments render as angular shards;
obsidian conchoidal cracks + lowest threshold; diamond unbreakable, scores
others. Done: mass/area conserved ±tol, KE never rises, threshold ordering
glass > ice > obsidian, fragment sizes skew small.

## Phase 5 — Granular (sand / rock)

Measure + assert real angle of repose (~30°±10°) in invariant I; rock piles
steeper than sand.

## Phase 6 — Metals (steel / gold / magnet)

Plasticity-restitution coupling: a denting impact loses the dent energy
(e drops on denting hits). Gold annealing exists. Done: denting hit rebounds
measurably lower than sub-threshold hit; energy never increases.

## Phase 7 — Soft adopters + organics (balloon / slime / wood / bowling)

- Balloon: overpressure **pop** on sharp/hard impact (bang, shreds, air puff);
  membrane-tuned squash otherwise.
- Slime: spawnable soft-body blob, nodes keep adhesion outward, small N.
- Wood: anisotropic friction (grain axis; along < across).
- Bowling: inertia/roll polish.

Done: pop-threshold test, slime blob sticks + settles, wood anisotropy
property test.

## Phase 8 — Energetic/exotic + audio/visual reconciliation

Plasma/neon/TNT/antimatter behaviours largely exist; align modal-synthesis
profiles + shaders with every physics change; update CLAUDE.md. Browser-only
verifications called out explicitly.
