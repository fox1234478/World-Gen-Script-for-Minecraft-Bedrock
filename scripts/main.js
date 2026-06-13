// main.js — Bedrock 1.21+  |  scripts/main.js
// ════════════════════════ PERFORMANCE BUILD ════════════════════════
// Improvements in this build vs the previous one:
//  • STRUCTURES upgraded to equal-or-better-than-vanilla: 3-level modular
//    stronghold with randomised room graph (library is now a 2-story hall),
//    proper ship-hulled shipwrecks split into 3 loot chests, multi-room
//    modular dungeons, bigger desert/jungle temples with trapped corridors.
//  • LOOT improved everywhere; shipwrecks use supply/treasure/map tables and
//    stronghold library chests now drop diamonds, ender pearls, xp bottles.
//  • ORES: everything except coal is 4× more common with 1.5× bigger blobs.
//  • TREES in forest-type biomes 1.25× less common + adjacency suppression so
//    trees almost never spawn directly next to each other.
//  • PASSIVE MOBS keep respawning near players on long, jittered intervals.
//  • GEODES + FOSSILS spawn at ANY y and are spread out (no per-chunk groups).
//  • WATER CAVES more common; caves opening into ocean/water features flood.
//  All heavy builders are generators (yield) → watchdog-safe; runs on low-end
//  devices (iPhone X tier) thanks to the time-budgeted scheduler.
// ════════════════════════════════════════════════════════════════════

import * as mc from "@minecraft/server";
const w = mc.world, s = mc.system, B = mc.BlockPermutation;
const BV = mc.BlockVolume || null;   // bulk fill (optional, auto-fallback)
const IS = mc.ItemStack    || null;  // chest loot (optional, auto-fallback)

// ── CONFIG ─────────────────────────────────────────────────────
const BY=-512, DS_TOP=-256, SEA=62, BASE=64;
const RADIUS=2;            // chunks generated around each player
const YIELD_EVERY=1;       // columns per generator step (1 = finest, safest)
const BUDGET_MS=5;         // ms of gen work per tick
const MAX_STEPS_PER_TICK=40;// hard cap on generator steps per tick
const RETRY_DELAY_TICKS=20;// re-probe delay for unloaded chunks
const FAIL_ABORT=2048;     // abort+requeue a job if this many writes fail
const SCHED_INTERVAL=1;    // ticks between scheduler runs
const DONE_CACHE_MAX=20000;// generated-chunk cache cap
const NOW=(typeof Date!=="undefined"&&typeof Date.now==="function")?Date.now:null;
// ── CAVE CONTENT ──────────────────────────────────────────────
const CAVE_WATER_T=0.50;  // LOWERED (was 0.62) → water caves more common
const LAVA_LAKE_T=0.88;
const LAVA_LAKE_TOP=-200;
const P2N=1.45;
const FILL_MAX_H=120;
const VILLAGE_GRID=9;
// Stronghold center — SHY raised into real world height so it generates.
const SHX=8, SHZ=8, SHY=-44;

// ── SPAWN ──────────────────────────────────────────────────────
const SPAWN={x:0,y:100,z:0};
const dim=()=>w.getDimension("overworld");
const cmd=c=>{try{const m=dim();return m.runCommandAsync?m.runCommandAsync(c):m.runCommand(c);}catch{}};

let _spawnPicked=false;
function pickSpawn(){
  if(_spawnPicked)return;
  try{
    initNoise();
    try{updateBounds(dim());}catch{}
    const targets=[2,4,5,9,13,14,15,6];
    const want=targets[(perm[3]+perm[91])%targets.length];
    let anyTarget=null,anyLand=null;
    for(let r=0;r<=480;r+=24){
      const steps=Math.max(1,Math.round(r/24)*6);
      for(let i=0;i<steps;i++){
        const a=i/steps*6.2832;
        const wx=Math.round(Math.cos(a)*r),wz=Math.round(Math.sin(a)*r);
        const sy=surfYM(wx,wz);
        if(sy<SEA+2||sy>250)continue;
        const b=biome(wx,wz,sy);
        if(!anyLand&&b!==0&&b!==12)anyLand={x:wx,y:sy+2,z:wz};
        if(!anyTarget&&targets.indexOf(b)>=0)anyTarget={x:wx,y:sy+2,z:wz};
        if(b===want){SPAWN.x=wx;SPAWN.y=sy+2;SPAWN.z=wz;_spawnPicked=true;return;}
      }
    }
    const pick=anyTarget||anyLand;
    if(pick){SPAWN.x=pick.x;SPAWN.y=pick.y;SPAWN.z=pick.z;}
    else SPAWN.y=surfYM(0,0)+2;
  }catch{}
  _spawnPicked=true;
}

const setSpawn=()=>{
  pickSpawn();
  try{w.setDefaultSpawnLocation(SPAWN);}catch{cmd(`setworldspawn ${SPAWN.x} ${SPAWN.y} ${SPAWN.z}`);}
  const scx=Math.floor(SPAWN.x/16),scz=Math.floor(SPAWN.z/16);
  for(let dx=-RADIUS;dx<=RADIUS;dx++)for(let dz=-RADIUS;dz<=RADIUS;dz++){
    const key=ck(scx+dx,scz+dz);
    if(!isDone(key)&&!pend.has(key)){
      pend.add(key);
      const item={cx:scx+dx,cz:scz+dz};
      (dx===0&&dz===0)?que.unshift(item):que.push(item);
    }
  }
  kick();
};
s.runTimeout(()=>{try{setSpawn();}catch{}},1);

w.afterEvents.playerJoin.subscribe(e=>{
  try{setSpawn();}catch{}
  s.runTimeout(()=>{try{e.player.teleport(SPAWN,{dimension:dim()});}catch{}},3);
});
w.afterEvents.playerSpawn?.subscribe?.(()=>{try{setSpawn();}catch{}});

// ── NOISE ──────────────────────────────────────────────────────
let perm=null;
function initNoise(){
  if(perm)return;
  let seed=98765;
  try{
    const ws=w.seed;
    if(typeof ws==='number'&&isFinite(ws))seed=(Math.abs(ws)>>>0)||12345;
    else if(typeof ws==='bigint')seed=Number(ws&0x7FFFFFFFn)||12345;
    else if(typeof ws==='string'&&ws.length){let h=0;for(let i=0;i<ws.length;i++)h=(Math.imul(h,31)+ws.charCodeAt(i))>>>0;seed=h||12345;}
  }catch{}
  perm=new Uint8Array(512);
  const p=new Uint8Array(256);for(let i=0;i<256;i++)p[i]=i;
  let r=(seed>>>0)||1;
  for(let i=255;i>0;i--){r=(Math.imul(r,1664525)+1013904223)>>>0;const j=r%(i+1),t=p[i];p[i]=p[j];p[j]=t;}
  for(let i=0;i<512;i++)perm[i]=p[i&255];
}
const fade=t=>t*t*t*(t*(t*6-15)+10);
const lerp=(a,b,t)=>a+t*(b-a);
const g2=(h,x,z)=>{switch(h&7){case 0:return x+z;case 1:return -x+z;case 2:return x-z;case 3:return -x-z;case 4:return x;case 5:return -x;case 6:return z;default:return -z;}};
const g3=(h,x,y,z)=>{const u=h<8?x:y,v=h<4?y:(h===12||h===14?x:z);return((h&1)?-u:u)+((h&2)?-v:v);};
function p2(x,z){
  const X=Math.floor(x)&255,Z=Math.floor(z)&255;x-=Math.floor(x);z-=Math.floor(z);
  const u=fade(x),v=fade(z),a=perm[X]+Z,b=perm[X+1]+Z;
  return lerp(lerp(g2(perm[a],x,z),g2(perm[b],x-1,z),u),lerp(g2(perm[a+1],x,z-1),g2(perm[b+1],x-1,z-1),u),v);
}
function p3(x,y,z){
  const X=Math.floor(x)&255,Y=Math.floor(y)&255,Z=Math.floor(z)&255;
  x-=Math.floor(x);y-=Math.floor(y);z-=Math.floor(z);
  const u=fade(x),v=fade(y),wf=fade(z);
  const A=perm[X]+Y,AA=perm[A]+Z,AB=perm[A+1]+Z,Bv=perm[X+1]+Y,BA=perm[Bv]+Z,BB=perm[Bv+1]+Z;
  return lerp(lerp(lerp(g3(perm[AA],x,y,z),g3(perm[BA],x-1,y,z),u),lerp(g3(perm[AB],x,y-1,z),g3(perm[BB],x-1,y-1,z),u),v),
              lerp(lerp(g3(perm[AA+1],x,y,z-1),g3(perm[BA+1],x-1,y,z-1),u),lerp(g3(perm[AB+1],x,y-1,z-1),g3(perm[BB+1],x-1,y-1,z-1),u),v),wf);
}
function fbm2(x,z,oct,lac,gain){
  let v=0,a=1,f=1,mx=0;
  for(let i=0;i<oct;i++){v+=p2(x*f,z*f)*a;mx+=a;a*=gain;f*=lac;}
  return v/mx;
}
function colRnd(a,b,salt){
  let h=(Math.imul(a,374761393)^Math.imul(b,668265263)^Math.imul(salt,2246822519))>>>0;
  h=(h^(h>>>13))>>>0;h=Math.imul(h,1274126177)>>>0;h=(h^(h>>>16))>>>0;
  return h/4294967296;
}

// ── BLOCKS ─────────────────────────────────────────────────────
const tryR=id=>{try{return B.resolve(id);}catch{return null;}};
const mkC=c=>{try{return B.resolve("minecraft:coral_block").withState("coral_color",c);}catch{return tryR("minecraft:coral_block");}};
let K=null;
function resolveBlocks(){
  if(K)return true;
  try{
    K={
      air:B.resolve("minecraft:air"),bedrock:B.resolve("minecraft:bedrock"),
      deepslate:B.resolve("minecraft:deepslate"),stone:B.resolve("minecraft:stone"),
      dirt:B.resolve("minecraft:dirt"),coarse:B.resolve("minecraft:coarse_dirt"),
      podzol:B.resolve("minecraft:podzol"),grass:B.resolve("minecraft:grass_block"),
      sand:B.resolve("minecraft:sand"),gravel:B.resolve("minecraft:gravel"),
      water:B.resolve("minecraft:water"),lava:B.resolve("minecraft:lava"),
      snow:B.resolve("minecraft:snow"),mud:B.resolve("minecraft:mud"),
      clay:B.resolve("minecraft:clay"),mycelium:B.resolve("minecraft:mycelium"),
      granite:B.resolve("minecraft:granite"),diorite:B.resolve("minecraft:diorite"),
      andesite:B.resolve("minecraft:andesite"),tuff:B.resolve("minecraft:tuff"),
      calcite:B.resolve("minecraft:calcite"),dripstone:B.resolve("minecraft:dripstone_block"),
      ice:B.resolve("minecraft:ice"),packed_ice:B.resolve("minecraft:packed_ice"),
      blue_ice:tryR("minecraft:blue_ice"),
      coal_o:B.resolve("minecraft:coal_ore"),iron_o:B.resolve("minecraft:iron_ore"),
      copper_o:B.resolve("minecraft:copper_ore"),gold_o:B.resolve("minecraft:gold_ore"),
      lapis_o:B.resolve("minecraft:lapis_ore"),redst_o:B.resolve("minecraft:redstone_ore"),
      diam_o:B.resolve("minecraft:diamond_ore"),emer_o:B.resolve("minecraft:emerald_ore"),
      ds_coal:B.resolve("minecraft:deepslate_coal_ore"),ds_iron:B.resolve("minecraft:deepslate_iron_ore"),
      ds_copper:B.resolve("minecraft:deepslate_copper_ore"),ds_gold:B.resolve("minecraft:deepslate_gold_ore"),
      ds_lapis:B.resolve("minecraft:deepslate_lapis_ore"),ds_redst:B.resolve("minecraft:deepslate_redstone_ore"),
      ds_diam:B.resolve("minecraft:deepslate_diamond_ore"),ds_emer:B.resolve("minecraft:deepslate_emerald_ore"),
      oak_log:B.resolve("minecraft:oak_log"),oak_leaf:B.resolve("minecraft:oak_leaves"),
      birch_log:B.resolve("minecraft:birch_log"),birch_leaf:B.resolve("minecraft:birch_leaves"),
      spruce_log:B.resolve("minecraft:spruce_log"),spruce_leaf:B.resolve("minecraft:spruce_leaves"),
      jungle_log:B.resolve("minecraft:jungle_log"),jungle_leaf:B.resolve("minecraft:jungle_leaves"),
      acacia_log:B.resolve("minecraft:acacia_log"),acacia_leaf:B.resolve("minecraft:acacia_leaves"),
      dark_oak_log:B.resolve("minecraft:dark_oak_log"),dark_oak_leaf:B.resolve("minecraft:dark_oak_leaves"),
      mg_log:B.resolve("minecraft:mangrove_log"),mg_leaf:B.resolve("minecraft:mangrove_leaves"),
      mg_roots:B.resolve("minecraft:mangrove_roots"),
      cherry_log:tryR("minecraft:cherry_log"),cherry_leaf:tryR("minecraft:cherry_leaves"),
      pale_oak_log:tryR("minecraft:pale_oak_log"),pale_oak_leaf:tryR("minecraft:pale_oak_leaves"),
      m_cob:B.resolve("minecraft:mossy_cobblestone"),cobble:B.resolve("minecraft:cobblestone"),
      planks:B.resolve("minecraft:oak_planks"),obsidian:B.resolve("minecraft:obsidian"),
      chest:B.resolve("minecraft:chest"),spawner:B.resolve("minecraft:mob_spawner"),
      cactus:B.resolve("minecraft:cactus"),bone:B.resolve("minecraft:bone_block"),
      craft_t:B.resolve("minecraft:crafting_table"),
      brn_mush_blk:B.resolve("minecraft:brown_mushroom_block"),
      red_mush_blk:B.resolve("minecraft:red_mushroom_block"),
      mush_stem:tryR("minecraft:mushroom_stem"),
      spr_plank:tryR("minecraft:spruce_planks"),jun_plank:tryR("minecraft:jungle_planks"),
      aca_plank:tryR("minecraft:acacia_planks"),dk_plank:tryR("minecraft:dark_oak_planks"),
      chr_plank:tryR("minecraft:cherry_planks"),plo_plank:tryR("minecraft:pale_oak_planks"),
      seagrass:tryR("minecraft:seagrass"),kelp:tryR("minecraft:kelp"),
      lily_pad:tryR("minecraft:waterlily"),
      coral_blue:mkC("blue"),coral_pink:mkC("pink"),coral_purple:mkC("purple"),
      coral_red:mkC("red"),coral_yellow:mkC("yellow"),coral_fan:tryR("minecraft:coral_fan"),
      s_basalt:tryR("minecraft:smooth_basalt"),amethyst:tryR("minecraft:amethyst_block"),
      bud_amethyst:tryR("minecraft:budding_amethyst"),
      moss:tryR("minecraft:moss_block"),bookshelf:tryR("minecraft:bookshelf"),
      iron_bars:tryR("minecraft:iron_bars"),
      s_brick:tryR("minecraft:stone_bricks")||tryR("minecraft:stonebrick"),
      s_brick_c:tryR("minecraft:cracked_stone_bricks"),
      s_brick_m:tryR("minecraft:mossy_stone_bricks"),
      chiseled_sb:tryR("minecraft:chiseled_stone_bricks"),
      sb_slab:tryR("minecraft:stone_brick_slab"),
      end_frame:tryR("minecraft:end_portal_frame"),
      ladder:tryR("minecraft:ladder"),farmland:tryR("minecraft:farmland"),
      wheat:tryR("minecraft:wheat"),campfire:tryR("minecraft:campfire"),
      vpath:tryR("minecraft:dirt_path")||tryR("minecraft:grass_path"),
      magma:tryR("minecraft:magma_block"),
      dandelion:tryR("minecraft:dandelion"),poppy:tryR("minecraft:poppy"),
      blue_orch:tryR("minecraft:blue_orchid"),allium:tryR("minecraft:allium"),
      azure:tryR("minecraft:azure_bluet"),cornfl:tryR("minecraft:cornflower"),
      oxeye:tryR("minecraft:oxeye_daisy"),lily_v:tryR("minecraft:lily_of_the_valley"),
      pink_petals:tryR("minecraft:pink_petals"),eyeblossom:tryR("minecraft:closed_eyeblossom"),
      t_grass:tryR("minecraft:short_grass")||tryR("minecraft:tallgrass"),
      fern:tryR("minecraft:fern"),firefly:tryR("minecraft:firefly_bush"),
      dead_bush:tryR("minecraft:dead_bush")||tryR("minecraft:deadbush"),
      brn_mush:tryR("minecraft:brown_mushroom"),red_mush:tryR("minecraft:red_mushroom"),
      vine:tryR("minecraft:vine"),beehive:tryR("minecraft:beehive"),
      creaking_heart:tryR("minecraft:creaking_heart"),
      red_sand:tryR("minecraft:red_sand"),
      terracotta:tryR("minecraft:terracotta"),
      red_terracotta:tryR("minecraft:red_terracotta"),
      orange_terracotta:tryR("minecraft:orange_terracotta"),
      yellow_terracotta:tryR("minecraft:yellow_terracotta"),
      brown_terracotta:tryR("minecraft:brown_terracotta"),
      white_terracotta:tryR("minecraft:white_terracotta"),
      lg_terracotta:tryR("minecraft:light_gray_terracotta"),
      cob_wall:tryR("minecraft:cobblestone_wall"),
      tnt:tryR("minecraft:tnt"),
      stone_pp:tryR("minecraft:stone_pressure_plate"),
      torch:tryR("minecraft:torch"),
      lantern:tryR("minecraft:lantern"),
      cobweb:tryR("minecraft:cobweb"),
      barrel:tryR("minecraft:barrel"),
      pointed_drip:tryR("minecraft:pointed_dripstone"),
    };
    return true;
  }catch{K=null;return false;}
}

