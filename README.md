Addon/Behavior Pack creation guide
1- put overworld.json into a folder named 'dimensions'
2- zip the scripts folder, manifest.json,pack icon, and dimensions folder
3- rename the zip to something.mcpack (or .mcaddon)

FUNDEMNTALLY NOT COMPATIBLE WITH ANY STRUCTURE OR BETTER TERRAIN MODS

Annotated Guide & Tuning Manual

Disclaimer!!! This script and guide are vibe coded and I take no credit for their functionality, I only wanted to have this as a resource for any other player to use and edit to their discresion

This is a complete companion to the world‑generator script. It explains **what every
number does, how to change it, and what changes.** It is organized to match the script
top‑to‑bottom, so you can keep the script open and find any part by its section header
(e.g. search the script for `── CAVES ──`).

> **How to read a tunable:** each entry gives the **current value**, **what it controls**,
> and **↑ / ↓** = what happens if you raise / lower it.
> **Frequencies** (the small numbers like `0.006`, `8e-4`) are “zoom levels” for noise:
> **smaller number = larger, smoother features; larger number = smaller, noisier features.**
> A frequency `f` means the pattern repeats roughly every `1/f` blocks.
> **Offsets** (like `+40000`, `+1000`) just shift a noise field to a different region so two
> fields that use the same frequency don’t line up — changing an offset re‑rolls that field.

-----

## 0. The big picture — how a chunk is made

1. **A player triggers generation.** A scheduler watches players and decides which 16×16
   chunk to build next (nearest unbuilt chunk touching already‑built terrain; the player’s
   own chunk first on a fresh world). **Only one chunk is built at a time.**
1. **Each chunk is built by a generator (`genJob`) in two phases:**
- **Phase 0 — terrain:** compute surface height + biome for all 256 columns, bulk‑fill
  the bedrock/deepslate foundation, then fill each column (caves, water, stone, surface),
  then ore veins, then surface features (trees/flora).
- **Phase 1 — structures:** dungeons, strongholds, villages, shipwrecks, geodes, sculk
  pockets, mob seeding. This is deferred until all 8 neighbour chunks have terrain, so
  structures that cross a chunk border land on real ground.
1. **Watchdog safety:** the generator `yield`s constantly. The scheduler runs it only for a
   few milliseconds per tick (`BUDGET_MS`), then resumes next tick. It therefore **cannot**
   hang the game no matter how heavy a chunk is.

Everything else in the file is the data and math those steps use.

-----

## 1. CONFIG block  (search: `── CONFIG ──`)

```js
const BY=-512, DS_TOP=-256, SEA=62, BASE=64;
```

|Name    |Value   |Meaning                                                                               |↑ / ↓                                                                                                                   |
|--------|--------|--------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
|`BY`    |**‑512**|Bottom of the world (bedrock Y). Must match your world’s real minimum height.         |Set to **‑64** for a normal (non‑extended) world. Wrong value → wasted work or floating/missing terrain.                |
|`DS_TOP`|**‑256**|Everything at/below this Y is **deepslate**; above it is **stone**.                   |↑ deepslate reaches higher; ↓ less deepslate. In a ‑64 world this is below the world, so deepslate never appears (fine).|
|`SEA`   |**62**  |Sea level. Columns whose surface is below this flood with water (oceans/rivers/lakes).|↑ more/higher water, smaller landmasses; ↓ drier, more exposed land.                                                    |
|`BASE`  |**64**  |The average land height before noise is added.                                        |↑ raises the whole world; ↓ lowers it. Keep near `SEA` for normal coastlines.                                           |

```js
const RADIUS=2;            // chunks generated around each player
const YIELD_EVERY=1;       // columns per generator step
const BUDGET_MS=8;         // ms of gen work per tick
const MAX_STEPS_PER_TICK=256;
const RETRY_DELAY_TICKS=20;
const FAIL_ABORT=2048;
const SCHED_INTERVAL=1;
const DONE_CACHE_MAX=20000;
```