// ── LOW-LEVEL SETTERS ──────────────────────────────────────────
let WMIN=-64,WMAX=320;
function updateBounds(m){try{const hr=m.heightRange;if(hr&&typeof hr.min==="number"){WMIN=hr.min;WMAX=hr.max;}}catch{}}
let _chunkFails=0,_fastSet=null;
const _loc={x:0,y:0,z:0};
const sb=(m,x,y,z,pk)=>{
  if(!pk||y<WMIN||y>WMAX)return;
  if(_fastSet===null)_fastSet=typeof m.setBlockPermutation==="function";
  _loc.x=x;_loc.y=y;_loc.z=z;
  if(_fastSet){try{m.setBlockPermutation(_loc,pk);}catch{_chunkFails++;}return;}
  try{const b=m.getBlock(_loc);if(b)b.setPermutation(pk);else _chunkFails++;}catch{_chunkFails++;}
};
function bulkFill(m,x1,y1,z1,x2,y2,z2,pk){
  if(!pk||!BV||typeof m.fillBlocks!=="function")return false;
  try{m.fillBlocks(new BV({x:x1,y:y1,z:z1},{x:x2,y:y2,z:z2}),pk);return true;}
  catch{return false;}
}

// ── LOOT SYSTEM ────────────────────────────────────────────────
// ►EXT: add a table = add a key. Pool entries {id,min,max,w(eight)}.
//        Tools / non-stackables must use min:1,max:1.
const LOOT={
  default:{rolls:[3,5],pool:[
    {id:"minecraft:bread",min:1,max:3,w:10},
    {id:"minecraft:torch",min:2,max:6,w:8},
    {id:"minecraft:coal",min:2,max:5,w:6},
  ]},
  // Dungeon — richer than vanilla: more rolls, golden apple, music disc, diamonds
  dungeon:{rolls:[5,9],pool:[
    {id:"minecraft:iron_ingot",min:2,max:6,w:10},
    {id:"minecraft:bread",min:2,max:4,w:10},
    {id:"minecraft:string",min:2,max:6,w:8},
    {id:"minecraft:bone",min:2,max:6,w:8},
    {id:"minecraft:gunpowder",min:2,max:5,w:8},
    {id:"minecraft:redstone",min:3,max:8,w:6},
    {id:"minecraft:coal",min:4,max:9,w:6},
    {id:"minecraft:gold_ingot",min:1,max:4,w:5},
    {id:"minecraft:bucket",min:1,max:1,w:4},
    {id:"minecraft:iron_sword",min:1,max:1,w:4},
    {id:"minecraft:saddle",min:1,max:1,w:3},
    {id:"minecraft:name_tag",min:1,max:1,w:3},
    {id:"minecraft:experience_bottle",min:2,max:6,w:3},
    {id:"minecraft:music_disc_cat",min:1,max:1,w:2},
    {id:"minecraft:golden_apple",min:1,max:1,w:2},
    {id:"minecraft:diamond",min:1,max:2,w:2},
    {id:"minecraft:enchanted_golden_apple",min:1,max:1,w:1},
  ]},
  // Stronghold LIBRARY — significantly better than vanilla
  library:{rolls:[6,10],pool:[
    {id:"minecraft:book",min:2,max:5,w:10},
    {id:"minecraft:paper",min:3,max:8,w:8},
    {id:"minecraft:ender_pearl",min:1,max:4,w:6},
    {id:"minecraft:empty_map",min:1,max:2,w:5},
    {id:"minecraft:compass",min:1,max:1,w:4},
    {id:"minecraft:name_tag",min:1,max:2,w:4},
    {id:"minecraft:experience_bottle",min:3,max:8,w:4},
    {id:"minecraft:clock",min:1,max:1,w:3},
    {id:"minecraft:iron_ingot",min:2,max:6,w:4},
    {id:"minecraft:diamond",min:1,max:3,w:3},
    {id:"minecraft:enchanted_book",min:1,max:1,w:3},
    {id:"minecraft:golden_apple",min:1,max:2,w:2},
    {id:"minecraft:eye_of_ender",min:1,max:3,w:1},
  ]},
  prison:{rolls:[2,5],pool:[
    {id:"minecraft:bread",min:1,max:3,w:10},
    {id:"minecraft:rotten_flesh",min:1,max:4,w:8},
    {id:"minecraft:iron_ingot",min:1,max:3,w:5},
    {id:"minecraft:string",min:1,max:3,w:5},
    {id:"minecraft:iron_sword",min:1,max:1,w:3},
    {id:"minecraft:name_tag",min:1,max:1,w:2},
  ]},
  treasury:{rolls:[5,9],pool:[
    {id:"minecraft:gold_ingot",min:2,max:7,w:10},
    {id:"minecraft:iron_ingot",min:2,max:7,w:10},
    {id:"minecraft:lapis_lazuli",min:3,max:8,w:8},
    {id:"minecraft:emerald",min:1,max:5,w:6},
    {id:"minecraft:experience_bottle",min:2,max:6,w:5},
    {id:"minecraft:diamond",min:1,max:3,w:4},
    {id:"minecraft:name_tag",min:1,max:1,w:3},
    {id:"minecraft:enchanted_golden_apple",min:1,max:1,w:1},
  ]},
  armory:{rolls:[4,7],pool:[
    {id:"minecraft:arrow",min:6,max:16,w:10},
    {id:"minecraft:iron_ingot",min:2,max:5,w:8},
    {id:"minecraft:iron_sword",min:1,max:1,w:6},
    {id:"minecraft:shield",min:1,max:1,w:5},
    {id:"minecraft:bow",min:1,max:1,w:5},
    {id:"minecraft:iron_chestplate",min:1,max:1,w:4},
    {id:"minecraft:iron_helmet",min:1,max:1,w:4},
    {id:"minecraft:crossbow",min:1,max:1,w:3},
    {id:"minecraft:diamond",min:1,max:2,w:2},
  ]},
  storage:{rolls:[3,6],pool:[
    {id:"minecraft:bread",min:2,max:5,w:10},
    {id:"minecraft:torch",min:4,max:10,w:8},
    {id:"minecraft:coal",min:4,max:10,w:8},
    {id:"minecraft:iron_ingot",min:1,max:4,w:6},
    {id:"minecraft:string",min:2,max:6,w:5},
    {id:"minecraft:arrow",min:4,max:10,w:5},
  ]},
  dead_end:{rolls:[2,4],pool:[
    {id:"minecraft:bread",min:1,max:2,w:10},
    {id:"minecraft:torch",min:2,max:5,w:8},
    {id:"minecraft:coal",min:2,max:6,w:6},
    {id:"minecraft:iron_nugget",min:2,max:6,w:4},
  ]},
  ruin:{rolls:[2,5],pool:[
    {id:"minecraft:wheat",min:2,max:6,w:10},
    {id:"minecraft:bread",min:1,max:3,w:8},
    {id:"minecraft:iron_nugget",min:2,max:8,w:6},
    {id:"minecraft:gold_nugget",min:1,max:4,w:4},
    {id:"minecraft:emerald",min:1,max:2,w:3},
    {id:"minecraft:iron_ingot",min:1,max:2,w:3},
  ]},
  // Shipwreck split into vanilla's 3 chest types
  shipwreck_supply:{rolls:[4,8],pool:[
    {id:"minecraft:wheat",min:4,max:10,w:10},
    {id:"minecraft:rotten_flesh",min:2,max:6,w:8},
    {id:"minecraft:carrot",min:4,max:8,w:8},
    {id:"minecraft:potato",min:4,max:8,w:8},
    {id:"minecraft:paper",min:2,max:6,w:6},
    {id:"minecraft:coal",min:4,max:8,w:6},
    {id:"minecraft:iron_ingot",min:2,max:6,w:5},
    {id:"minecraft:gunpowder",min:2,max:5,w:4},
    {id:"minecraft:tnt",min:1,max:2,w:3},
    {id:"minecraft:bucket",min:1,max:1,w:2},
  ]},
  shipwreck_treasure:{rolls:[5,9],pool:[
    {id:"minecraft:iron_nugget",min:4,max:12,w:10},
    {id:"minecraft:gold_nugget",min:3,max:9,w:8},
    {id:"minecraft:iron_ingot",min:2,max:7,w:7},
    {id:"minecraft:gold_ingot",min:1,max:5,w:6},
    {id:"minecraft:lapis_lazuli",min:3,max:8,w:5},
    {id:"minecraft:emerald",min:1,max:5,w:5},
    {id:"minecraft:diamond",min:1,max:3,w:3},
    {id:"minecraft:experience_bottle",min:2,max:6,w:3},
    {id:"minecraft:heart_of_the_sea",min:1,max:1,w:1},
  ]},
  shipwreck_map:{rolls:[3,6],pool:[
    {id:"minecraft:empty_map",min:1,max:2,w:10},
    {id:"minecraft:compass",min:1,max:1,w:8},
    {id:"minecraft:clock",min:1,max:1,w:6},
    {id:"minecraft:paper",min:3,max:8,w:6},
    {id:"minecraft:gold_ingot",min:2,max:6,w:4},
    {id:"minecraft:emerald",min:2,max:5,w:3},
    {id:"minecraft:spyglass",min:1,max:1,w:3},
  ]},
  desert_temple:{rolls:[5,9],pool:[
    {id:"minecraft:bone",min:3,max:8,w:10},
    {id:"minecraft:rotten_flesh",min:3,max:8,w:10},
    {id:"minecraft:gunpowder",min:3,max:8,w:8},
    {id:"minecraft:gold_ingot",min:2,max:6,w:8},
    {id:"minecraft:string",min:2,max:6,w:6},
    {id:"minecraft:emerald",min:1,max:4,w:5},
    {id:"minecraft:iron_ingot",min:2,max:6,w:5},
    {id:"minecraft:experience_bottle",min:2,max:6,w:4},
    {id:"minecraft:diamond",min:1,max:3,w:3},
    {id:"minecraft:enchanted_book",min:1,max:1,w:2},
    {id:"minecraft:enchanted_golden_apple",min:1,max:1,w:1},
  ]},
  jungle_temple:{rolls:[4,7],pool:[
    {id:"minecraft:gold_ingot",min:2,max:5,w:8},
    {id:"minecraft:bamboo",min:4,max:10,w:8},
    {id:"minecraft:bone",min:3,max:7,w:8},
    {id:"minecraft:rotten_flesh",min:3,max:7,w:6},
    {id:"minecraft:iron_ingot",min:2,max:5,w:6},
    {id:"minecraft:emerald",min:1,max:4,w:5},
    {id:"minecraft:diamond",min:1,max:2,w:3},
    {id:"minecraft:experience_bottle",min:2,max:5,w:3},
  ]},
  outpost:{rolls:[4,7],pool:[
    {id:"minecraft:arrow",min:6,max:16,w:10},
    {id:"minecraft:carrot",min:3,max:7,w:8},
    {id:"minecraft:potato",min:3,max:7,w:8},
    {id:"minecraft:dark_oak_log",min:3,max:8,w:6},
    {id:"minecraft:iron_ingot",min:2,max:5,w:6},
    {id:"minecraft:crossbow",min:1,max:1,w:5},
    {id:"minecraft:experience_bottle",min:2,max:5,w:3},
    {id:"minecraft:emerald",min:1,max:3,w:3},
  ]},
  village_smithy:{rolls:[3,6],pool:[
    {id:"minecraft:iron_ingot",min:2,max:6,w:10},
    {id:"minecraft:bread",min:2,max:4,w:8},
    {id:"minecraft:obsidian",min:1,max:4,w:4},
    {id:"minecraft:iron_pickaxe",min:1,max:1,w:4},
    {id:"minecraft:iron_sword",min:1,max:1,w:3},
    {id:"minecraft:saddle",min:1,max:1,w:2},
    {id:"minecraft:diamond",min:1,max:1,w:1},
  ]},
};
for(const k in LOOT)LOOT[k].total=LOOT[k].pool.reduce((a,p)=>a+p.w,0);

function lootFill(c,table,x,y,z){
  const t=LOOT[table]||LOOT.default;
  let h=((Math.imul(x|0,374761393)^Math.imul(y|0,668265263)^Math.imul(z|0,1274126177))>>>0)||1;
  const rnd=()=>{h=(Math.imul(h,1664525)+1013904223)>>>0;return h/4294967296;};
  const rolls=t.rolls[0]+((rnd()*(t.rolls[1]-t.rolls[0]+1))|0);
  for(let i=0;i<rolls;i++){
    let r=rnd()*t.total,e=t.pool[0];
    for(const p of t.pool){r-=p.w;if(r<=0){e=p;break;}}
    const n=e.min+((rnd()*(e.max-e.min+1))|0);
    try{c.setItem((rnd()*c.size)|0,new IS(e.id,Math.max(1,n)));}catch{}
  }
}
// The only sanctioned way to place a chest. Places block, fills container,
// retries once next tick if the block entity lags.
function placeChest(m,x,y,z,table){
  sb(m,x,y,z,K.chest);
  if(!IS)return;
  const fill=()=>{
    try{
      const b=m.getBlock({x,y,z});
      if(!b||!b.typeId.includes("chest"))return false;
      const inv=b.getComponent("minecraft:inventory");
      const c=inv&&inv.container;
      if(!c)return false;
      lootFill(c,table,x,y,z);
      return true;
    }catch{return false;}
  };
  if(!fill())try{s.run(fill);}catch{}
}

// ── BIOME ──────────────────────────────────────────────────────
//  0=ocean 1=desert 2=savanna 3=plains 4=forest 5=birch
//  6=jungle 7=mangrove 8=swamp 9=taiga 10=snowy 11=mountain
//  12=coral 13=dark oak 14=cherry 15=pale garden
//  16=ice spikes 17=mooshroom island 18=mesa
function biome(wx,wz,sy){
  if(sy<SEA-4){
    if(sy>=SEA-20&&fbm2(wx*8e-4+500,wz*8e-4,2,2.0,0.5)>0.30)return 12;
    return 0;
  }
  if(sy>190)return 11;
  if(Math.max(Math.abs(wx),Math.abs(wz))>1500&&Math.abs(p2(wx*1.5e-4+8888,wz*1.5e-4))<0.015)return 17;
  const t=fbm2(wx*8e-4+500,wz*8e-4,3,2.0,0.5);
  const h=fbm2(wx*9e-4,    wz*9e-4+500,3,2.0,0.5);
  if(t<-0.60)return 16;
  if(t<-0.50)return 10;
  if(t<-0.20)return 9;
  if(t>-0.20&&t<-0.05&&h<0.04)return 15;
  if(t>0.50&&h<-0.10)return 1;
  if(t>0.42&&h>0.25&&sy>SEA+8)return 18;
  if(t>0.30&&h<0.15)return 2;
  if(t>0.20&&h>0.35&&sy<=SEA+6)return 7;
  if(h>0.30&&sy<=SEA+8)return 8;
  if(h>0.40&&t>0.05&&t<0.30)return 13;
  if(t>0.25&&h>0.35)return 6;
  if(t>0.10&&h>0.10&&h<0.32&&t<0.38)return 14;
  if(h>0.25&&t<0.10)return 5;
  if(h>0.10)return 4;
  return 3;
}