|Name                |Value    |Meaning                                                                                                          |↑ / ↓                                                                                                                                                                                                                    |
|--------------------|---------|-----------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|`RADIUS`            |**2**    |How many chunks out from each player get generated (a 5×5 area at 2).                                            |↑ generates more world around the player (slower, more to build); ↓ tighter ring (faster, but you may out‑walk generation).                                                                                              |
|`YIELD_EVERY`       |**1**    |Columns built between `yield`s in the fill phase. 1 = finest‑grained, safest.                                    |↑ slightly less generator overhead but coarser time‑budget checks (small risk of one extra column’s work past the budget). 1–4 is reasonable.                                                                            |
|`BUDGET_MS`         |**8**    |**The main speed/FPS dial.** Milliseconds of generation allowed per game tick (a tick is 50 ms).                 |↑ = world generates faster but uses more of each tick (lower FPS during generation). ↓ = smoother FPS, slower generation. 5–10 is a sane range; 8 ≈ 16 % of a tick.                                                      |
|`MAX_STEPS_PER_TICK`|**256**  |A *backstop* cap on generator steps per tick. `BUDGET_MS` is the real limit; this just stops a pathological loop.|Leave at 256. (It was 40, which throttled fast devices to ~40 columns/tick even when time remained — raising it lets `BUDGET_MS` govern.) Only matters if `Date.now` is unavailable, where it falls back to 8 steps/tick.|
|`RETRY_DELAY_TICKS` |**20**   |Legacy re‑probe delay for not‑yet‑loaded chunks (unused by the current scheduler).                               |Harmless to leave.                                                                                                                                                                                                       |
|`FAIL_ABORT`        |**2048** |If a single chunk fails this many block writes (e.g. it unloaded mid‑build), abort and retry it later.           |↑ more tolerant of partial failures; ↓ gives up sooner.                                                                                                                                                                  |
|`SCHED_INTERVAL`    |**1**    |Ticks between scheduler runs (1 = every tick).                                                                   |↑ generates less often (slower, lighter); keep at 1 for responsiveness.                                                                                                                                                  |
|`DONE_CACHE_MAX`    |**20000**|Max remembered chunks before the in‑memory “already built” sets are cleared.                                     |↑ uses more memory, fewer re‑checks on huge explored areas; ↓ saves memory. Persistent per‑chunk flags mean cleared chunks still aren’t rebuilt.                                                                         |

```js
const NOW = (Date.now exists) ? Date.now : null;   // timer used for the budget; do not edit
```

```js
const CAVE_WATER_T=0.50;   // water‑cave regions
const LAVA_LAKE_T=0.88;    // underground lava‑lake regions
const LAVA_LAKE_TOP=-200;  // lava only below this Y
const DEEPDARK_TOP=-300;   // sculk / deep‑dark caves at this Y and below
const P2N=1.45;            // noise normalizer
const FILL_MAX_H=120;      // max height of a single bulk fill
const VILLAGE_GRID=9;      // village spacing, in chunks
const SHX=8, SHZ=8, SHY=-44; // stronghold centre
```

|Name           |Value   |Meaning                                                                                                         |↑ / ↓                                                                                                                    |
|---------------|--------|----------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------|
|`CAVE_WATER_T` |**0.50**|Threshold for “this column is in a flooded‑cave region.” Lower = more of the map has water caves.               |↑ rarer water caves; ↓ more. (Was 0.62.) Range roughly ‑1…+1.                                                            |
|`LAVA_LAKE_T`  |**0.88**|Threshold for underground lava‑lake regions (high = rare).                                                      |↓ more lava lakes; ↑ fewer.                                                                                              |
|`LAVA_LAKE_TOP`|**‑200**|Lava only fills carved caves at/below this Y.                                                                   |↑ lava appears higher; ↓ deeper only.                                                                                    |
|`DEEPDARK_TOP` |**‑300**|Caves at/below this Y become sculk **deep‑dark** (sculk floors/ceilings + sensors/shriekers).                   |↑ deep dark starts higher (more of it); ↓ deeper only. Requires a world deep enough to reach it (`BY`/world min ≤ ~‑310).|
|`P2N`          |**1.45**|Raw Perlin noise only reaches about ±0.7; multiplying by 1.45 stretches it to ≈ ±1 so thresholds read naturally.|Don’t change unless you re‑tune every threshold that uses `*P2N`.                                                        |
|`FILL_MAX_H`   |**120** |A single bulk fill covers at most this many blocks of height (engine safety).                                   |Leave; lower only if very large fills misbehave.                                                                         |
|`VILLAGE_GRID` |**9**   |Villages are placed one per 9×9‑chunk cell (≈ every 144 blocks, jittered).                                      |↑ villages farther apart; ↓ closer together / more common.                                                               |
|`SHX,SHZ`      |**8, 8**|World‑block centre of the (single) stronghold, near spawn.                                                      |Move the stronghold’s centre.                                                                                            |
|`SHY`          |**‑44** |The stronghold’s vertical centre.                                                                               |↑ shallower stronghold; ↓ deeper. Keep within your world’s height.                                                       |