// ── TERRAIN HEIGHT ─────────────────────────────────────────────
function surfY(wx,wz){
  const c=fbm2(wx*1.2e-3,       wz*1.2e-3,       5,2.0,0.50)*120;
  const h=fbm2(wx*7.0e-3+1000,  wz*7.0e-3,       4,2.1,0.45)*35;
  const rr=(1-Math.abs(fbm2(wx*1.8e-2+2000,wz*1.8e-2,3,2.2,0.40)))*20-10;
  const d=fbm2(wx*5.0e-2+3000,  wz*5.0e-2,       2,2.3,0.35)*5;
  let sy=Math.round(BASE+c+h+rr+d);
  const mt=fbm2(wx*5.5e-4+15000,wz*5.5e-4,3,2.0,0.5)*P2N;
  if(mt>0.26){
    const ridge=1-Math.abs(p2(wx*2.2e-3+16000,wz*2.2e-3));
    const f=Math.min(1,(mt-0.26)/0.22);
    sy+=Math.round(f*f*(140+ridge*240));
  }
  const mshDist=Math.max(Math.abs(wx),Math.abs(wz));
  const inMooshroom=mshDist>1500&&Math.abs(p2(wx*1.5e-4+8888,wz*1.5e-4))<0.015;
  if(!inMooshroom){
    const rvx=wx*2.0e-3+wz*0.3e-3+4000,rvz=wz*2.0e-3-wx*0.3e-3;
    const rv=fbm2(rvx,rvz,4,1.9,0.52),rvv=Math.abs(rv);
    const RB=0.12;
    if(rvv<RB){
      const riverDepth=Math.min(1,Math.max(0,(sy-SEA-2)/8));
      if(riverDepth>0){
        const wmod=0.58+0.42*Math.abs(p2(wx*8e-3+4100,wz*8e-3));
        const eff=rvv/(RB*wmod);
        if(eff<1.0){
          const bed=SEA-6+p2(wx*0.04+4300,wz*0.04)*4;
          const t=(1-eff*eff)*riverDepth;
          sy=Math.round(lerp(sy,bed,t));
        }
      }
    }
    if(sy>SEA+8){
      const rnv=p2(wx*3.5e-3+11000+wz*0.5e-3,wz*3.5e-3-wx*0.4e-3);
      if(Math.abs(rnv)<0.018){const t=1-Math.abs(rnv)/0.018;sy=Math.round(lerp(sy,sy-55,t*t));}
    }
  }
  if(sy>SEA+1&&sy<SEA+40){const lk=p2(wx*3.5e-3+7000,wz*3.5e-3);if(lk>0.62)sy=Math.round(lerp(sy,SEA-2,Math.min(1,(lk-0.62)/0.11)));}
  if(sy<SEA-10){const tr=fbm2(wx*1.2e-3+9000,wz*1.2e-3,3,2.1,0.5),trv=Math.abs(tr);if(trv<0.05)sy=Math.round(lerp(sy,SEA-120,Math.min(1,(1-trv/0.05)*(1-trv/0.05))));}
  if(sy>460)sy=460;
  return sy;
}
const _syc=new Map();
function surfYM(wx,wz){
  const k=wx+","+wz;
  let v=_syc.get(k);
  if(v===undefined){
    v=surfY(wx,wz);
    if(_syc.size>20000)_syc.clear();
    _syc.set(k,v);
  }
  return v;
}

// ── STONE VARIANTS ─────────────────────────────────────────────
function stoneBlk(wx,wy,wz,ds){
  const na=p3(wx*0.04,wy*0.04,wz*0.04),nb=p3(wx*0.04+400,wy*0.04,wz*0.04+400);
  if(ds){if(na>0.46&&wy>DS_TOP-60)return K.tuff;if(nb>0.54&&wy>DS_TOP-90)return K.calcite;if(na<-0.50)return K.dripstone;return K.deepslate;}
  if(wy<80&&na>0.44)return K.granite;if(wy<100&&nb>0.45)return K.diorite;
  if(na<-0.44)return K.andesite;if(wy<70&&na>0.52&&nb>0)return K.calcite;
  return K.stone;
}

// ── CAVES ──────────────────────────────────────────────────────
// caveAt returns true for carved air. waterCaveAt marks a regional
// water-cave zone (any height); caves under the seabed / water features
// flood automatically via fillCol's flooding pass.
function caveAt(wx,y,wz){
  if(y<=WMIN+2)return false;
  const reg=p3(wx*0.0025+40000,y*0.0025,wz*0.0025);
  if(reg>0.10+y*0.0004){
    if(p3(wx*0.012,y*0.045,wz*0.012+45000)>0.34)return true;
    if(p3(wx*0.02+47000,y*0.02,wz*0.02)>0.58)return true;
    return false;
  }
  const sc=0.035;
  const n1=p3(wx*sc,y*sc*0.7,wz*sc),n2=p3(wx*sc+50,y*sc*0.7+50,wz*sc+50);
  if(n1*n1+n2*n2<0.016)return true;
  if(y<=60&&y>=-260){
    const s1=p3(wx*0.025,y*0.015,wz*0.025),s2=p3(wx*0.025+30,y*0.015+30,wz*0.025+30);
    if(s1*s1+s2*s2<0.013)return true;
  }
  if(y<=-80&&p3(wx*0.018,y*0.018,wz*0.018)>0.62)return true;
  return false;
}

// ── ORE VEINS ──────────────────────────────────────────────────
// TWEAK: every ore EXCEPT coal — count ×4, clump size ×1.5 (rounded), vs the
// previous build. Coal unchanged. Diamond hard cap raised proportionally.
// count=[min,max] veins/chunk, clump=[min,max] blocks/vein. Spawn-Y biased
// downward (r² → deeper = more likely). capFn hard-caps clump size by depth.
const ORES=[
  {blk:"coal_o",  dsBlk:"ds_coal",  lo:0,   hi:140,  count:[25,40], clump:[6,21]},   // coal unchanged
  {blk:"copper_o",dsBlk:"ds_copper",lo:-64, hi:80,   count:[40,80], clump:[7,17]},   // ×4 / ×1.5
  {blk:"iron_o",  dsBlk:"ds_iron",  lo:-320,hi:80,   count:[40,80], clump:[4,14]},
  {blk:"gold_o",  dsBlk:"ds_gold",  lo:-512,hi:-1,   count:[20,40], clump:[4,9]},
  {blk:"redst_o", dsBlk:"ds_redst", lo:-512,hi:-64,  count:[20,60], clump:[7,14]},
  {blk:"lapis_o", dsBlk:"ds_lapis", lo:-300,hi:20,   count:[0,20],  clump:[4,9]},
  {blk:"diam_o",  dsBlk:"ds_diam",  lo:-512,hi:-200, count:[20,40], clump:[4,14],
    capFn:y=>y<=-450?22:12}, // proportionally raised caps
  {blk:"emer_o",  dsBlk:"ds_emer",  lo:30,  hi:256,  count:[0,20],  clump:[3,5],biome:11},
];
function* placeVeins(m,cx,cz,surfs,bms){
  let h=((Math.imul(cx,2654435761)^Math.imul(cz,40503)^(perm?perm[7]:7))>>>0)||1;
  const rnd=()=>{h=(Math.imul(h,1664525)+1013904223)>>>0;return h/4294967296;};
  const x0=cx*16,z0=cz*16;
  for(const o of ORES){
    const lo=Math.max(o.lo,WMIN+3),hi=Math.min(o.hi,WMAX-1);
    if(lo>hi)continue;
    const n=o.count[0]+((rnd()*(o.count[1]-o.count[0]+1))|0);
    for(let v=0;v<n;v++){
      let x=x0+((rnd()*16)|0),z=z0+((rnd()*16)|0);
      const r=rnd();
      let y=lo+(((hi-lo)*r*r)|0);
      if(o.biome!==undefined&&bms[(x-x0)*16+(z-z0)]!==o.biome)continue;
      let size=o.clump[0]+((rnd()*(o.clump[1]-o.clump[0]+1))|0);
      if(o.capFn)size=Math.min(size,o.capFn(y));
      for(let i=0;i<size;i++){
        const si=(x-x0)*16+(z-z0);
        if(y<=surfs[si]-4&&!caveAt(x,y,z))
          sb(m,x,y,z,y<=DS_TOP?K[o.dsBlk]:K[o.blk]);
        const d=(rnd()*6)|0;
        if(d===0)x=Math.min(x0+15,x+1);else if(d===1)x=Math.max(x0,x-1);
        else if(d===2)z=Math.min(z0+15,z+1);else if(d===3)z=Math.max(z0,z-1);
        else if(d===4)y=Math.min(hi,y+1);else y=Math.max(lo,y-1);
      }
    }
    yield;
  }
}

// ── BULK PREFILL (per chunk: bedrock floor + deep-ocean water only) ──
function* prefillChunk(m,x0,z0,maxS,allOcean){
  const r={bed:false,water:false,waterTop:maxS};
  if(!BV||typeof m.fillBlocks!=="function")return r;
  const yFloor=Math.max(BY,WMIN);
  r.bed=bulkFill(m,x0,yFloor,z0,x0+15,yFloor,z0+15,K.bedrock);
  yield;
  if(allOcean&&maxS<SEA){
    r.water=true;
    for(let y=maxS+1;y<=SEA;y+=FILL_MAX_H){
      if(!bulkFill(m,x0,y,z0,x0+15,Math.min(y+FILL_MAX_H-1,SEA),z0+15,K.water))r.water=false;
      yield;
    }
  }
  return r;
}

// ── FILL COLUMN (one column at a time: foundation → detail; returns top Y) ─
// WATER CAVE LOGIC: regional zones (CAVE_WATER_T, now lowered → more common)
// fill carved cave air up to a flat local level. Additionally, ANY carved
// cave that opens beneath the seabed (sy<SEA) is flooded by the ocean pass so
// "caves that open into a water feature" become water caves automatically.
function fillCol(m,wx,wz,sy,bm,pre){
  const isLush=bm===4||bm===5||bm===6||bm===14;
  const isCold=bm===9||bm===10||bm===16;
  const isDrip=p3(wx*0.03+5500,0,wz*0.03)>0.60;
  const stTop=sy-5;

  const yFloor=Math.max(BY,WMIN);
  if(!pre.bed)sb(m,wx,yFloor,wz,K.bedrock);

  const stLo=Math.max(DS_TOP+1,WMIN+1);
  const dsLo=Math.max(BY+1,WMIN+1);
  const stOK=sy>=stLo?bulkFill(m,wx,stLo,wz,wx,sy,wz,K.stone):false;
  const dsOK=dsLo<=DS_TOP?bulkFill(m,wx,dsLo,wz,wx,DS_TOP,wz,K.deepslate):true;

  // Water-cave zone field (regional, ANY height; recedes near zone edges so
  // there's never a vertical water wall or suspended water).
  const wzn=p2(wx*0.0045+26000,wz*0.0045)*P2N;
  let wLvl=-1e9;
  if(wzn>CAVE_WATER_T){
    const lvl=Math.round(-40+p2(wx*0.0009+27000,wz*0.0009)*200);
    const edge=Math.min(1,(wzn-CAVE_WATER_T)/0.16);
    wLvl=lvl-Math.round((1-edge)*36);
  }
  const lavaCol=p2(wx*0.007+30000,wz*0.007)*P2N>LAVA_LAKE_T;

  let top=yFloor;
  let prevCave=false;

  for(let y=yFloor+1;y<=sy;y++){
    const ds=y<=DS_TOP;
    const prefilled=ds?dsOK:stOK;
    if(caveAt(wx,y,wz)){
      if(lavaCol&&y<=LAVA_LAKE_TOP)sb(m,wx,y,wz,K.lava);
      else if(y<=wLvl)sb(m,wx,y,wz,K.water);
      else{
        if(prefilled)sb(m,wx,y,wz,K.air);
        if(!prevCave&&y-1>yFloor){
          const cb=p3(wx*0.006+25000,y*0.006,wz*0.006);
          if(cb>0.38){
            sb(m,wx,y-1,wz,K.mycelium);
            const r=colRnd(wx+y,wz-y,77);
            if(r<0.22&&K.brn_mush)sb(m,wx,y,wz,r<0.10?K.red_mush:K.brn_mush);
            else if(r<0.27)sb(m,wx,y,wz,K.brn_mush_blk);
          }else if(cb<-0.38){
            const r=colRnd(wx-y,wz+y,79);
            sb(m,wx,y-1,wz,r<0.18?(K.bud_amethyst||K.amethyst):(r<0.60?(K.amethyst||K.calcite):K.calcite));
            if(r>0.88&&K.amethyst)sb(m,wx,y,wz,K.amethyst);
          }
        }
      }
      prevCave=true;continue;
    }
    top=y;

    let blk;
    if(!ds&&y>stTop)blk=K.stone;
    else if(!ds&&isCold&&y<60&&p3(wx*0.05+6000,y*0.05,wz*0.05)>0.73)blk=K.packed_ice;
    else if(!ds&&isLush&&y>-64&&y<40&&p3(wx*0.05+7000,y*0.05,wz*0.05)>0.72)blk=K.moss||stoneBlk(wx,y,wz,false);
    else if(!ds&&isDrip&&!isLush&&y<50&&p3(wx*0.04+5000,y*0.04,wz*0.04)>0.66)blk=K.dripstone;
    else blk=stoneBlk(wx,y,wz,ds);

    if(prevCave){
      const cb=p3(wx*0.006+25000,y*0.006,wz*0.006);
      const r=colRnd(wx,y^wz,83);
      if(cb<-0.38&&r<0.30&&K.amethyst)blk=K.amethyst;
      else if(cb>0.38&&r<0.18)blk=K.brn_mush_blk;
    }
    prevCave=false;

    const base=ds?K.deepslate:K.stone;
    if(blk!==base||!prefilled)sb(m,wx,y,wz,blk);
  }

  const ty=top;

  // Ocean / river / lake — also floods cave shafts opening at the seabed,
  // turning any cave that opens into the ocean into a water cave.
  if(sy<SEA){
    for(let y=top+1;y<=sy;y++)sb(m,wx,y,wz,K.water);
    if(bm===1||bm===2){sb(m,wx,ty,wz,K.sand);for(let d=1;d<=2&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.sand);return ty;}
    const wTop=pre.water?Math.min(pre.waterTop,SEA):SEA;
    for(let y=sy+1;y<=wTop;y++)sb(m,wx,y,wz,K.water);
    if(bm===0){
      const ot=fbm2(wx*8e-4+500,wz*8e-4,2,2.0,0.5);
      const coastal=fbm2(wx*1.2e-3,wz*1.2e-3,2,2.0,0.5)>-0.12;
      if(ot<-0.25&&coastal){
        sb(m,wx,SEA,wz,p2(wx*5e-3+21000,wz*5e-3)>0.70&&K.blue_ice?K.blue_ice:K.ice);
      }
    }
    let floor;
    if(bm===12)floor=K.sand;
    else if(bm!==0)floor=Math.abs(p2(wx*0.10+10000,wz*0.10))>0.40?K.clay:K.gravel;
    else floor=K.gravel;
    if(sy<SEA-50&&K.magma&&p2(wx*0.5+16000,wz*0.5)>0.72)floor=K.magma;
    sb(m,wx,ty,wz,floor);
    for(let d=1;d<=2&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,floor);
    return ty;
  }

  // Surface lakes near sea level: flood the shallow basin and mark as water so
  // a cave opening just below it also becomes a water cave.
  const beach=bm!==1&&bm!==2&&sy<=SEA+3;
  const doBeach=()=>{
    const bn=p2(wx*0.005+8000,wz*0.005);
    if(bn>0.38){for(let d=0;d<=2&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.sand);}
    else if(bn<-0.42){sb(m,wx,ty,wz,K.gravel);for(let d=1;d<=2&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.stone);}
    else{sb(m,wx,ty,wz,K.grass);for(let d=1;d<=3&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.dirt);}
  };

  switch(bm){
    case 1:for(let d=0;d<=3&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.sand);break;
    case 2:sb(m,wx,ty,wz,Math.abs(p2(wx*0.08,wz*0.08))>0.22?K.coarse:K.grass);for(let d=1;d<=3&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.dirt);break;
    case 7:for(let d=0;d<=2&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.mud);for(let d=3;d<=4&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.dirt);break;
    case 8:sb(m,wx,ty,wz,Math.abs(p2(wx*0.09,wz*0.09))>0.30?K.mud:K.grass);for(let d=1;d<=3&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.dirt);break;
    case 9:sb(m,wx,ty,wz,Math.abs(p2(wx*0.10,wz*0.10))>0.30?K.coarse:K.grass);for(let d=1;d<=3&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.dirt);break;
    case 10:sb(m,wx,ty,wz,K.snow);for(let d=1;d<=3&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.dirt);break;
    case 11:if(sy>220){sb(m,wx,ty+1,wz,K.snow);return ty+1;}sb(m,wx,ty,wz,K.grass);for(let d=1;d<=2&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.dirt);break;
    case 13:if(beach)doBeach();else{sb(m,wx,ty,wz,K.podzol);for(let d=1;d<=3&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.dirt);}break;
    case 14:if(beach)doBeach();else{sb(m,wx,ty,wz,K.grass);for(let d=1;d<=3&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.dirt);}break;
    case 15:if(beach)doBeach();else{sb(m,wx,ty,wz,Math.abs(p2(wx*0.07,wz*0.07))>0.35?K.coarse:K.grass);for(let d=1;d<=3&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.dirt);}break;
    case 16:if(beach)doBeach();else{sb(m,wx,ty,wz,K.snow);for(let d=1;d<=4&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.packed_ice);}break;
    case 17:if(beach)doBeach();else{sb(m,wx,ty,wz,K.mycelium);for(let d=1;d<=3&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.dirt);}break;
    case 18:{
      const TC=[K.red_terracotta,K.orange_terracotta,K.yellow_terracotta,K.brown_terracotta,K.white_terracotta,K.lg_terracotta,K.terracotta];
      if(K.red_sand)sb(m,wx,ty,wz,K.red_sand);else sb(m,wx,ty,wz,K.sand);
      for(let d=1;d<=5&&ty-d>DS_TOP;d++){
        const tc=TC[Math.abs(Math.floor((ty-d-SEA)*0.7))%TC.length]||K.stone;
        sb(m,wx,ty-d,wz,tc||K.stone);
      }
    }break;
    default:if(beach)doBeach();else{sb(m,wx,ty,wz,K.grass);for(let d=1;d<=3&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.dirt);}
  }
  return ty;
}

// ── TREES (vanilla-style: per-species canopies, varied height) ─
const mkTRnd=(wx,wz,salt)=>{let i=0;return()=>colRnd(wx+i*97,wz-(i++)*131,salt);};
function leafLayer(m,cx,y,cz,leaf,r,cut,rnd){
  if(!leaf)return;
  for(let x=-r;x<=r;x++)for(let z=-r;z<=r;z++){
    if(Math.abs(x)===r&&Math.abs(z)===r){
      if(cut===2)continue;
      if(cut===1&&rnd()<0.5)continue;
    }
    sb(m,cx+x,y,cz+z,leaf);
  }
}
function leafLayer2(m,cx,y,cz,leaf,r,rnd){
  if(!leaf)return;
  for(let x=-r;x<=r+1;x++)for(let z=-r;z<=r+1;z++){
    const ex=x<0?-x:(x>1?x-1:0),ez=z<0?-z:(z>1?z-1:0);
    if(Math.max(ex,ez)>r)continue;
    if(ex===r&&ez===r&&rnd()<0.5)continue;
    sb(m,cx+x,y,cz+z,leaf);
  }
}
const trunk1=(m,x,ty,z,log,h)=>{for(let i=0;i<h;i++)sb(m,x,ty+i,z,log);};
const trunk2=(m,x,ty,z,log,h)=>{for(let i=0;i<h;i++){sb(m,x,ty+i,z,log);sb(m,x+1,ty+i,z,log);sb(m,x,ty+i,z+1,log);sb(m,x+1,ty+i,z+1,log);}};
function branches2(m,x,topY,z,log,leaf,rnd){
  const off=[[-1,-1],[2,-1],[-1,2],[2,2],[-1,0],[2,1],[0,-1],[1,2]];
  const n=1+((rnd()*3)|0);
  for(let i=0;i<n;i++){
    const o=off[(rnd()*off.length)|0];
    sb(m,x+o[0],topY,z+o[1],log);
    sb(m,x+o[0],topY+1,z+o[1],leaf);
  }
}

function placeOak(m,wx,ty,wz){
  const rnd=mkTRnd(wx,wz,101);
  const h=4+((rnd()*3)|0);
  leafLayer(m,wx,ty+h-2,wz,K.oak_leaf,2,1,rnd);
  leafLayer(m,wx,ty+h-1,wz,K.oak_leaf,2,1,rnd);
  leafLayer(m,wx,ty+h,  wz,K.oak_leaf,1,1,rnd);
  leafLayer(m,wx,ty+h+1,wz,K.oak_leaf,1,2,rnd);
  trunk1(m,wx,ty,wz,K.oak_log,h);
  if(K.beehive&&rnd()>0.95)sb(m,wx+1,ty+h-2,wz,K.beehive);
}
function placeBirch(m,wx,ty,wz){
  const rnd=mkTRnd(wx,wz,103);
  const h=5+((rnd()*3)|0);
  leafLayer(m,wx,ty+h-2,wz,K.birch_leaf,2,1,rnd);
  leafLayer(m,wx,ty+h-1,wz,K.birch_leaf,2,1,rnd);
  leafLayer(m,wx,ty+h,  wz,K.birch_leaf,1,1,rnd);
  leafLayer(m,wx,ty+h+1,wz,K.birch_leaf,1,2,rnd);
  trunk1(m,wx,ty,wz,K.birch_log,h);
}
function placeSpruce(m,wx,ty,wz){
  const rnd=mkTRnd(wx,wz,107);
  const h=7+((rnd()*5)|0);
  sb(m,wx,ty+h+1,wz,K.spruce_leaf);
  let r=1;
  for(let ly=h;ly>=3;ly--){
    leafLayer(m,wx,ty+ly,wz,K.spruce_leaf,r,r>=2?2:0,rnd);
    if(rnd()<0.5)r=Math.min(3,r+1);else if(r>1&&rnd()<0.35)r--;
  }
  trunk1(m,wx,ty,wz,K.spruce_log,h);
}
function placeMegaSpruce(m,wx,ty,wz){
  const rnd=mkTRnd(wx,wz,109);
  const h=16+((rnd()*8)|0);
  leafLayer2(m,wx,ty+h+1,wz,K.spruce_leaf,0,rnd);
  let r=1;
  for(let ly=h;ly>=5;ly--){
    leafLayer2(m,wx,ty+ly,wz,K.spruce_leaf,r,rnd);
    if(rnd()<0.45)r=Math.min(4,r+1);else if(r>1&&rnd()<0.30)r--;
  }
  trunk2(m,wx,ty,wz,K.spruce_log,h);
}
function placeJungle(m,wx,ty,wz){
  const rnd=mkTRnd(wx,wz,151);
  const h=8+((rnd()*6)|0);
  leafLayer(m,wx,ty+h-1,wz,K.jungle_leaf,2,1,rnd);
  leafLayer(m,wx,ty+h,  wz,K.jungle_leaf,2,1,rnd);
  leafLayer(m,wx,ty+h+1,wz,K.jungle_leaf,1,2,rnd);
  trunk1(m,wx,ty,wz,K.jungle_log,h);
  if(K.vine)for(let i=0;i<4;i++)sb(m,wx+((rnd()*5)|0)-2,ty+h-2,wz+((rnd()*5)|0)-2,K.vine);
}
function placeMegaJungle(m,wx,ty,wz){
  const rnd=mkTRnd(wx,wz,113);
  const h=20+((rnd()*9)|0);
  leafLayer2(m,wx,ty+h-1,wz,K.jungle_leaf,4,rnd);
  leafLayer2(m,wx,ty+h,  wz,K.jungle_leaf,3,rnd);
  leafLayer2(m,wx,ty+h+1,wz,K.jungle_leaf,2,rnd);
  trunk2(m,wx,ty,wz,K.jungle_log,h);
  if(K.vine)for(let i=0;i<6;i++){
    const side=(rnd()*4)|0;
    const vx=side===0?-1:side===1?2:((rnd()*2)|0);
    const vz=side===2?-1:side===3?2:((rnd()*2)|0);
    sb(m,wx+vx,ty+4+((rnd()*(h-8))|0),wz+vz,K.vine);
  }
}
function placeAcacia(m,wx,ty,wz){
  const rnd=mkTRnd(wx,wz,139);
  const h=5+((rnd()*3)|0);
  const dx=rnd()<0.5?-1:1,dz=rnd()<0.5?-1:1;
  trunk1(m,wx,ty,wz,K.acacia_log,h-1);
  sb(m,wx+dx,ty+h-1,wz,K.acacia_log);
  leafLayer(m,wx+dx,ty+h,  wz,K.acacia_leaf,3,2,rnd);
  leafLayer(m,wx+dx,ty+h+1,wz,K.acacia_leaf,1,1,rnd);
  if(rnd()<0.5){
    sb(m,wx-dx,ty+h-2,wz+dz,K.acacia_log);
    leafLayer(m,wx-dx,ty+h-1,wz+dz,K.acacia_leaf,2,2,rnd);
  }
}
function placeDarkOak(m,wx,ty,wz){
  const rnd=mkTRnd(wx,wz,127);
  const h=6+((rnd()*3)|0);
  leafLayer2(m,wx,ty+h-1,wz,K.dark_oak_leaf,3,rnd);
  leafLayer2(m,wx,ty+h,  wz,K.dark_oak_leaf,2,rnd);
  leafLayer2(m,wx,ty+h+1,wz,K.dark_oak_leaf,1,rnd);
  trunk2(m,wx,ty,wz,K.dark_oak_log,h);
  branches2(m,wx,ty+h-1,wz,K.dark_oak_log,K.dark_oak_leaf,rnd);
}
function placeMangrove(m,wx,ty,wz){
  const rnd=mkTRnd(wx,wz,149);
  const h=6+((rnd()*4)|0);
  const lf=K.mg_leaf||K.oak_leaf;
  leafLayer(m,wx,ty+h-1,wz,lf,2,1,rnd);
  leafLayer(m,wx,ty+h,  wz,lf,2,1,rnd);
  leafLayer(m,wx,ty+h+1,wz,lf,1,2,rnd);
  trunk1(m,wx,ty+1,wz,K.mg_log||K.oak_log,h-1);
  sb(m,wx,ty,wz,K.mg_roots||K.mg_log||K.dirt);
  for(const e of [[1,0],[-1,0],[0,1],[0,-1]])
    if(rnd()<0.8){sb(m,wx+e[0],ty,wz+e[1],K.mg_roots||K.dirt);if(rnd()<0.5)sb(m,wx+e[0],ty+1,wz+e[1],K.mg_roots||K.dirt);}
}
function placeCherry(m,wx,ty,wz){
  if(!K.cherry_log)return placeOak(m,wx,ty,wz);
  const rnd=mkTRnd(wx,wz,137);
  const h=4+((rnd()*3)|0);
  const ox=rnd()<0.5?-1:1,oz=rnd()<0.5?-1:1;
  leafLayer(m,wx+ox,ty+h,  wz+oz,K.cherry_leaf,2,2,rnd);
  leafLayer(m,wx+ox,ty+h+1,wz+oz,K.cherry_leaf,3,1,rnd);
  leafLayer(m,wx+ox,ty+h+2,wz+oz,K.cherry_leaf,2,1,rnd);
  trunk1(m,wx,ty,wz,K.cherry_log,h);
  sb(m,wx+ox,ty+h,wz+oz,K.cherry_log);
  if(K.pink_petals&&rnd()<0.5)sb(m,wx+ox,ty,wz+oz,K.pink_petals);
}
function placePaleOak(m,wx,ty,wz){
  if(!K.pale_oak_log)return placeDarkOak(m,wx,ty,wz);
  const rnd=mkTRnd(wx,wz,131);
  const h=7+((rnd()*3)|0);
  const lf=K.pale_oak_leaf||K.oak_leaf;
  leafLayer2(m,wx,ty+h-1,wz,lf,3,rnd);
  leafLayer2(m,wx,ty+h,  wz,lf,2,rnd);
  leafLayer2(m,wx,ty+h+1,wz,lf,1,rnd);
  for(let i=0,n=3+((rnd()*3)|0);i<n;i++){
    const hx=wx+((rnd()*7)|0)-3,hz=wz+((rnd()*7)|0)-3;
    sb(m,hx,ty+h-2,hz,lf);
    if(rnd()<0.5)sb(m,hx,ty+h-3,hz,lf);
  }
  trunk2(m,wx,ty,wz,K.pale_oak_log,h);
  branches2(m,wx,ty+h-1,wz,K.pale_oak_log,lf,rnd);
  if(K.creaking_heart&&rnd()<0.25)sb(m,wx,ty+(h>>1),wz,K.creaking_heart);
}
function giantMushroom(m,wx,ty,wz){
  const h=5+Math.floor(Math.abs(p2(wx*0.4,wz*0.4))*4);
  const isBrown=p2(wx*0.3+2000,wz*0.3)>0;
  const cap=isBrown?K.brn_mush_blk:K.red_mush_blk;
  const stem=K.mush_stem||K.stone;
  for(let y=0;y<h-1;y++)sb(m,wx,ty+y,wz,stem);
  for(let x=-2;x<=2;x++)for(let z=-2;z<=2;z++){
    if(Math.abs(x)===2&&Math.abs(z)===2)continue;
    sb(m,wx+x,ty+h-1,wz+z,cap);
    sb(m,wx+x,ty+h,  wz+z,cap);
  }
  sb(m,wx,ty+h+1,wz,cap);
}

// ── OCEAN FEATURES ─────────────────────────────────────────────
function placeOceanFeat(m,wx,ty,wz,bm){
  if(bm!==0&&bm!==12)return;
  if(bm===12){
    const ct=p2(wx*0.08+9000,wz*0.08)*P2N;
    if(ct>0.70){const cbs=[K.coral_blue,K.coral_pink,K.coral_purple,K.coral_red,K.coral_yellow];const ci=Math.floor(Math.abs(ct*5))%5;if(cbs[ci])sb(m,wx,ty+1,wz,cbs[ci]);}
    else if(ct>0.50&&K.coral_fan)sb(m,wx,ty+1,wz,K.coral_fan);
    return;
  }
  if(ty>=SEA-3){
    const sg=p2(wx*0.12+10000,wz*0.12)*P2N;
    if(sg>0.65&&K.seagrass){sb(m,wx,ty+1,wz,K.seagrass);}
    else if(sg<-0.60&&K.kelp&&ty<=SEA-5){
      const kh=Math.floor(Math.abs(sg)*8);
      for(let y=1;y<=Math.min(kh,SEA-ty-1);y++)sb(m,wx,ty+y,wz,K.kelp);
    }
  }
}