-----

## 2. Noise system  (search: `── NOISE ──`)

`initNoise()` seeds a permutation table from the **world seed**, so the same seed always
makes the same world. You normally don’t edit this.

The building blocks:

- **`p2(x,z)` / `p3(x,y,z)`** — 2D / 3D Perlin noise, output ≈ ±0.7. The workhorses.
- **`fbm2(x,z, octaves, lacunarity, gain)`** — “fractal” noise: stacks several `p2` layers.
  - **octaves** = how many layers (more = more fine detail, more CPU).
  - **lacunarity** (~2.0) = how much smaller each layer is than the last.
  - **gain** (~0.5) = how much weaker each layer is (lower = smoother result).
- **`colRnd(x,z,salt)`** — a fast deterministic per‑column random in 0…1. `salt` is just a
  channel id so different uses (trees vs flowers vs structures) don’t correlate. Used
  everywhere you see a probability check like `colRnd(wx,wz,11) < 0.05`.

**To make the whole world more detailed/jagged:** add an octave to a `fbm2` call (costs CPU).
**To make it smoother:** lower the `gain` (e.g. 0.50 → 0.40).

-----

## 3. Block palette  (search: `── BLOCKS ──`, function `resolveBlocks`)

`K` is a dictionary of resolved block permutations, e.g. `K.grass`, `K.water`, `K.sculk`.
Each entry is `key:tryR("minecraft:...")`. `tryR` safely returns the block or `null` if the
id doesn’t exist, and every placement is guarded by `if(K.x)`, so a missing block just skips.

**To swap a block** (example — the bee‑nest change already applied):

```js
bee_nest:tryR("minecraft:bee_nest"),   // was beehive:tryR("minecraft:beehive")
```

and update the placement site to match the key name (`K.bee_nest`).

**To add a new block:** add a line `myblock:tryR("minecraft:some_block"),` then use `K.myblock`
where you place blocks. Blocks needing a state (e.g. a facing/age) use `.withState(...)`; see
`sculk_shrieker` (forces `can_summon=true`) or `placeTall` (sets `upper_block_bit`).

-----

## 4. Loot system  (search: `── LOOT SYSTEM ──`, object `LOOT`)

Each chest type is a table:

```js
dungeon:{ rolls:[5,9], pool:[
   {id:"minecraft:iron_ingot", min:1, max:4, w:8},
   ...
]},
```

|Field            |Meaning                             |↑ / ↓                                       |
|-----------------|------------------------------------|--------------------------------------------|
|`rolls:[min,max]`|How many item stacks the chest gets.|↑ fuller chests; ↓ sparser.                 |
|`pool`           |The item entries to draw from.      |Add `{id,min,max,w}` lines for more variety.|
|`id`             |Item id.                            |—                                           |
|`min,max`        |Stack size range for that item.     |↑ bigger stacks.                            |
|`w`              |Weight (relative chance).           |↑ that item appears more often.             |

**How drops are chosen (`lootFill`):** items go into **distinct slots** (no overwrites), and
each time an entry is picked its weight is multiplied by **0.4** (`wts[ei]*=0.4`) so the same
item rarely repeats → varied chests. To allow *more* repeats, raise that 0.4 toward 1.0; to
forbid repeats almost entirely, lower it toward 0.

**Tables available:** `default, dungeon, library, prison, treasury, armory, storage, dead_end, ruin, shipwreck_supply, desert_temple, jungle_temple, …`. Add a table by adding a
key; reference it by name in a `placeChest(...,"tablename")` call.

-----

## 5. Terrain height — `surfY(wx,wz)`  (search: `── TERRAIN HEIGHT ──`)

Returns the surface Y for a column. It’s a sum of noise layers plus special landforms.
**This is the single most powerful function for changing how the world looks.**