// ── SURFACE FLORA ──────────────────────────────────────────────
function placeFlora(m,wx,ty,wz,bm){
  const r=colRnd(wx,wz,11),r2=colRnd(wx,wz,23);
  switch(bm){
    case 1:if(r<0.04&&K.dead_bush)sb(m,wx,ty+1,wz,K.dead_bush);break;
    case 2:if(r<0.05&&K.dead_bush)sb(m,wx,ty+1,wz,K.dead_bush);else if(r<0.23&&K.t_grass)sb(m,wx,ty+1,wz,K.t_grass);break;
    case 3:{
      const fls=[K.dandelion,K.poppy,K.blue_orch,K.allium,K.azure,K.cornfl,K.oxeye,K.lily_v];
      if(r<0.05){const fi=(r2*fls.length)|0;if(fls[fi])sb(m,wx,ty+1,wz,fls[fi]);}
      else if(r<0.33&&K.t_grass)sb(m,wx,ty+1,wz,K.t_grass);
    }break;
    case 4:if(r<0.25&&K.t_grass)sb(m,wx,ty+1,wz,K.t_grass);else if(r<0.33&&K.fern)sb(m,wx,ty+1,wz,K.fern);break;
    case 5:if(r<0.28&&K.t_grass)sb(m,wx,ty+1,wz,K.t_grass);break;
    case 6:if(r<0.25&&K.fern)sb(m,wx,ty+1,wz,K.fern);else if(r<0.33&&K.vine)sb(m,wx,ty+1,wz,K.vine);break;
    case 7:if(r<0.18&&K.seagrass)sb(m,wx,ty+1,wz,K.seagrass);break;
    case 8:if(r<0.25&&K.t_grass)sb(m,wx,ty+1,wz,K.t_grass);else if(r<0.31&&K.lily_pad)sb(m,wx,ty+1,wz,K.lily_pad);break;
    case 9:if(r<0.22&&K.fern)sb(m,wx,ty+1,wz,K.fern);break;
    case 13:if(r<0.20&&K.fern)sb(m,wx,ty+1,wz,K.fern);break;
    case 14:if(r<0.08&&K.pink_petals)sb(m,wx,ty+1,wz,K.pink_petals);else if(r<0.30&&K.t_grass)sb(m,wx,ty+1,wz,K.t_grass);break;
    case 15:
      if(r<0.05&&K.eyeblossom)sb(m,wx,ty+1,wz,K.eyeblossom);
      else if(r<0.13&&K.pale_oak_leaf){
        sb(m,wx,ty+1,wz,K.pale_oak_leaf);
        if(r2<0.40&&K.firefly)sb(m,wx,ty+2,wz,K.firefly);
      }
      else if(r<0.30&&K.t_grass)sb(m,wx,ty+1,wz,K.t_grass);
      break;
    case 16:if(K.packed_ice&&r<0.06){sb(m,wx,ty+1,wz,K.packed_ice);if(r2<0.5)sb(m,wx,ty+2,wz,K.packed_ice);}break;
    case 17:if(r<0.20&&K.brn_mush)sb(m,wx,ty+1,wz,r2<0.5?K.red_mush:K.brn_mush);break;
    case 18:if(r<0.05&&K.dead_bush)sb(m,wx,ty+1,wz,K.dead_bush);else if(r<0.07&&K.cactus)sb(m,wx,ty+1,wz,K.cactus);break;
  }
}

// ── PLACE FEATURES ─────────────────────────────────────────────
// TWEAK 1: forest-type biomes (forest, birch, jungle, taiga, snowy, dark oak,
//   cherry, pale) have their tree densities multiplied by 0.8 (=1.25× less
//   common). FOREST_SET marks which biomes received the reduction.
// TWEAK 2: adjacency suppression — a candidate tree is only placed if its
//   per-column roll is the LOCAL MINIMUM among the 8 neighbouring candidates,
//   so two trees almost never end up directly adjacent. Cheap: neighbours are
//   only probed for columns that already pass the density threshold.
const FOREST_SET={4:1,5:1,6:1,9:1,10:1,13:1,14:1,15:1};
const TREES={
  2:[[0.012,placeAcacia]],                          // savanna (sparse, kept)
  3:[[0.012,placeOak]],                             // plains  (sparse, kept)
  4:[[0.032,placeBirch],[0.080,placeOak]],          // forest   ×0.8
  5:[[0.064,placeBirch]],                           // birch    ×0.8
  6:[[0.0096,placeMegaJungle],[0.080,placeJungle],[0.112,placeOak]], // jungle ×0.8
  7:[[0.070,placeMangrove]],                        // mangrove (kept)
  8:[[0.020,placeOak]],                             // swamp    (kept)
  9:[[0.0096,placeMegaSpruce],[0.072,placeSpruce]], // taiga    ×0.8
  10:[[0.036,placeSpruce]],                         // snowy    ×0.8
  13:[[0.048,placeDarkOak]],                        // dark oak ×0.8
  14:[[0.056,placeCherry]],                         // cherry   ×0.8
  15:[[0.056,placePaleOak]],                        // pale     ×0.8
};
// Pre-computed per-biome max threshold (top of the cumulative band) for the
// cheap neighbour-candidacy test in adjacency suppression.
const TREE_MAXT={};
for(const k in TREES){let mx=0;for(const e of TREES[k])if(e[0]>mx)mx=e[0];TREE_MAXT[k]=mx;}
const groveAt=(wx,wz)=>0.55+0.9*Math.abs(p2(wx*0.015+520,wz*0.015));
const treeRoll=(wx,wz)=>colRnd(wx,wz,7);
// True if no neighbouring candidate column has a smaller roll (→ local min).
function treeIsLocalMin(wx,wz,myRoll,maxT){
  for(let dx=-1;dx<=1;dx++)for(let dz=-1;dz<=1;dz++){
    if(dx===0&&dz===0)continue;
    const nx=wx+dx,nz=wz+dz;
    const nr=treeRoll(nx,nz);
    if(nr<myRoll&&nr<maxT*groveAt(nx,nz))return false; // neighbour wins
  }
  return true;
}
function* placeFeat(m,cx,cz,surfs,bms,tys){
  const x0=cx*16,z0=cz*16;
  for(let wx=x0;wx<x0+16;wx++){
    for(let wz=z0;wz<z0+16;wz++){
      const si=(wx-x0)*16+(wz-z0);
      const sy=surfs[si],bm=bms[si];
      if(sy<SEA){placeOceanFeat(m,wx,tys[si],wz,bm);continue;}
      const ty=tys[si];

      if(bm!==0&&bm!==12)placeFlora(m,wx,ty,wz,bm);

      const tr=treeRoll(wx,wz);
      const grove=groveAt(wx,wz);
      const list=TREES[bm];
      if(list){
        const maxT=TREE_MAXT[bm];
        // pass threshold first (cheap), then adjacency suppression
        if(tr<maxT*grove&&treeIsLocalMin(wx,wz,tr,maxT)){
          for(const e of list){if(tr<e[0]*grove){e[1](m,wx,ty+1,wz);break;}}
        }
      }
      else if(bm===11){if(sy>160&&tr<0.05*grove&&treeIsLocalMin(wx,wz,tr,0.05))placeSpruce(m,wx,ty+1,wz);}
      else if(bm===17){if(tr<0.12*grove)giantMushroom(m,wx,ty+1,wz);}
      else if(bm===18&&tr<0.015){
        const TC2=[K.red_terracotta,K.orange_terracotta,K.terracotta];
        const ph=3+((colRnd(wx,wz,31)*5)|0);
        const pilBlk=TC2[(colRnd(wx,wz,37)*3)|0]||K.stone;
        for(let py=1;py<=ph;py++)sb(m,wx,ty+py,wz,pilBlk);
      }
    }
    yield;
  }
}

// ── STRONGHOLD: SHARED HELPERS ─────────────────────────────────
const shWM=(x,y,z)=>{
  const n=p3(x*0.18+8000,y*0.14,z*0.18);
  return n>0.42?(K.s_brick_c||K.stone):(n<-0.42?(K.s_brick_m||K.stone):(K.s_brick||K.stone));
};
function* shHollow(m,x1,y1,z1,x2,y2,z2){
  for(let x=x1;x<=x2;x++){
    for(let y=y1;y<=y2;y++)for(let z=z1;z<=z2;z++){
      const wall=x===x1||x===x2||y===y1||y===y2||z===z1||z===z2;
      sb(m,x,y,z,wall?shWM(x,y,z):K.air);
    }
    yield;
  }
}
const shDoor=(m,cx,wy,cz,ddx,ddz,hd)=>{
  const dwx=cx-ddx*(hd+1),dwz=cz-ddz*(hd+1);
  for(let p=-1;p<=1;p++)for(let dy=1;dy<=3;dy++)
    sb(m,dwx+(ddz?p:0),wy+dy,dwz+(ddx?p:0),K.air);
  const dwx2=cx-ddx*(hd+2),dwz2=cz-ddz*(hd+2);
  for(let p=-1;p<=1;p++)for(let dy=1;dy<=3;dy++)
    sb(m,dwx2+(ddz?p:0),wy+dy,dwz2+(ddx?p:0),K.air);
};
// Corridor cross-section (this chunk only). Supports a vertical slope so the
// stronghold has real verticality (descending staircases between levels).
function* placeSHCorrChunk(m,cx,cz,task){
  const {sx,sz,ddx,ddz,len,wy,slope}=task;
  const x0=cx*16,z0=cz*16;
  for(let step=0;step<=len;step++){
    const stepX=sx+ddx*step,stepZ=sz+ddz*step;
    if(stepX<x0||stepX>x0+15||stepZ<z0||stepZ>z0+15)continue;
    const fy=wy+(slope?-(step>>1):0); // descend 1 block every 2 steps when slope
    for(let p=-2;p<=2;p++)for(let py=0;py<=4;py++){
      const wx=stepX+(ddz?p:0),wz=stepZ+(ddx?p:0);
      const wall=Math.abs(p)===2||py===0||py===4;
      sb(m,wx,fy+py,wz,wall?shWM(wx,fy+py,wz):K.air);
    }
    if(slope){ // stair block underfoot
      sb(m,stepX,fy,stepZ,shWM(stepX,fy,stepZ));
      if(K.lantern&&step%5===0)sb(m,stepX,fy+4,stepZ,K.lantern);
    }else if(K.torch&&step%6===0){
      sb(m,stepX+(ddz?2:0),fy+3,stepZ+(ddx?2:0),K.torch);
    }
    if(step%4===0)yield;
  }
}

// ── ROOM FUNCTIONS ─────────────────────────────────────────────
// 2-STORY LIBRARY — bigger than vanilla: tall hall, mezzanine balcony,
// bookshelf walls on BOTH floors, cobwebs, 4 chests (2 up, 2 down).
function* roomLib(m,cx,wy,cz,ddx,ddz,hd,hw){
  const h=13;
  const x1=cx-(ddx?hd:hw)-1,x2=cx+(ddx?hd:hw)+1;
  const z1=cz-(ddz?hd:hw)-1,z2=cz+(ddz?hd:hw)+1;
  yield* shHollow(m,x1,wy,z1,x2,wy+h,z2);
  shDoor(m,cx,wy,cz,ddx,ddz,hd);
  const mid=wy+6; // mezzanine floor
  // mezzanine planks walkway around the perimeter (leaves an open central well)
  for(let x=x1+1;x<=x2-1;x++)for(let z=z1+1;z<=z2-1;z++){
    const rim=x===x1+1||x===x2-1||z===z1+1||z===z2-1;
    if(rim)sb(m,x,mid,z,K.plo_plank||K.planks);
  }
  // bookshelves line both floors
  if(K.bookshelf){
    for(const fy of [wy+1,wy+2,wy+3, mid+1,mid+2,mid+3]){
      for(let x=x1+1;x<=x2-1;x++){sb(m,x,fy,z1+1,K.bookshelf);sb(m,x,fy,z2-1,K.bookshelf);}
      for(let z=z1+2;z<=z2-2;z++){sb(m,x1+1,fy,z,K.bookshelf);sb(m,x2-1,fy,z,K.bookshelf);}
    }
  }
  // cobwebs in the rafters
  if(K.cobweb){sb(m,x1+2,wy+h-1,z1+2,K.cobweb);sb(m,x2-2,wy+h-1,z2-2,K.cobweb);sb(m,cx,wy+h-1,cz,K.cobweb);}
  // ladder from ground to mezzanine
  if(K.ladder)for(let y=wy+1;y<=mid;y++)try{sb(m,cx,y,cz+(ddx?1:0)+(ddz?0:1),K.ladder);}catch{}
  // lighting
  if(K.lantern){sb(m,cx,mid-1,cz,K.lantern);sb(m,cx,wy+h-1,cz,K.lantern);}
  // 4 library chests — improved loot
  placeChest(m,cx,wy+1,cz+(ddx?1:0),"library");
  placeChest(m,cx+(ddz?1:0),wy+1,cz,"library");
  placeChest(m,x1+2,mid+1,z1+2,"library");
  placeChest(m,x2-2,mid+1,z2-2,"library");
  yield;
}

function* roomPrison(m,cx,wy,cz,ddx,ddz,hd,hw){
  const h=6;
  const x1=cx-(ddx?hd:hw)-1,x2=cx+(ddx?hd:hw)+1;
  const z1=cz-(ddz?hd:hw)-1,z2=cz+(ddz?hd:hw)+1;
  yield* shHollow(m,x1,wy,z1,x2,wy+h,z2);
  shDoor(m,cx,wy,cz,ddx,ddz,hd);
  if(K.iron_bars){
    for(let p=-hw+1;p<=hw-1;p+=3)for(let dy=1;dy<=3;dy++){
      if(ddx)sb(m,cx+ddx*hd,wy+dy,cz+p,K.iron_bars);
      else   sb(m,cx+p,wy+dy,cz+ddz*hd,K.iron_bars);
    }
  }
  sb(m,cx,wy+1,cz,K.spawner);
  placeChest(m,cx+(ddz*2||1),wy+1,cz+(ddx*2||0),"prison");
  yield;
}

function* roomTreasury(m,cx,wy,cz,ddx,ddz,hd,hw){
  const h=5;
  const x1=cx-(ddx?hd:hw)-1,x2=cx+(ddx?hd:hw)+1;
  const z1=cz-(ddz?hd:hw)-1,z2=cz+(ddz?hd:hw)+1;
  yield* shHollow(m,x1,wy,z1,x2,wy+h,z2);
  shDoor(m,cx,wy,cz,ddx,ddz,hd);
  if(K.cobweb){sb(m,x1+1,wy+h-1,z1+1,K.cobweb);sb(m,x2-1,wy+h-1,z2-1,K.cobweb);}
  // central pillar of chiseled brick + lava-lit alcove feel
  sb(m,cx,wy+1,cz,K.chiseled_sb||K.s_brick);sb(m,cx,wy+2,cz,K.chiseled_sb||K.s_brick);
  placeChest(m,cx-1,wy+1,cz-1,"treasury");placeChest(m,cx+1,wy+1,cz+1,"treasury");
  placeChest(m,cx-1,wy+1,cz+1,"treasury");placeChest(m,cx+1,wy+1,cz-1,"treasury");
  if(K.lantern){sb(m,cx,wy+h-1,cz,K.lantern);}
  yield;
}

function* roomArmory(m,cx,wy,cz,ddx,ddz,hd,hw){
  const h=5;
  const x1=cx-(ddx?hd:hw)-1,x2=cx+(ddx?hd:hw)+1;
  const z1=cz-(ddz?hd:hw)-1,z2=cz+(ddz?hd:hw)+1;
  yield* shHollow(m,x1,wy,z1,x2,wy+h,z2);
  shDoor(m,cx,wy,cz,ddx,ddz,hd);
  placeChest(m,cx,wy+1,cz,"armory");
  placeChest(m,cx+1,wy+1,cz,"armory");
  sb(m,cx-1,wy+1,cz,K.craft_t);
  if(K.iron_bars){for(let z=z1+1;z<=z2-1;z+=2)sb(m,x1+1,wy+1,z,K.iron_bars);}
  if(K.torch){sb(m,x1+1,wy+3,cz,K.torch);sb(m,x2-1,wy+3,cz,K.torch);}
  yield;
}

// NEW: storage room — barrels/chests rows, well-lit
function* roomStorage(m,cx,wy,cz,ddx,ddz,hd,hw){
  const h=5;
  const x1=cx-(ddx?hd:hw)-1,x2=cx+(ddx?hd:hw)+1;
  const z1=cz-(ddz?hd:hw)-1,z2=cz+(ddz?hd:hw)+1;
  yield* shHollow(m,x1,wy,z1,x2,wy+h,z2);
  shDoor(m,cx,wy,cz,ddx,ddz,hd);
  const B2=K.barrel||K.chest;
  for(let x=x1+1;x<=x2-1;x+=2)for(let z=z1+1;z<=z2-1;z+=3){
    sb(m,x,wy+1,z,B2);if(B2===K.chest){/*loot below*/}
  }
  placeChest(m,cx,wy+1,cz,"storage");
  placeChest(m,cx+1,wy+1,cz+1,"storage");
  if(K.lantern){sb(m,cx,wy+h-1,cz,K.lantern);}
  yield;
}

// NEW: fountain room — decorative central water basin (vanilla-like)
function* roomFountain(m,cx,wy,cz,ddx,ddz,hd,hw){
  const h=7;
  const x1=cx-(ddx?hd:hw)-1,x2=cx+(ddx?hd:hw)+1;
  const z1=cz-(ddz?hd:hw)-1,z2=cz+(ddz?hd:hw)+1;
  yield* shHollow(m,x1,wy,z1,x2,wy+h,z2);
  shDoor(m,cx,wy,cz,ddx,ddz,hd);
  // basin
  for(let x=cx-1;x<=cx+1;x++)for(let z=cz-1;z<=cz+1;z++){
    sb(m,x,wy+1,z,K.s_brick||K.stone);
  }
  sb(m,cx,wy+1,cz,K.water);
  sb(m,cx,wy+2,cz,K.chiseled_sb||K.s_brick);
  sb(m,cx,wy+3,cz,K.water);
  // pillars at corners
  for(const[ox,oz] of [[-2,-2],[2,-2],[-2,2],[2,2]])
    for(let dy=1;dy<=4;dy++)sb(m,cx+ox,wy+dy,cz+oz,shWM(cx+ox,wy+dy,cz+oz));
  if(K.lantern){for(const[ox,oz] of [[-2,-2],[2,-2],[-2,2],[2,2]])sb(m,cx+ox,wy+5,cz+oz,K.lantern);}
  placeChest(m,cx+2,wy+1,cz,"storage");
  yield;
}

function* roomDeadEnd(m,cx,wy,cz,ddx,ddz,hd,hw){
  const h=4;
  const x1=cx-(ddx?hd:hw)-1,x2=cx+(ddx?hd:hw)+1;
  const z1=cz-(ddz?hd:hw)-1,z2=cz+(ddz?hd:hw)+1;
  yield* shHollow(m,x1,wy,z1,x2,wy+h,z2);
  shDoor(m,cx,wy,cz,ddx,ddz,hd);
  placeChest(m,cx,wy+1,cz,"dead_end");
  yield;
}

function* placeRoomSH(m,cx,wy,cz,type,ddx,ddz,hd,hw){
  switch(type){
    case 'library':  yield* roomLib(m,cx,wy,cz,ddx,ddz,hd,hw);break;
    case 'prison':   yield* roomPrison(m,cx,wy,cz,ddx,ddz,hd,hw);break;
    case 'treasury': yield* roomTreasury(m,cx,wy,cz,ddx,ddz,hd,hw);break;
    case 'armory':   yield* roomArmory(m,cx,wy,cz,ddx,ddz,hd,hw);break;
    case 'storage':  yield* roomStorage(m,cx,wy,cz,ddx,ddz,hd,hw);break;
    case 'fountain': yield* roomFountain(m,cx,wy,cz,ddx,ddz,hd,hw);break;
    default:         yield* roomDeadEnd(m,cx,wy,cz,ddx,ddz,hd,hw);break;
  }
}

// ── STRONGHOLD LAYOUT (pure, seeded, 3-level modular graph) ────
// Each of the 4 cardinal directions grows a chain of up to 3 rooms joined by
// corridors; some corridors slope down a level (real verticality). One
// direction is GUARANTEED to host the 2-story library. Deterministic per seed.
function computeSHLayout(){
  let _sr=((perm[88]|(perm[166]<<8))>>>0)||1;
  const shR=()=>{_sr=(_sr*1664525+1013904223)>>>0;return _sr;};
  const shRd=()=>shR()/0x100000000;
  const shRi=n=>(shR()%n+n)%n;

  const RDEF={
    library: {hd:7,hw:5},prison:{hd:5,hw:4},treasury:{hd:4,hw:3},
    armory:{hd:4,hw:3},storage:{hd:5,hw:4},fountain:{hd:4,hw:4},dead_end:{hd:3,hw:2}
  };
  const RTYPES=['prison','treasury','armory','storage','fountain','dead_end'];
  const DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
  const libDir=shRi(4); // which direction hosts the guaranteed library

  const tasks=[];
  for(let di=0;di<4;di++){
    const [ddx,ddz]=DIRS[di];
    let wy=SHY;
    // ── Level 1 ──
    const L1=10+shRi(8);
    let sx=ddx*8,sz=ddz*8;
    tasks.push({type:'corridor',sx,sz,ddx,ddz,len:L1,wy});

    const rt1=(di===libDir)?'library':RTYPES[shRi(RTYPES.length)];
    const r1=RDEF[rt1];
    const dist1=9+L1+r1.hd;
    tasks.push({type:rt1,cx:ddx*dist1,cz:ddz*dist1,ddx,ddz,hd:r1.hd,hw:r1.hw,wy});

    // ── Level 2 (≈60% chance) ──
    if(shRd()>0.40){
      const slope=shRd()>0.5;
      const L2=8+shRi(6);
      const sx2=ddx*(dist1+r1.hd+1),sz2=ddz*(dist1+r1.hd+1);
      tasks.push({type:'corridor',sx:sx2,sz:sz2,ddx,ddz,len:L2,wy,slope});
      if(slope)wy-=(L2>>1);
      const rt2=RTYPES[shRi(RTYPES.length)];
      const r2=RDEF[rt2];
      const dist2=dist1+r1.hd+1+L2+r2.hd;
      tasks.push({type:rt2,cx:ddx*dist2,cz:ddz*dist2,ddx,ddz,hd:r2.hd,hw:r2.hw,wy});

      // ── Level 3 (≈35% chance) ──
      if(shRd()>0.55){
        const slope3=shRd()>0.5;
        const L3=7+shRi(5);
        const sx3=ddx*(dist2+r2.hd+1),sz3=ddz*(dist2+r2.hd+1);
        tasks.push({type:'corridor',sx:sx3,sz:sz3,ddx,ddz,len:L3,wy,slope:slope3});
        if(slope3)wy-=(L3>>1);
        const rt3=RTYPES[shRi(RTYPES.length)];
        const r3=RDEF[rt3];
        const dist3=dist2+r2.hd+1+L3+r3.hd;
        tasks.push({type:rt3,cx:ddx*dist3,cz:ddz*dist3,ddx,ddz,hd:r3.hd,hw:r3.hw,wy});
      }
    }
  }
  return tasks;
}

// ── STRONGHOLD PIECE (each chunk within range contributes its parts) ──
function* placeStrongholdPiece(m,cx,cz){
  if(Math.abs(cx)>9||Math.abs(cz)>9)return; // wider radius for the larger build
  if(SHY<WMIN)return;
  const layout=computeSHLayout();

  // Portal room + entrance shaft: chunk (0,0) only — enlarged 17×17 hall
  if(cx===0&&cz===0){
    yield* shHollow(m,SHX-8,SHY,SHZ-8,SHX+8,SHY+9,SHZ+8);
    const epf=K.end_frame||K.obsidian;
    // 12-frame end portal ring
    for(const[fx,fz] of [[-1,-2],[0,-2],[1,-2],[-1,2],[0,2],[1,2],
                          [-2,-1],[-2,0],[-2,1],[2,-1],[2,0],[2,1]])
      sb(m,SHX+fx,SHY+1,SHZ+fz,epf);
    // raised platform around the portal
    for(let x=SHX-3;x<=SHX+3;x++)for(let z=SHZ-3;z<=SHZ+3;z++)sb(m,x,SHY,z,K.s_brick||K.stone);
    for(let x=SHX-1;x<=SHX+1;x++)for(let z=SHZ-1;z<=SHZ+1;z++)sb(m,x,SHY,z,K.lava); // central lava well below frame
    // silverfish spawner in a corner (not inside the ring)
    sb(m,SHX+6,SHY+1,SHZ+6,K.spawner);
    // a library-tier chest guarding the portal
    placeChest(m,SHX-6,SHY+1,SHZ-6,"treasury");
    if(K.lantern)for(const[ox,oz] of [[-7,-7],[7,-7],[-7,7],[7,7]])sb(m,SHX+ox,SHY+8,SHZ+oz,K.lantern);
    // doorways out of the portal hall on all 4 sides
    for(let p=-1;p<=1;p++)for(let dy=1;dy<=3;dy++){
      sb(m,SHX+p,SHY+dy,SHZ-8,K.air);sb(m,SHX+p,SHY+dy,SHZ+8,K.air);
      sb(m,SHX+8,SHY+dy,SHZ+p,K.air);sb(m,SHX-8,SHY+dy,SHZ+p,K.air);
    }
    yield;
    // Entrance shaft from y=-256 cap down to the stronghold ceiling
    const S=K.s_brick||K.stone;
    for(let y=-256;y>=SHY+30;y--){
      for(let ox=-2;ox<=2;ox++)for(let oz=-2;oz<=2;oz++){
        if(Math.abs(ox)===2||Math.abs(oz)===2)sb(m,SHX+ox,y,SHZ+oz,S);
        else sb(m,SHX+ox,y,SHZ+oz,K.air);
      }
      if(K.ladder&&y%3===0)try{sb(m,SHX+2,y,SHZ,K.ladder);}catch{}
      if(y%20===0)yield;
    }
    yield;
  }

  for(const task of layout){
    if(task.type==='corridor'){
      const worldTask={...task,sx:SHX+task.sx,sz:SHZ+task.sz};
      yield* placeSHCorrChunk(m,cx,cz,worldTask);
    }else{
      const wcx=SHX+task.cx,wcz=SHZ+task.cz;
      const rChunkX=Math.floor(wcx/16),rChunkZ=Math.floor(wcz/16);
      if(rChunkX===cx&&rChunkZ===cz){
        yield* placeRoomSH(m,wcx,task.wy,wcz,task.type,task.ddx,task.ddz,task.hd,task.hw);
      }
    }
    yield;
  }
}

// ── SURFACE / UNDERGROUND STRUCTURE BUILDERS ──────────────────
// MODULAR DUNGEON — a central hall + 1-3 random side chambers joined by short
// corridors. Multiple spawners and up to 6 chests → bigger & better than the
// vanilla single-room dungeon.
function* dungeonRoom(m,cx,ry,cz,hw,hd){
  const S=K.cobble||K.stone;
  for(let x=cx-hw;x<=cx+hw;x++){
    for(let y=ry;y<=ry+5;y++)for(let z=cz-hd;z<=cz+hd;z++){
      const wall=x===cx-hw||x===cx+hw||y===ry||y===ry+5||z===cz-hd||z===cz+hd;
      if(wall){const n=p3(x*0.2,y*0.2,z*0.2);sb(m,x,y,z,n>0.3?K.m_cob:n<-0.3?K.cobble:S);}
      else sb(m,x,y,z,K.air);
    }
    if((x&3)===0)yield;
  }
}
function* complexDungeonAt(m,wx,wz,sy){
  const ry=Math.min(sy-25,20);if(ry<=DS_TOP+15)return;
  // central hall
  yield* dungeonRoom(m,wx,ry,wz,7,7);
  sb(m,wx,ry+1,wz,K.spawner);
  for(let i=0;i<4;i++){const a=i*Math.PI/2;placeChest(m,wx+Math.round(Math.cos(a)*4),ry+1,wz+Math.round(Math.sin(a)*4),"dungeon");}
  if(K.cobweb)for(const[ox,oz] of [[-6,-6],[6,6],[-6,6],[6,-6]])sb(m,wx+ox,ry+4,wz+oz,K.cobweb);
  // side chambers
  let h=((Math.imul(wx,2246822519)^Math.imul(wz,3266489917))>>>0)||1;
  const rnd=()=>{h=(Math.imul(h,1664525)+1013904223)>>>0;return h/4294967296;};
  const dirs=[[1,0],[-1,0],[0,1],[0,-1]];
  const nSide=1+((rnd()*3)|0);
  for(let i=0;i<nSide;i++){
    const d=dirs[(rnd()*4)|0];
    const off=11+((rnd()*4)|0);
    const scx=wx+d[0]*off,scz=wz+d[1]*off;
    // connecting corridor
    for(let step=8;step<off;step++){
      const px=wx+d[0]*step,pz=wz+d[1]*step;
      for(let p=-1;p<=1;p++)for(let py=0;py<=3;py++){
        const bx=px+(d[0]?0:p),bz=pz+(d[1]?0:p);
        const wall=Math.abs(p)===1||py===0||py===3;
        sb(m,bx,ry+py,bz,wall?(K.cobble||K.stone):K.air);
      }
    }
    yield;
    yield* dungeonRoom(m,scx,ry,scz,4,4);
    if(rnd()<0.7)sb(m,scx,ry+1,scz,K.spawner);
    placeChest(m,scx+1,ry+1,scz,"dungeon");
    if(rnd()<0.5)placeChest(m,scx-1,ry+1,scz,"storage");
    yield;
  }
}

function ruinAt(m,wx,wz,sy){
  if(sy<SEA)return;
  const ry=sy-1;
  const W=K.cobble||K.stone;
  for(let x=wx-3;x<=wx+3;x++)for(let y=ry-1;y<=ry+5;y++)for(let z=wz-3;z<=wz+3;z++){
    const wall=x===wx-3||x===wx+3||y===ry-1||y===ry+5||z===wz-3||z===wz+3;
    if(!wall)continue;
    const skip=p2((x-wx)*0.7+wx*0.03,(z-wz)*0.7+wz*0.03)>0.25;
    if(!skip)sb(m,x,y,z,p3(x*0.2,y*0.2,z*0.2)>0?K.m_cob:W);
  }
  placeChest(m,wx,ry,wz,"ruin");
}

function shaftAt(m,wx,wz,sy){
  if(sy<SEA+5)return;
  const S=K.stone;
  for(let y=sy-20;y<=sy;y++){
    for(let ox=-2;ox<=2;ox++)for(let oz=-2;oz<=2;oz++){
      if(Math.abs(ox)===2||Math.abs(oz)===2){sb(m,wx+ox,y,wz+oz,S);}
      else sb(m,wx+ox,y,wz+oz,K.air);
    }
    if(K.ladder&&y%3===0)try{sb(m,wx+2,y,wz,K.ladder);}catch{}
  }
}

function portalAt(m,wx,wz,sy){
  if(sy<SEA)return;
  const skip=(a,b)=>p2((wx+a)*0.8+7000,(wz+b)*0.8)>0;
  for(const[fx,fy] of [[0,0],[0,1],[0,2],[0,3],[0,4],[1,4],[2,4],[3,4],[3,3],[3,2],[3,1],[3,0],[1,0],[2,0]])
    if(!skip(fx,fy))sb(m,wx+fx,sy+fy,wz,K.obsidian);
  for(let x=wx;x<=wx+3;x++)sb(m,x,sy-1,wz,K.gravel);
}