```js
const c  = fbm2(wx*1.2e-3, wz*1.2e-3, 5,2.0,0.50)*120;   // continents
const h  = fbm2(wx*7.0e-3+1000, wz*7.0e-3, 4,2.1,0.45)*35; // hills
const rr = (1-Math.abs(fbm2(wx*1.8e-2+2000,wz*1.8e-2,3,2.2,0.40)))*20-10; // ridges
const d  = fbm2(wx*5.0e-2+3000, wz*5.0e-2, 2,2.3,0.35)*5;  // fine detail
let sy = Math.round(BASE + c + h + rr + d);
```

|Layer         |Freq    |Amplitude |Controls                 |↑ amplitude / ↑ freq                                                                       |
|--------------|--------|----------|-------------------------|-------------------------------------------------------------------------------------------|
|`c` continents|`1.2e-3`|**×120**  |Big landmass/ocean shape.|↑ amp = taller mountains & deeper seas overall; ↑ freq = smaller, more frequent continents.|
|`h` hills     |`7.0e-3`|**×35**   |Rolling hills.           |↑ amp = hillier; ↑ freq = bumpier.                                                         |
|`rr` ridges   |`1.8e-2`|**×20‑10**|Sharp ridgelines (the `1-|noise                                                                                      |
|`d` detail    |`5.0e-2`|**×5**    |Small surface roughness. |↑ amp = rougher ground.                                                                    |


> Want a **flatter** world? Lower the `c` and `h` amplitudes (e.g. 120→60, 35→15).
> Want **extreme** terrain? Raise them.

**Mountains:**

```js
const mt = fbm2(wx*5.5e-4+15000, wz*5.5e-4, 3,2.0,0.5)*P2N;
if(mt>0.20){ const ridge=1-Math.abs(p2(wx*2.2e-3+16000,wz*2.2e-3));
             const f=Math.min(1,(mt-0.20)/0.26);
             sy += Math.round(f*f*(140+ridge*240)); }
```

- `mt>0.20` — **mountain threshold.** ↓ (e.g. 0.15) = **more** mountains; ↑ = fewer. (Was 0.26.)
- `/0.26` — how quickly mountains reach full height past the threshold. ↓ = steeper onset.
- `140+ridge*240` — **mountain height.** ↑ these for taller peaks (240 is the ridged bonus).

**Mooshroom islands:** `mshDist>1500` (only far from spawn) and `|noise|<0.015` (rare seams).
↑ the `1500` to push them farther out; ↑ `0.015` to make them more common.

**Rivers:** `RB=0.12` is the river half‑width band; `bed=SEA-6` is river depth. ↑ `RB` = wider
rivers; lower `bed` = deeper. Rivers only carve where land is above `SEA+2`.

**Ravines (surface canyons):** `|rnv|<0.018` → drops the column by 55. ↑ `0.018` = more/wider
ravines; ↑ the `55` = deeper.

**Lakes:** where `sy` is just above sea level and `lk>0.62` → pulled down to `SEA-2`. ↓ `0.62`
= more lakes.

**Ocean trenches:** very deep ocean where `|tr|<0.05` → `SEA-120`. ↑ `0.05` = more trenches.

`if(sy>460)sy=460;` — a safety cap so peaks never exceed Y 460. Raise if your world is taller.

-----

## 6. Biomes — `biome(wx,wz,sy)`  (search: `function biome`)

Returns a biome **id** (0–18) from height + two climate noises:

- **`t`** = temperature noise (`fbm2 … 8e-4`), roughly ‑0.5…+0.5 (cold → hot).
- **`h`** = humidity noise (`9e-4`), roughly ‑0.5…+0.5 (dry → wet).

```js
if(sy<SEA-4){ if(sy>=SEA-20 && warmNoise>0.30) return 12 /*coral*/; return 0 /*ocean*/; }
if(sy>178) return 11 /*mountain*/;            // anything very tall = mountain biome
if(far from spawn && |noise|<0.015) return 17 /*mooshroom*/;
```

Then climate bands (checked **in order** — earlier wins):

|Test                            |Biome        |id|
|--------------------------------|-------------|--|
|`t < -0.37`                     |ice spikes   |16|
|`t < -0.27`                     |snowy        |10|
|`t < -0.16`                     |taiga        |9 |
|`-0.16 ≤ t < -0.04 & h<0.04`    |pale garden  |15|
|`t > 0.26 & h < 0.00`           |desert       |1 |
|`t > 0.27 & h > 0.15 & sy>SEA+8`|mesa/badlands|18|
|`t > 0.15 & h < 0.12`           |savanna      |2 |
|`t > 0.16 & h > 0.40 & sy≤SEA+6`|mangrove     |7 |
|`t > 0.18 & h > 0.30`           |jungle       |6 |
|`h > 0.34 & sy≤SEA+8`           |swamp        |8 |
|`h > 0.44 & 0.04<t<0.30`        |dark oak     |13|
|`t>0.08 & 0.10<h<0.34 & t<0.34` |cherry       |14|
|`h > 0.24 & t < 0.08`           |birch        |5 |
|`h > 0.10`                      |forest       |4 |
|else                            |plains       |3 |

**These thresholds were calibrated to the noise’s real spread** (the noise rarely reaches the
extremes, so cold/hot biomes use modest cut‑offs like ±0.27, not ±0.5).

**To make a biome more common:** widen its band toward 0. *Desert ↑*: change `t>0.26` → `t>0.20`.
*Snowy ↑*: change `t<-0.27` → `t<-0.20`. **To make one rarer:** push its threshold outward.
**Order matters** — a biome listed earlier “steals” overlapping climate from later ones; if you
loosen an early biome, later ones shrink.

`sy>178` forces the **mountain biome** on tall terrain — lower it (e.g. 160) for more alpine
area, raise it for less.

-----

## 7. Stone variants — `stoneBlk(wx,wy,wz,ds)`  (search: `── STONE VARIANTS ──`)

Decides the exact rock for a solid block (granite/diorite/andesite/tuff/calcite/dripstone vs
plain stone/deepslate), using two low‑frequency 3D noises (`*0.04`, period ~25 blocks → blobs).
Thresholds like `na>0.44` set how much of each variant appears. ↑ a threshold = **less** of
that variant; ↓ = more. These are purely cosmetic (rock you see when mining).

-----

## 8. Caves — `caveAt(wx,y,wz)`  (search: `── CAVES ──`)

Returns **true** if the block at (x,y,z) is carved (air/water cave). It combines several cave
systems. **This is the most CPU‑heavy function** (sampled for every solid block), so changes
here affect both looks and speed.

```js
if(y<=WMIN+2) return false;                     // never carve the bottom 2 layers
const reg = p3(wx*0.0025+40000, y*0.0025, wz*0.0025);   // big "cave region" field
if(reg > 0.10 + y*0.0004){                       // inside a tunnel region:
    if(p3(wx*0.012, y*0.045, wz*0.012+45000) > 0.34) return true;  // winding tunnels
    if(p3(wx*0.02+47000, y*0.02, wz*0.02)    > 0.58) return true;  // pockets
    return false;
}
const sc=0.035;                                  // spaghetti caves (everywhere)
const n1=p3(wx*sc,y*sc*0.7,wz*sc), n2=p3(wx*sc+50,y*sc*0.7+50,wz*sc+50);
if(n1*n1 + n2*n2 < 0.016) return true;
if(y<=60 && y>=-260){                             // ravines (mid‑depth only)
    const s1=p3(wx*0.025,y*0.015,wz*0.025), s2=p3(wx*0.025+30,y*0.015+30,wz*0.025+30);
    if(s1*s1 + s2*s2 < 0.013) return true;
}
if(y<=-80 && p3(wx*0.018,y*0.018,wz*0.018) > 0.62) return true;   // deep rooms
```

|Knob            |Value            |Effect                                                                        |↑ / ↓                                                                                                           |
|----------------|-----------------|------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|
|region threshold|`0.10 + y*0.0004`|How much of the map is “tunnel region.”                                       |↓ the `0.10` = bigger tunnel networks; ↑ = more isolated. The `y*0.0004` makes caves slightly rarer with height.|
|tunnel density  |`> 0.34`         |Winding‑tunnel fill.                                                          |↓ = wider/more tunnels; ↑ = thinner/fewer.                                                                      |
|pocket density  |`> 0.58`         |Round chambers in regions.                                                    |↓ = more/bigger pockets.                                                                                        |
|spaghetti size  |`< 0.016`        |The everywhere‑present worm caves (this is a squared‑distance‑to‑a‑tube test).|↑ = **bigger/more** spaghetti caves; ↓ = smaller/fewer. The strongest single “more caves” dial.                 |
|spaghetti `sc`  |`0.035`          |Spaghetti frequency.                                                          |↓ = longer, smoother tunnels; ↑ = twistier.                                                                     |
|ravine size     |`< 0.013`        |Tall thin ravines, only `‑260 ≤ y ≤ 60`.                                      |↑ = more ravines; widen the y‑range for ravines at other depths.                                                |
|deep rooms      |`> 0.62`, `y≤-80`|Large deep cavities.                                                          |↓ the `0.62` = more deep caverns.                                                                               |


> **Want way more caves?** Raise the spaghetti `< 0.016` to `< 0.024`.
> **Want fewer caves (and faster generation)?** Lower it to `< 0.010` and raise the deep‑room
> `0.62` to `0.70`.

-----

## 9. The column builder — `fillCol(...)`  (search: `── FILL COLUMN ──`)

Builds one column from the foundation up to the surface, then handles water/beaches/biome
topsoil. Key parts and their dials:

- **Foundation:** bedrock at the bottom; the **deepslate band** (`DS_TOP` and below) is
  pre‑filled chunk‑wide in `prefillChunk` (fast); stone is filled per column up to the surface.
- **Cave carving + content:** for each Y, if `caveAt` is true the block becomes air (or lava
  below `LAVA_LAKE_TOP` in lava regions, or water in flooded regions). The **first** floor/
  ceiling block of a cave gets themed:
  - `y ≤ DEEPDARK_TOP & deepDark` → **sculk** (deep dark).
  - `cb > 0.45` → **mushroom cave** (mycelium + mushrooms).
  - `cb < -0.50` → **lush cave** (moss + carpet; big features added later).
    `cb = p3(…*0.006+25000…)` is the cave‑content field — widen `>0.45`/`<-0.50` toward 0 for
    more themed caves; the decoration **penetrates 1–2 blocks** into walls via the `y-2` writes.
- **Water caves:** `wLvl` (regional, from `CAVE_WATER_T`) floods carved air up to a local level;
  additionally any cave opening under the sea/rivers/lakes floods automatically
  (`submerged && y ≥ floodTop‑30`). Change the **30** to flood deeper/shallower under water.
- **`deepDark` region:** `p2(wx*0.004+33000,…) > -0.05` — the `‑0.05` sets how much of the deep
  zone is sculk (≈ half). ↑ toward 0 = less; ↓ = more.
- **Oceans/rivers/lakes:** water is bulk‑filled in tall runs (fast). Sea ice forms on cold
  ocean tops; the seabed is gravel/clay/sand/magma by biome/depth.
- **Beaches:** `doBeach()` uses `bn = p2(wx*0.005+8000,…)`: `>0.38` → sand, `<-0.42` → gravel,
  else grass. ↑ `0.38` band for more sandy beaches.
- **Biome topsoil:** the `switch(bm)` puts the right surface (grass/sand/podzol/snow/mud/
  terracotta…) and 2–3 blocks of subsoil for each biome id.

-----

## 10. Ore veins — `ORES` + `placeVeins`  (search: `── ORE VEINS ──`)

```js
{blk:"coal_o", dsBlk:"ds_coal", lo:0, hi:140, count:[25,40], clump:[6,21]},
```

|Field            |Meaning                                                               |↑ / ↓                               |
|-----------------|----------------------------------------------------------------------|------------------------------------|
|`blk` / `dsBlk`  |Palette keys for the ore in stone / in deepslate.                     |—                                   |
|`lo` / `hi`      |Y range the ore spawns in.                                            |Widen for more places it can appear.|
|`count:[min,max]`|**Veins per chunk.**                                                  |↑ = more ore overall.               |
|`clump:[min,max]`|**Blocks per vein.**                                                  |↑ = bigger ore blobs.               |
|`capFn:y=>…`     |Optional hard cap on clump size by depth (diamonds: 22 deep, else 12).|Edit to cap richer/poorer.          |
|`biome:11`       |Restrict to a biome id (emeralds → mountains).                        |—                                   |

Veins bias **downward**: `y = lo + (hi-lo)*r*r` (the `r*r` makes deeper spawns more likely).
Ore won’t replace cave air or anything within 4 blocks of the surface.

**Recipe — more diamonds:** raise diamond `count` (e.g. `[20,40]`→`[30,60]`) and/or `clump`.
**Recipe — add a new ore:** copy a line, set `blk`/`dsBlk` to existing palette keys (or add
them to `K`), pick `lo/hi/count/clump`.

-----

## 11. Trees & flora  (search: `── SURFACE FLORA ──`, `TREES`, `function* placeFeat`)

**Tree density** uses `treeRoll(wx,wz)=colRnd(wx,wz,7)` (0…1 per column). A tree spawns where
`treeRoll < threshold`. Thresholds live in `TREES`:

```js
4:[[0.032,placeBirch],[0.080,placeOak]],   // forest: 3.2% birch then up to 8% oak
```

- The number is the **chance per column** (0.080 = 8 % of columns get that tree).
  ↑ = denser forest; ↓ = sparser.
- `groveAt()` = `0.55 + 0.9*|noise|` multiplies the chance so trees clump into groves and
  clearings. Raise the `0.9` for stronger clumping.
- `treeIsLocalMin` stops two trees spawning right next to each other (spacing).

**Flowers** (`placeFlora` + `FLOWER_SETS`): every grassy biome has a flower set; plains uses
the full set at **5 %** (`rate=bm===3?0.05:0.0167`), all others at **1.67 %** (one‑third).
↑ `0.05`/`0.0167` for more flowers. Tall flowers (rose bush, peony, lilac, sunflower) are
placed as proper 2‑block plants via `placeTall`.

**No foliage on beach sand** (`isBeachSand`): trees/flowers are skipped on sandy beaches unless
the biome is a desert/badlands. Change `bn>0.38` to shrink/grow the protected sand.

-----

## 12. Structures  (search: `── STRUCTURES ──`, `STRUCTURES`, `placeStructures`)

Most structures are a registry row:

```js
{name:"dungeon", group:"main", s:0.17, o:6000, test:v=>v>0.55, fn:complexDungeonAt},
```

|Field          |Meaning                                                                                                                 |↑ / ↓                                                                                 |
|---------------|------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------|
|`s`            |Frequency of the placement noise.                                                                                       |↑ = structures cluster closer together.                                               |
|`o`            |Offset (re‑rolls where they land).                                                                                      |Change to move them around.                                                           |
|`test:v=>…`    |The chunk gets the structure if this passes (`v` ≈ ‑1…+1).                                                              |**Loosen** the threshold (e.g. `v>0.55`→`v>0.45`) = **more** of them; tighten = fewer.|
|`ok:(bm,sy)=>…`|Optional biome/height requirement.                                                                                      |e.g. desert temples require `bm===1`.                                                 |
|`group:"main"` |“main” structures are **mutually exclusive per chunk** (only the first that passes is built). Non‑main ones can coexist.|—                                                                                     |

Current thresholds (higher `test` = rarer): dungeon `>0.55`, ruin `>0.60`, mineshaft `<-0.55`,
ruined_portal `>0.70`, shipwreck `<-0.62` (ocean), outpost `>0.72`, desert_temple `>0.70`,
jungle_temple `>0.74`. Geodes/fossils use per‑chunk odds: geode **2.8 %** (`colRnd(...,409)<0.028`),
fossil **4.5 %** (`<0.045`). Structures never spawn in the 3×3 chunks around spawn.

**Recipe — more shipwrecks:** change shipwreck `test` to `v<-0.50`.
**Recipe — add a structure:** add a registry row pointing `fn` at a builder function that takes
`(m, worldX, worldZ, surfaceY)` and places blocks with `sb(m,x,y,z,K.something)`.

**Villages** are grid‑based (`VILLAGE_GRID`), skipped in ocean/mountain/coral/ice/mooshroom.
**Strongholds** are one big multi‑level build near `SHX,SHZ`; size/branchiness is set in
`computeSHLayout` (the `levelChance=[0.92,0.62,0.30]` array = chance of a 2nd/3rd/4th level per
arm — raise for bigger strongholds). **Dungeons** are multi‑room with a ladder‑linked basement.
**Deep‑dark sculk pockets** (sensors + shriekers) are decorated by `decorateSculkSpot` in the
deferred cave pass.

-----

## 13. Performance & watchdog  (search: `── JOB SYSTEM ──`, `── SCHEDULER ──`)

- **One chunk at a time.** `pickNext` chooses the nearest unbuilt chunk that touches built
  terrain (flood‑fill outward), or the player’s own chunk on a fresh world. A chunk fully
  finishes before the next starts.
- **`stepCurrent`** runs the current chunk’s generator only until `BUDGET_MS` elapses, then
  returns; the next tick continues. This is what makes generation **watchdog‑proof**.
- **Optimizations applied in this version (all output‑identical):**
1. `MAX_STEPS_PER_TICK` 40 → 256 (the old cap throttled fast devices to ~40 columns/tick
   even with time to spare; now `BUDGET_MS` is the real governor).
1. `BUDGET_MS` 5 → 8 (more generation per tick; the documented FPS dial).
1. **Deepslate foundation** is now one chunk‑wide fill instead of 256 per‑column fills
   (proven identical placement; ~250 fewer engine calls per deep‑world chunk).
1. **Ocean water** is bulk‑filled in tall vertical runs instead of block‑by‑block
   (~1,900 → ~60 placements per heavily‑ocean chunk).
- **If you want even faster generation:** raise `BUDGET_MS` (costs FPS) and/or shrink `RADIUS`.
  **If you see frame stutter:** lower `BUDGET_MS` to 5–6.
- **The genuinely expensive part is `caveAt`** (3D noise per solid block). The biggest *world*
  speed‑up without changing the budget is to carve fewer/smaller caves (Section 8) or, in a
  shallow (‑64) world, the columns are ~4× shorter so it’s already much faster than a ‑512 world.

-----

## 14. Locate command  (search: `LOCATE —`)

Find the nearest biome or structure, `/locate`‑style, for this scripted world:

- Chat: `!locate <name>` (e.g. `!locate desert`, `!locate village`, `!locate sculk_cave`),
  or force a category: `!locate biome <name>` / `!locate structure <name>`. `!locate help`
  lists every name.
- Command block / console: `/scriptevent wg:locate <name>`.

It replays the same placement maths over a spiral of chunks and reports `x, y, z` + distance.
The search runs across ticks (`system.runJob`), so it never freezes the game. The radius cap is
`MAXR=500` chunks (~8000 blocks) inside `locateSearch` — raise it for a wider sweep.

**To make a new thing locatable:** add its name to `BIOME_IDS` / `STRUCT_ALIAS` and, for a
structure, make sure `structurePresentAt` knows how to test it.

-----

## 15. Quick “How do I…” index

|Goal                   |Where                |Change                                               |
|-----------------------|---------------------|-----------------------------------------------------|
|Flatter / hillier world|`surfY` §5           |lower / raise the `c` (×120) and `h` (×35) amplitudes|
|More mountains         |`surfY` §5           |`mt>0.20` → lower number                             |
|Higher mountains       |`surfY` §5           |raise `140+ridge*240`                                |
|Raise/lower sea        |CONFIG §1            |`SEA`                                                |
|More water caves       |CONFIG §1            |lower `CAVE_WATER_T`                                 |
|More/bigger caves      |`caveAt` §8          |raise the spaghetti `<0.016`                         |
|Fewer caves (faster)   |`caveAt` §8          |lower `<0.016`, raise deep‑room `0.62`               |
|More of a biome        |`biome` §6           |move its threshold toward 0 (mind the order)         |
|More diamonds          |`ORES` §10           |raise diamond `count`/`clump`                        |
|Denser forests         |`TREES` §11          |raise the per‑tree chance (e.g. 0.080)               |
|More flowers           |`placeFlora` §11     |raise `0.05` / `0.0167`                              |
|More shipwrecks/temples|`STRUCTURES` §12     |loosen that row’s `test`                             |
|Bigger strongholds     |`computeSHLayout` §12|raise `levelChance` values                           |
|Sculk deeper/shallower |CONFIG §1            |`DEEPDARK_TOP`                                       |
|Faster generation      |CONFIG §1            |raise `BUDGET_MS` (costs FPS)                        |
|Smoother FPS           |CONFIG §1            |lower `BUDGET_MS`, shrink `RADIUS`                   |
|Match a normal world   |CONFIG §1            |`BY=-64`                                             |

-----

*Every threshold above is a starting point — change one number at a time, regenerate a fresh
area (or a new world) to see the effect, and keep what you like.*