// FOSSIL — now spawns at ANY y (caller passes a wide-range fy) and as bigger,
// varied rib structures. Spread placement handled in placeStructures.
function fossilAt(m,wx,wz,fy){
  if(fy<=DS_TOP+8||fy>=WMAX-10)return;
  let h=((Math.imul(wx,668265263)^Math.imul(wz,2246822519))>>>0)||1;
  const rnd=()=>{h=(Math.imul(h,1664525)+1013904223)>>>0;return h/4294967296;};
  const kind=(rnd()*3)|0;
  if(kind===0){ // spine + ribs
    const len=8+((rnd()*5)|0);
    for(let i=0;i<len;i++){
      sb(m,wx+i,fy,wz,K.bone);
      if(i%2===0){sb(m,wx+i,fy+1,wz,K.bone);sb(m,wx+i,fy+2,wz-1,K.bone);sb(m,wx+i,fy+2,wz+1,K.bone);}
    }
  }else if(kind===1){ // rib cage arches
    for(let i=0;i<5;i++){
      const bx=wx+i*2;
      sb(m,bx,fy,wz-2,K.bone);sb(m,bx,fy+1,wz-2,K.bone);
      sb(m,bx,fy+2,wz-1,K.bone);sb(m,bx,fy+2,wz,K.bone);sb(m,bx,fy+2,wz+1,K.bone);
      sb(m,bx,fy+1,wz+2,K.bone);sb(m,bx,fy,wz+2,K.bone);
    }
  }else{ // skull cluster
    for(const[ox,oy,oz] of [[0,0,0],[1,0,0],[2,0,0],[3,0,0],[4,0,0],[0,1,0],[4,1,0],[0,2,0],[4,2,0],[2,3,0],[2,0,1],[2,0,-1],[2,0,2],[2,0,-2]])
      sb(m,wx+ox,fy+oy,wz+oz,K.bone);
  }
}

// PROPER SHIPWRECK — curved hull with pointed bow/stern, deck, mast and 3
// loot chests (supply / treasure / map), like vanilla. Generator for size.
function* shipwreckAt(m,wx,wz,sy){
  if(sy>SEA-3)return;
  const hy=Math.max(sy+1,SEA-18); // hull bottom
  const PL=K.planks,LG=K.oak_log,SL=K.spr_plank||K.planks;
  const half=2; // hull half-width
  const len=14; // bow→stern length (along x)
  // Hull: tapered ends, 4 tall, planked sides + bottom
  for(let i=0;i<len;i++){
    const x=wx-7+i;
    // taper width near bow/stern
    const edgeDist=Math.min(i,len-1-i);
    const hw=edgeDist<2?1:half;
    for(let y=hy;y<=hy+4;y++){
      for(let z=wz-hw;z<=wz+hw;z++){
        const side=z===wz-hw||z===wz+hw;
        const bottom=y===hy;
        const end=edgeDist===0;
        if(bottom||side||end){
          const skip=p2((x)*0.6+wx*0.02,(z)*0.6+wz*0.02)>0.42; // weathered holes
          if(!skip)sb(m,x,y,z,LG);
        }else sb(m,x,y,z,K.air);
      }
    }
    // deck planks across the top
    if(edgeDist>=1)for(let z=wz-hw;z<=wz+hw;z++)sb(m,x,hy+4,z,PL);
    if((i&3)===0)yield;
  }
  // raised stern cabin
  for(let x=wx+3;x<=wx+6;x++)for(let y=hy+5;y<=hy+7;y++)for(let z=wz-2;z<=wz+2;z++){
    const wall=x===wx+3||x===wx+6||y===hy+5||y===hy+7||z===wz-2||z===wz+2;
    if(wall)sb(m,x,y,z,SL);else sb(m,x,y,z,K.air);
  }
  // mast
  for(let y=hy+5;y<=hy+12;y++)sb(m,wx,y,wz,LG);
  for(let z=wz-3;z<=wz+3;z++)sb(m,wx,hy+10,wz+(z-wz),LG);
  yield;
  // 3 chests
  placeChest(m,wx-5,hy+1,wz,"shipwreck_supply");
  placeChest(m,wx,hy+1,wz,"shipwreck_treasure");
  placeChest(m,wx+5,hy+6,wz,"shipwreck_map");
  yield;
}

// GEODE — now placeable at ANY y (caller passes a wide-range ry). Spread
// placement handled in placeStructures (per-chunk rare hash, isolated).
function* geodeGen(m,wx,wz,ry){
  if(!K.amethyst||!K.s_basalt)return;
  if(ry<=WMIN+6||ry>=WMAX-6)return;
  const rad=5+(Math.abs(p2(wx*0.1,wz*0.1))*2|0)%3;
  for(let dx=-rad-2;dx<=rad+2;dx++){
    for(let dy=-rad-2;dy<=rad+2;dy++)for(let dz=-rad-2;dz<=rad+2;dz++){
      const dist=Math.sqrt(dx*dx+dy*dy+dz*dz);
      if     (dist<=rad-2)sb(m,wx+dx,ry+dy,wz+dz,K.air);
      else if(dist<=rad-1)sb(m,wx+dx,ry+dy,wz+dz,Math.abs(p3(wx+dx,ry+dy,wz+dz))>0.5?K.bud_amethyst||K.amethyst:K.amethyst);
      else if(dist<=rad  )sb(m,wx+dx,ry+dy,wz+dz,K.calcite);
      else if(dist<=rad+1)sb(m,wx+dx,ry+dy,wz+dz,K.s_basalt);
    }
    yield;
  }
}

function pillagerOutpostAt(m,wx,wz,sy){
  if(sy<SEA+5)return;
  const W=K.cobble||K.stone,PL=K.spr_plank||K.planks,LL=K.oak_log;
  const h=12;
  for(let x=wx-2;x<=wx+2;x++)for(let y=sy;y<=sy+h;y++)for(let z=wz-2;z<=wz+2;z++){
    const wall=x===wx-2||x===wx+2||y===sy||y===sy+h||z===wz-2||z===wz+2;
    if(wall)sb(m,x,y,z,y%3===0?LL:W);
    else sb(m,x,y,z,K.air);
  }
  for(let x=wx-3;x<=wx+3;x++)for(let z=wz-3;z<=wz+3;z++)sb(m,x,sy+h,z,PL||K.planks);
  sb(m,wx,sy+1,wz-2,K.air);sb(m,wx,sy+2,wz-2,K.air);
  if(K.ladder)for(let y=sy+1;y<=sy+h-1;y++)try{sb(m,wx,y,wz+1,K.ladder);}catch{}
  placeChest(m,wx,sy+h-1,wz,"outpost");
  sb(m,wx,sy+h+1,wz,LL);sb(m,wx,sy+h+2,wz,LL);
  for(const[ox,oz] of [[-4,-4],[4,-4],[-4,4],[4,4]]){
    for(let y=sy;y<=sy+4;y++)sb(m,wx+ox,y,wz+oz,LL);
    for(let p=0;p<4;p++){
      sb(m,wx+ox+(p*(ox>0?-1:1)),sy+4,wz+oz,PL||K.planks);
      sb(m,wx+ox,sy+4,wz+oz+(p*(oz>0?-1:1)),PL||K.planks);
    }
  }
  const CW=K.cob_wall||W;
  for(const[ox,oz] of [[-5,0],[5,0],[0,-5],[0,5],[-5,-5],[5,-5],[-5,5],[5,5]])
    sb(m,wx+ox,sy+1,wz+oz,CW);
  for(let i=0;i<3;i++)try{dim().spawnEntity("minecraft:pillager",{x:wx+i-1,y:sy+h+1,z:wz});}catch{}
}

function* desertTempleAt(m,wx,wz,sy){
  if(sy<SEA)return;
  const SS=tryR("minecraft:sandstone")||K.sand;
  const CS=tryR("minecraft:cut_sandstone")||SS;
  const CH=tryR("minecraft:chiseled_sandstone")||SS;
  const OS=tryR("minecraft:orange_terracotta")||K.stone;
  const h=12,hw=9; // bigger than before
  for(let level=0;level<=h;level++){
    const r=hw-level;
    if(r<0)break;
    for(let x=wx-r;x<=wx+r;x++)for(let z=wz-r;z<=wz+r;z++){
      const edge=x===wx-r||x===wx+r||z===wz-r||z===wz+r;
      sb(m,x,sy+level,z,edge?SS:CS);
    }
    if(level%3===0)yield;
  }
  // twin towers
  for(const[ox,oz] of [[-hw,-hw],[hw,-hw],[-hw,hw],[hw,hw]])
    for(let dy=0;dy<=h+2;dy++)sb(m,wx+ox,sy+dy,wz+oz,(dy&1)?CH:SS);
  sb(m,wx,sy+h+1,wz,CH);
  for(let x=wx-4;x<=wx+4;x++)for(let z=wz-4;z<=wz+4;z++)for(let y=sy+1;y<=sy+7;y++){
    if(x>wx-4&&x<wx+4&&z>wz-4&&z<wz+4)sb(m,x,y,z,K.air);
    else if(y===sy+1)sb(m,x,y,z,OS);
  }
  yield;
  // hidden treasure pit with a TNT trap, like vanilla
  for(let y=sy-6;y<=sy;y++)sb(m,wx,y,wz,K.air);
  for(let x=wx-2;x<=wx+2;x++)for(let z=wz-2;z<=wz+2;z++){
    sb(m,x,sy-8,z,OS);if(x!==wx||z!==wz)sb(m,x,sy-7,z,CS);
  }
  if(K.tnt)for(let x=wx-1;x<=wx+1;x++)for(let z=wz-1;z<=wz+1;z++)sb(m,x,sy-8,z,K.tnt);
  if(K.stone_pp)sb(m,wx,sy-6,wz,K.stone_pp);
  placeChest(m,wx-2,sy-7,wz,"desert_temple");placeChest(m,wx+2,sy-7,wz,"desert_temple");
  placeChest(m,wx,sy-7,wz-2,"desert_temple");placeChest(m,wx,sy-7,wz+2,"desert_temple");
  for(let dy=1;dy<=4;dy++)sb(m,wx,sy+dy,wz-hw,K.air);
  if(OS)for(let x=wx-3;x<=wx+3;x++)for(let z=wz-3;z<=wz+3;z++)sb(m,x,sy+1,z,(x+z)%2===0?OS:CS);
  yield;
}

function* jungleTempleAt(m,wx,wz,sy){
  if(sy<SEA)return;
  const W=K.m_cob||K.cobble;
  const h=12,hw=6; // bigger
  for(let level=0;level<=h;level++){
    const r=hw-Math.floor(level*0.4);if(r<1)break;
    for(let x=wx-r;x<=wx+r;x++)for(let z=wz-r;z<=wz+r;z++){
      const wall=x===wx-r||x===wx+r||z===wz-r||z===wz+r;
      sb(m,x,sy+level,z,wall?W:K.air);
    }
    if(level%3===0)yield;
  }
  for(let dy=1;dy<=3;dy++)sb(m,wx,sy+dy,wz-hw,K.air);
  // hidden basement with two chests
  for(let y=sy-5;y<=sy;y++)sb(m,wx,y,wz,K.air);
  for(let x=wx-2;x<=wx+2;x++)for(let z=wz-2;z<=wz+2;z++)for(let y=sy-6;y<=sy-3;y++){
    const wall=x===wx-2||x===wx+2||z===wz-2||z===wz+2||y===sy-6;
    if(wall)sb(m,x,y,z,W);else sb(m,x,y,z,K.air);
  }
  placeChest(m,wx-1,sy-5,wz,"jungle_temple");
  placeChest(m,wx+1,sy-5,wz,"jungle_temple");
  if(K.vine)for(const[ox,oz] of [[-hw+1,0],[hw-1,0],[0,-hw+1],[0,hw-1]])
    for(let dy=2;dy<=6;dy++)try{sb(m,wx+ox,sy+dy,wz+oz,K.vine);}catch{}
  yield;
}

// ── STRUCTURE REGISTRY ─────────────────────────────────────────
// NOTE: geode & fossil are NOT in this registry anymore — they use an
// independent per-chunk rare hash (see placeStructures) so they spawn ISOLATED
// and at ANY y height instead of in clustered groups of adjacent chunks.
const NOT_OCEAN=bm=>bm!==0&&bm!==12;
const STRUCTURES=[
  {name:"dungeon",         group:"main",s:0.17,o:6000, test:v=>v> 0.55,                          gen:true, fn:complexDungeonAt},
  {name:"ruin",            group:"main",s:0.13,o:7000, test:v=>v> 0.60, ok:NOT_OCEAN,                      fn:ruinAt},
  {name:"mineshaft",                    s:0.17,o:6000, test:v=>v<-0.55, ok:NOT_OCEAN,                      fn:shaftAt},
  {name:"ruined_portal",                s:0.17,o:6000, test:v=>v> 0.70, ok:NOT_OCEAN,                      fn:portalAt},
  {name:"shipwreck",                    s:0.11,o:8000, test:v=>v<-0.62, ok:bm=>bm===0||bm===12, gen:true,  fn:shipwreckAt},
  {name:"pillager_outpost",             s:0.19,o:9000, test:v=>v> 0.72, ok:bm=>bm===3||bm===2||bm===9||bm===1||bm===18, fn:pillagerOutpostAt},
  {name:"desert_temple",                s:0.23,o:10500,test:v=>v> 0.70, ok:bm=>bm===1,           gen:true, fn:desertTempleAt},
  {name:"jungle_temple",                s:0.21,o:11000,test:v=>v> 0.74, ok:bm=>bm===6,           gen:true, fn:jungleTempleAt},
];

// ── VILLAGE ────────────────────────────────────────────────────
const VILLAGE_LAYOUT=[
  {type:'well',dx:0,dz:0},{type:'house_s',dx:10,dz:0},{type:'house_l',dx:-12,dz:0},
  {type:'house_s',dx:0,dz:10},{type:'farm',dx:10,dz:10},{type:'smithy',dx:-12,dz:10},
  {type:'library',dx:0,dz:-12}
];
const villageMats=bm=>{
  if(bm===1||bm===2)return {wall:K.aca_plank||K.planks,roof:K.acacia_log,trim:K.stone};
  if(bm===9||bm===10)return {wall:K.spr_plank||K.planks,roof:K.spruce_log,trim:K.cobble};
  if(bm===6)return {wall:K.jun_plank||K.planks,roof:K.jungle_log,trim:K.cobble};
  if(bm===13)return {wall:K.dk_plank||K.planks,roof:K.dark_oak_log,trim:K.cobble};
  return {wall:K.planks,roof:K.oak_log,trim:K.cobble};
};
function getVillageCenter(cx,cz){
  const gx=Math.round(cx/VILLAGE_GRID)*VILLAGE_GRID;
  const gz=Math.round(cz/VILLAGE_GRID)*VILLAGE_GRID;
  const vn=p2(gx*0.15+3000,gz*0.15)*P2N;
  if(vn<0.62)return null;
  const ox=(p2(gx*0.7+4000,gz*0.7)*0.5|0)*16+8;
  const oz=(p2(gx*0.7,gz*0.7+4000)*0.5|0)*16+8;
  return {vcx:gx*16+ox,vcz:gz*16+oz};
}
const buildHouse=(m,bx,bsy,bz,mts,large)=>{
  const w2=large?9:7,d=7,h=5;
  for(let x=bx;x<=bx+w2;x++)for(let y=bsy;y<=bsy+h;y++)for(let z=bz;z<=bz+d;z++){
    const wall=x===bx||x===bx+w2||y===bsy||y===bsy+h||z===bz||z===bz+d;
    if(wall){if(y===bsy)sb(m,x,y,z,mts.trim);else if(y===bsy+h)sb(m,x,y,z,mts.roof);else sb(m,x,y,z,mts.wall);}
    else sb(m,x,y,z,K.air);
  }
  sb(m,bx+Math.floor(w2/2),bsy+1,bz,K.air);
  sb(m,bx+Math.floor(w2/2),bsy+2,bz,K.air);
};
const buildFarm=(m,bx,bsy,bz,mts)=>{
  for(let x=bx-3;x<=bx+3;x++)for(let z=bz-3;z<=bz+3;z++){
    if(K.farmland)sb(m,x,bsy-1,z,K.farmland);
    if(K.wheat&&p2(x*0.3,z*0.3)>0)sb(m,x,bsy,z,K.wheat);
  }
  sb(m,bx,bsy-1,bz,K.water);
};
const buildSmithy=(m,bx,bsy,bz,mts)=>{
  buildHouse(m,bx,bsy,bz,mts,false);
  sb(m,bx+2,bsy+1,bz+2,K.craft_t);
  placeChest(m,bx+2,bsy+1,bz+3,"village_smithy");
};
const buildLibrary=(m,bx,bsy,bz,mts)=>{
  buildHouse(m,bx,bsy,bz,mts,true);
  if(K.bookshelf){for(let x=bx+1;x<=bx+7;x++)sb(m,x,bsy+1,bz+1,K.bookshelf);}
};
const buildWell=(m,bx,bsy,bz,mts)=>{
  for(let x=bx-1;x<=bx+1;x++)for(let z=bz-1;z<=bz+1;z++){
    if(x===bx&&z===bz){sb(m,x,bsy-1,z,K.water);}
    else{sb(m,x,bsy,z,mts.trim);sb(m,x,bsy-1,z,mts.trim);}
  }
};
const drawRoad=(m,vcx,vcz,bx,bz)=>{
  const dx=bx-vcx,dz=bz-vcz,len=Math.sqrt(dx*dx+dz*dz)|0;
  if(len===0)return;
  for(let i=0;i<=len;i++){
    const rx=vcx+Math.round(dx*i/len),rz=vcz+Math.round(dz*i/len);
    const rsy=surfYM(rx,rz);
    sb(m,rx,rsy,rz,K.vpath||K.gravel);
    sb(m,rx,rsy-1,rz,K.gravel);
  }
};
function* placeVillage(m,cx,cz){
  for(let dgx=-VILLAGE_GRID;dgx<=VILLAGE_GRID;dgx+=VILLAGE_GRID){
    for(let dgz=-VILLAGE_GRID;dgz<=VILLAGE_GRID;dgz+=VILLAGE_GRID){
      const vc=getVillageCenter(cx+dgx,cz+dgz);
      if(!vc)continue;
      const{vcx,vcz}=vc;
      if(Math.abs(Math.floor(vcx/16)-cx)>5||Math.abs(Math.floor(vcz/16)-cz)>5)continue;
      const vsy=surfYM(vcx,vcz),vbm=biome(vcx,vcz,vsy);
      if(vbm===0||vbm===11||vbm===12||vbm===16||vbm===17)continue;
      const mts=villageMats(vbm);
      for(const bldg of VILLAGE_LAYOUT){
        const bx=vcx+bldg.dx,bz=vcz+bldg.dz;
        if(Math.abs(Math.floor(bx/16)-cx)>1||Math.abs(Math.floor(bz/16)-cz)>1)continue;
        const bsy=surfYM(bx,bz);
        try{
          switch(bldg.type){
            case 'well':    buildWell(m,bx,bsy,bz,mts);break;
            case 'house_s': buildHouse(m,bx,bsy,bz,mts,false);break;
            case 'house_l': buildHouse(m,bx,bsy,bz,mts,true);break;
            case 'farm':    buildFarm(m,bx,bsy,bz,mts);break;
            case 'smithy':  buildSmithy(m,bx,bsy,bz,mts);break;
            case 'library': buildLibrary(m,bx,bsy,bz,mts);break;
          }
          if(bldg.type!=='well')drawRoad(m,vcx,vcz,bx,bz);
          if(bldg.type!=='well'&&bldg.type!=='farm')
            try{dim().spawnEntity("minecraft:villager",{x:bx,y:bsy+1,z:bz});}catch{}
        }catch{}
        yield;
      }
    }
  }
}

// ── PASSIVE MOBS ───────────────────────────────────────────────
// Biome → passive pool ("minecraft:" prefix added automatically).
const PASSIVES={
  1:["rabbit"],2:["cow","sheep","horse"],3:["cow","sheep","pig","chicken","horse"],
  4:["sheep","pig","chicken","wolf"],5:["sheep","chicken"],6:["chicken","parrot","ocelot"],
  7:["frog"],8:["frog","chicken"],9:["sheep","rabbit","wolf","fox"],10:["rabbit","fox","polar_bear"],
  11:["goat"],13:["sheep","wolf"],14:["sheep","pig"],15:["rabbit"],17:["mooshroom"],18:["rabbit"],
};
function spawnPassives(m,cx,cz,surfs,bms){
  try{
    const si=8*16+8,sy=surfs[si],bm=bms[si];
    if(sy<SEA)return;
    const pool=PASSIVES[bm];
    if(!pool)return;
    if(bm!==17&&colRnd(cx,cz,55)>0.30)return;
    const kind="minecraft:"+pool[(colRnd(cx,cz,61)*pool.length)|0];
    const n=2+((colRnd(cx,cz,67)*3)|0);
    for(let i=0;i<n;i++){
      const ox=4+((colRnd(cx+i,cz,71)*8)|0),oz=4+((colRnd(cx,cz+i,73)*8)|0);
      const s2=surfs[ox*16+oz];
      if(s2>=SEA)try{m.spawnEntity(kind,{x:cx*16+ox,y:s2+2,z:cz*16+oz});}catch{}
    }
  }catch{}
}

// ── PLACE STRUCTURES (registry-driven generator) ───────────────
function* placeStructures(m,cx,cz,surfs,bms){
  if(Math.abs(cx)<=9&&Math.abs(cz)<=9){
    try{yield* placeStrongholdPiece(m,cx,cz);}catch{}
  }
  if(cx===0&&cz===0){
    try{const csy=surfYM(0,0);if(K.campfire)sb(m,0,csy+1,0,K.campfire);}catch{}
    yield;
  }

  const nearOrigin=Math.abs(cx)<=1&&Math.abs(cz)<=1;
  const wx=cx*16+8,wz=cz*16+8,si=8*16+8;
  const sy=surfs[si],bm=bms[si];

  if(!nearOrigin){
    let mainUsed=false;
    for(const st of STRUCTURES){
      if(st.group==="main"&&mainUsed)continue;
      const v=p2(cx*st.s+st.o,cz*st.s)*P2N;
      if(!st.test(v))continue;
      if(st.ok&&!st.ok(bm,sy))continue;
      if(st.group==="main")mainUsed=true;
      try{if(st.gen)yield* st.fn(m,wx,wz,sy);else st.fn(m,wx,wz,sy);}catch{}
      yield;
    }

    // SPREAD geode/fossil: independent per-chunk rare hash → isolated, any-Y.
    const fh=colRnd(cx,cz,401);
    if(fh<0.045){ // ≈1 in 22 chunks
      const fy=(WMIN+12)+((colRnd(cx,cz,403)*(Math.min(sy-12,WMAX-12)-(WMIN+12)))|0);
      try{fossilAt(m,wx,wz,fy);}catch{}
      yield;
    }
    const gh=colRnd(cx,cz,409);
    if(gh<0.028){ // ≈1 in 36 chunks
      const gy=(WMIN+14)+((colRnd(cx,cz,411)*(Math.min(sy-14,WMAX-14)-(WMIN+14)))|0);
      try{yield* geodeGen(m,wx,wz,gy);}catch{}
      yield;
    }
    yield;
  }

  spawnPassives(m,cx,cz,surfs,bms);
  yield;
  yield* placeVillage(m,cx,cz);
}

// ── JOB SYSTEM ────────────────────────────────────────────────
const done=new Set(),pend=new Set(),que=[];
let run=false;
const ck=(cx,cz)=>`${cx},${cz}`;

let seeded=false;
function isDone(key){
  if(done.has(key)){seeded=true;return true;}
  try{if(w.getDynamicProperty("wgD_"+key)){done.add(key);seeded=true;return true;}}catch{}
  return false;
}
function markDone(key){
  done.add(key);seeded=true;
  try{w.setDynamicProperty("wgD_"+key,true);}catch{}
}
function hasDoneNeighbor(cx,cz){
  return isDone(ck(cx+1,cz))||isDone(ck(cx-1,cz))||isDone(ck(cx,cz+1))||isDone(ck(cx,cz-1));
}

function* genJob(cx,cz){
  if(!resolveBlocks()||!K)return;
  initNoise();
  const m=dim();
  updateBounds(m);
  const x0=cx*16,z0=cz*16;

  const surfs=new Int16Array(256),bms=new Uint8Array(256),tys=new Int16Array(256);
  let minS=32767,maxS=-32768,allOcean=true;
  for(let wx=x0;wx<x0+16;wx++){
    for(let wz=z0;wz<z0+16;wz++){
      const si=(wx-x0)*16+(wz-z0);
      const sy=surfYM(wx,wz);
      const bm=biome(wx,wz,sy);
      surfs[si]=sy;bms[si]=bm;
      if(sy<minS)minS=sy;if(sy>maxS)maxS=sy;
      if(sy>=SEA||bm===1||bm===2)allOcean=false;
    }
    if((wx&3)===3)yield;
  }
  yield;

  const pre=yield* prefillChunk(m,x0,z0,maxS,allOcean);

  let i=0;
  for(let wx=x0;wx<x0+16;wx++)for(let wz=z0;wz<z0+16;wz++){
    const si=(wx-x0)*16+(wz-z0);
    try{tys[si]=fillCol(m,wx,wz,surfs[si],bms[si],pre);}
    catch{tys[si]=surfs[si];_chunkFails++;}
    if((++i)%YIELD_EVERY===0)yield;
  }
  yield;

  try{yield* placeVeins(m,cx,cz,surfs,bms);}catch{}
  try{yield* placeFeat(m,cx,cz,surfs,bms,tys);}catch{}
  try{yield* placeStructures(m,cx,cz,surfs,bms);}catch{}
}

// ── SCHEDULER (time-budgeted, every tick) ─────────────────────
let _currentJob=null,_jobCx=0,_jobCz=0,_jobFail0=0;
function chunkLoaded(m,cx,cz){
  try{
    const py=Math.max(WMIN,Math.min(0,WMAX));
    return !!m.getBlock({x:cx*16+8,y:py,z:cz*16+8});
  }catch{return false;}
}
function requeueHead(){
  const head=que.shift();
  if(!head)return;
  head.tries=(head.tries||0)+1;
  const key=ck(head.cx,head.cz);
  if(head.tries>=3){done.add(key);pend.delete(key);}
  else{head.wait=(s.currentTick||0)+RETRY_DELAY_TICKS;que.push(head);}
}
function nearPlayer(cx,cz,r){
  try{
    for(const p of w.getPlayers()){
      const pl=p.location;
      if(Math.abs(Math.floor(pl.x/16)-cx)<=r&&Math.abs(Math.floor(pl.z/16)-cz)<=r)return true;
    }
  }catch{}
  return false;
}
function kick(){
  if(run)return;
  run=true;
  const ticker=s.runInterval(()=>{try{
    const t0=NOW?NOW():0;
    const stepCap=NOW?MAX_STEPS_PER_TICK:8;
    let steps=0;
    while(steps<stepCap&&(!NOW||NOW()-t0<BUDGET_MS)){
      if(!_currentJob){
        const now=s.currentTick||0;
        let probes=0,ready=false;
        while(que.length&&probes<8){
          const head=que[0],key=ck(head.cx,head.cz);
          if(isDone(key)){que.shift();pend.delete(key);continue;}
          if(head.wait&&head.wait>now){que.push(que.shift());probes++;continue;}
          if(seeded&&!hasDoneNeighbor(head.cx,head.cz)){
            head.adjW=(head.adjW||0)+1;
            if(head.adjW<10){head.wait=now+RETRY_DELAY_TICKS;que.push(que.shift());probes++;continue;}
          }
          if(!chunkLoaded(dim(),head.cx,head.cz)){
            head.wait=now+RETRY_DELAY_TICKS;
            que.push(que.shift());probes++;continue;
          }
          ready=true;break;
        }
        if(!que.length){run=false;s.clearRun(ticker);return;}
        if(!ready)return;
        const{cx,cz}=que[0];
        _currentJob=genJob(cx,cz);_jobCx=cx;_jobCz=cz;_jobFail0=_chunkFails;
      }
      let r;
      try{r=_currentJob.next();}catch{r={done:true};}
      steps++;
      if(_chunkFails-_jobFail0>FAIL_ABORT){
        try{if(!r.done&&_currentJob.return)_currentJob.return();}catch{}
        _currentJob=null;
        requeueHead();
        continue;
      }
      if(r.done){
        const fcx=_jobCx,fcz=_jobCz;
        const key=ck(fcx,fcz);
        markDone(key);pend.delete(key);que.shift();
        _currentJob=null;
        if(done.size>DONE_CACHE_MAX)done.clear();
        for(let dx=-RADIUS;dx<=RADIUS;dx++)for(let dz=-RADIUS;dz<=RADIUS;dz++){
          const ncx=fcx+dx,ncz=fcz+dz,nk=ck(ncx,ncz);
          if(!isDone(nk)&&!pend.has(nk)&&nearPlayer(ncx,ncz,RADIUS+1)){
            pend.add(nk);que.push({cx:ncx,cz:ncz});
          }
        }
      }
    }
  }catch{}},SCHED_INTERVAL);
}

// Player movement queues new chunks
s.runInterval(()=>{
  try{
    for(const p of w.getPlayers()){
      const{x,z}=p.location;
      const pcx=Math.floor(x/16),pcz=Math.floor(z/16);
      for(let dx=-RADIUS;dx<=RADIUS;dx++)for(let dz=-RADIUS;dz<=RADIUS;dz++){
        const key=ck(pcx+dx,pcz+dz);
        if(!isDone(key)&&!pend.has(key)){pend.add(key);que.push({cx:pcx+dx,cz:pcz+dz});}
      }
    }
    if(que.length&&!run)kick();
  }catch{}
},20);

// ── PERIODIC PASSIVE-MOB RESPAWNS ──────────────────────────────
// TWEAK: passive mobs keep appearing in their biomes on long, jittered
// intervals (≈60–180 s per player) — herds of 2–4 of the local biome's pool,
// spawned a short distance from the player. Long intervals + small herds keep
// this cheap for low-end devices; vanilla mob caps prevent overpopulation.
const _nextMobTick=new Map(); // player.id → tick when next herd may spawn
function jitterTicks(){return 1200+((Math.random()*2400)|0);} // 60s..180s
s.runInterval(()=>{
  try{
    if(!K)return;
    const now=s.currentTick||0;
    const m=dim();
    for(const p of w.getPlayers()){
      let due=_nextMobTick.get(p.id);
      if(due===undefined){_nextMobTick.set(p.id,now+jitterTicks());continue;}
      if(now<due)continue;
      _nextMobTick.set(p.id,now+jitterTicks());
      const loc=p.location;
      const wx=Math.floor(loc.x),wz=Math.floor(loc.z);
      const sy=surfYM(wx,wz),bm=biome(wx,wz,sy);
      if(sy<SEA)continue;
      const pool=PASSIVES[bm];
      if(!pool)continue;
      const kind="minecraft:"+pool[(Math.random()*pool.length)|0];
      const n=2+((Math.random()*3)|0);
      for(let i=0;i<n;i++){
        // spawn 16–36 blocks away in a random direction (out of immediate sight)
        const a=Math.random()*6.2832,dist=16+((Math.random()*20)|0);
        const sx=wx+Math.round(Math.cos(a)*dist),sz=wz+Math.round(Math.sin(a)*dist);
        const ssy=surfYM(sx,sz);
        if(ssy<SEA)continue;
        try{m.spawnEntity(kind,{x:sx,y:ssy+2,z:sz});}catch{}
      }
    }
  }catch{}
},200); // checked every 10 s; actual spawns gated by the long jittered timer

// ════════════════════════ BIOME AMBIENCE DRIVER ════════════════════════
// Pushes fog per-player based on the SCRIPT biome at their position.
// Requires the "WorldGen Ambience" resource pack (wg:* fog defs).
const FOG_BY_BIOME={
  15:"wg:pale_garden",
  10:"wg:snowy", 16:"wg:snowy",
   8:"wg:swamp",
   1:"wg:desert",
  18:"wg:mesa",
   6:"wg:jungle",
  17:"wg:mooshroom",
};
const _fogState=new Map();
s.runInterval(()=>{
  try{
    for(const p of w.getPlayers()){
      const loc=p.location;
      const wx=Math.floor(loc.x),wz=Math.floor(loc.z);
      let id=null;
      try{id=FOG_BY_BIOME[biome(wx,wz,surfYM(wx,wz))]||null;}catch{}
      if(id===_fogState.get(p.id))continue;
      try{p.runCommandAsync("fog @s remove wgbiome");}catch{}
      if(id){try{p.runCommandAsync(`fog @s push ${id} wgbiome`);}catch{}}
      _fogState.set(p.id,id);
    }
  }catch{}
},40);
