//This is vide coded and not ment to make profit or gain in any way
//Probably requires 1.21+, Definately reauires Beta Apis in Expirements, although test it if uou so desire
//This is not acheivement friendly nor can I think of a way to make it so
//Please feel free to make any edits and changes on your own end and publish them without credit or anything, Just do not monotize it.
//This is only the main.js file that then goes in a scripts folder which then combined with a manifest.json and a dimensions folder makes the comolete addon that works

import * as mc from "@minecraft/server";
const w = mc.world, s = mc.system, B = mc.BlockPermutation;
const BV = mc.BlockVolume || null;   // bulk fill (optional, auto-fallback)
const IS = mc.ItemStack    || null;  // chest loot (optional, auto-fallback)

// ── CONFIG ─────────────────────────────────────────────────────
const BY=-512, DS_TOP=-256, SEA=62, BASE=64;
const RADIUS=2;            // chunks generated around each player
const YIELD_EVERY=1;       // columns per generator step (1 = finest, safest)
const BUDGET_MS=8;         // ms of gen work per tick (higher = faster gen, lower FPS)
const MAX_STEPS_PER_TICK=256;// backstop on generator steps/tick; BUDGET_MS is the real limit
const RETRY_DELAY_TICKS=20;// re-probe delay for unloaded chunks
const FAIL_ABORT=2048;     // abort+requeue a job if this many writes fail
const SCHED_INTERVAL=1;    // ticks between scheduler runs
const DONE_CACHE_MAX=20000;// generated-chunk cache cap
const NOW=(typeof Date!=="undefined"&&typeof Date.now==="function")?Date.now:null;
// ── CAVE CONTENT ──────────────────────────────────────────────
const CAVE_WATER_T=0.50;  // LOWERED (was 0.62) → water caves more common
const LAVA_LAKE_T=0.88;
const LAVA_LAKE_TOP=-200;
const DEEPDARK_TOP=-300;   // sculk / deep-dark caves generate at this Y and below
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
    const targetsSet=new Set(targets);
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
        if(!anyTarget&&targetsSet.has(b))anyTarget={x:wx,y:sy+2,z:wz};
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
  kick();   // player-driven loader: generates the player's own chunk first, then grows outward
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
// _F: correct Math.floor for negative numbers without the global property lookup
const _F=x=>{const n=x|0;return n>x?n-1:n;};
// g2 lookup tables replace switch-case: 2 array reads + 2 multiplications
const _G2X=[1,-1,1,-1,1,-1,0,0],_G2Z=[1,1,-1,-1,0,0,1,-1];
const g2=(h,x,z)=>{const i=h&7;return _G2X[i]*x+_G2Z[i]*z;};
const g3=(h,x,y,z)=>{const u=h<8?x:y,v=h<4?y:(h===12||h===14?x:z);return((h&1)?-u:u)+((h&2)?-v:v);};
function p2(x,z){
  const fx=_F(x),fz=_F(z);
  const X=fx&255,Z=fz&255;x-=fx;z-=fz;
  const u=fade(x),v=fade(z),a=perm[X]+Z,b=perm[X+1]+Z;
  return lerp(lerp(g2(perm[a],x,z),g2(perm[b],x-1,z),u),lerp(g2(perm[a+1],x,z-1),g2(perm[b+1],x-1,z-1),u),v);
}
function p3(x,y,z){
  const fx=_F(x),fy=_F(y),fz=_F(z);
  const X=fx&255,Y=fy&255,Z=fz&255;
  x-=fx;y-=fy;z-=fz;
  const u=fade(x),v=fade(y),wf=fade(z);
  const A=perm[X]+Y,AA=perm[A]+Z,AB=perm[A+1]+Z,Bv=perm[X+1]+Y,BA=perm[Bv]+Z,BB=perm[Bv+1]+Z;
  return lerp(lerp(lerp(g3(perm[AA],x,y,z),g3(perm[BA],x-1,y,z),u),lerp(g3(perm[AB],x,y-1,z),g3(perm[BB],x-1,y-1,z),u),v),
              lerp(lerp(g3(perm[AA+1],x,y,z-1),g3(perm[BA+1],x-1,y,z-1),u),lerp(g3(perm[AB+1],x,y-1,z-1),g3(perm[BB+1],x-1,y-1,z-1),u),v),wf);
}
function fbm2(x,z,oct,lac,gain){
  let v=0,a=1,f=1,mx=0;
  for(let i=0;i<oct;i++){v+=p2(x*f,z*f)*a;mx+=a;a*=gain;f*=lac;}
  return v*(1/mx);
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
      // Leaves: update_bit=true → game revalidates distance-to-log each tick,
      // so script-placed leaves behave exactly like vanilla-placed ones:
      // they stay while connected to logs and decay when logs are removed.
      oak_log:B.resolve("minecraft:oak_log"),
      oak_leaf:(()=>{try{return B.resolve("minecraft:oak_leaves").withState("update_bit",true).withState("persistent_bit",false);}catch{return B.resolve("minecraft:oak_leaves");}})(),
      birch_log:B.resolve("minecraft:birch_log"),
      birch_leaf:(()=>{try{return B.resolve("minecraft:birch_leaves").withState("update_bit",true).withState("persistent_bit",false);}catch{return B.resolve("minecraft:birch_leaves");}})(),
      spruce_log:B.resolve("minecraft:spruce_log"),
      spruce_leaf:(()=>{try{return B.resolve("minecraft:spruce_leaves").withState("update_bit",true).withState("persistent_bit",false);}catch{return B.resolve("minecraft:spruce_leaves");}})(),
      jungle_log:B.resolve("minecraft:jungle_log"),
      jungle_leaf:(()=>{try{return B.resolve("minecraft:jungle_leaves").withState("update_bit",true).withState("persistent_bit",false);}catch{return B.resolve("minecraft:jungle_leaves");}})(),
      acacia_log:B.resolve("minecraft:acacia_log"),
      acacia_leaf:(()=>{try{return B.resolve("minecraft:acacia_leaves").withState("update_bit",true).withState("persistent_bit",false);}catch{return B.resolve("minecraft:acacia_leaves");}})(),
      dark_oak_log:B.resolve("minecraft:dark_oak_log"),
      dark_oak_leaf:(()=>{try{return B.resolve("minecraft:dark_oak_leaves").withState("update_bit",true).withState("persistent_bit",false);}catch{return B.resolve("minecraft:dark_oak_leaves");}})(),
      mg_log:B.resolve("minecraft:mangrove_log"),
      mg_leaf:(()=>{try{return B.resolve("minecraft:mangrove_leaves").withState("update_bit",true).withState("persistent_bit",false);}catch{return B.resolve("minecraft:mangrove_leaves");}})(),
      mg_roots:B.resolve("minecraft:mangrove_roots"),
      cherry_log:tryR("minecraft:cherry_log"),
      cherry_leaf:(()=>{try{return tryR("minecraft:cherry_leaves")&&B.resolve("minecraft:cherry_leaves").withState("update_bit",true).withState("persistent_bit",false);}catch{return tryR("minecraft:cherry_leaves");}})(),
      pale_oak_log:tryR("minecraft:pale_oak_log"),
      pale_oak_leaf:(()=>{try{return tryR("minecraft:pale_oak_leaves")&&B.resolve("minecraft:pale_oak_leaves").withState("update_bit",true).withState("persistent_bit",false);}catch{return tryR("minecraft:pale_oak_leaves");}})(),
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
      coral_red:mkC("red"),coral_yellow:mkC("yellow"),
      // Standalone coral plants (not block form) — live colour variants
      coral_plant_blue: tryR("minecraft:brain_coral"),
      coral_plant_pink: tryR("minecraft:pink_coral"),
      coral_plant_purple:tryR("minecraft:purple_coral"),
      coral_plant_red:  tryR("minecraft:fire_coral"),
      coral_plant_yellow:tryR("minecraft:horn_coral"),
      // Coral fans — upward-facing (floor)
      coral_fan_blue:   tryR("minecraft:coral_fan")&&(()=>{try{return B.resolve("minecraft:coral_fan").withState("coral_color","blue").withState("coral_fan_direction",0);}catch{return tryR("minecraft:coral_fan");}})(),
      coral_fan_pink:   (()=>{try{return B.resolve("minecraft:coral_fan").withState("coral_color","pink").withState("coral_fan_direction",0);}catch{return tryR("minecraft:coral_fan");}})(),
      coral_fan_purple: (()=>{try{return B.resolve("minecraft:coral_fan").withState("coral_color","purple").withState("coral_fan_direction",0);}catch{return tryR("minecraft:coral_fan");}})(),
      coral_fan_red:    (()=>{try{return B.resolve("minecraft:coral_fan").withState("coral_color","red").withState("coral_fan_direction",0);}catch{return tryR("minecraft:coral_fan");}})(),
      coral_fan_yellow: (()=>{try{return B.resolve("minecraft:coral_fan").withState("coral_color","yellow").withState("coral_fan_direction",0);}catch{return tryR("minecraft:coral_fan");}})(),
      // Dead coral fan (floor) — for dead patches
      dead_coral_fan:   (()=>{try{return B.resolve("minecraft:coral_fan_dead").withState("coral_fan_direction",0);}catch{return null;}})(),
      sea_pickle:       tryR("minecraft:sea_pickle"),
      s_basalt:tryR("minecraft:smooth_basalt"),amethyst:tryR("minecraft:amethyst_block"),
      bud_amethyst:tryR("minecraft:budding_amethyst"),
      am_cluster:tryR("minecraft:amethyst_cluster"),
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
      vine:tryR("minecraft:vine"),bee_nest:tryR("minecraft:bee_nest"),
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
      // Lush-cave set
      moss_carpet:tryR("minecraft:moss_carpet"),
      azalea:tryR("minecraft:azalea"),
      flow_azalea:tryR("minecraft:flowering_azalea"),
      big_drip:tryR("minecraft:big_dripleaf"),
      big_drip_stem:tryR("minecraft:big_dripleaf_stem"),
      small_drip:tryR("minecraft:small_dripleaf"),
      spore:tryR("minecraft:spore_blossom"),
      glow_lichen:tryR("minecraft:glow_lichen"),
      cave_vine:tryR("minecraft:cave_vines"),
      cave_vine_berry:tryR("minecraft:cave_vines_body_with_berries")||tryR("minecraft:cave_vines"),
      hanging_roots:tryR("minecraft:hanging_roots"),
      rooted_dirt:tryR("minecraft:rooted_dirt"),
      // Deep-dark / sculk set (naturally-generated shriekers can summon the warden)
      sculk:tryR("minecraft:sculk"),
      sculk_vein:tryR("minecraft:sculk_vein"),
      sculk_sensor:tryR("minecraft:sculk_sensor"),
      sculk_catalyst:tryR("minecraft:sculk_catalyst"),
      sculk_shrieker:(()=>{try{return B.resolve("minecraft:sculk_shrieker").withState("can_summon",true);}catch{return tryR("minecraft:sculk_shrieker");}})(),
      // Extra flowers (short + tall) for per-biome flower sets
      red_tulip:tryR("minecraft:red_tulip"),orange_tulip:tryR("minecraft:orange_tulip"),
      white_tulip:tryR("minecraft:white_tulip"),pink_tulip:tryR("minecraft:pink_tulip"),
      rose_bush:tryR("minecraft:rose_bush"),peony:tryR("minecraft:peony"),
      lilac:tryR("minecraft:lilac"),sunflower:tryR("minecraft:sunflower"),
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
// Place a 2-tall plant (tall flowers, small dripleaf) using upper_block_bit.
function placeTall(m,x,y,z,base){
  if(!base)return;
  try{
    sb(m,x,y,z,base.withState("upper_block_bit",false));
    sb(m,x,y+1,z,base.withState("upper_block_bit",true));
  }catch{sb(m,x,y,z,base);}
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
    {id:"minecraft:music_disc_13",min:1,max:1,w:2},
    {id:"minecraft:enchanted_book",min:1,max:1,w:2},
    {id:"minecraft:emerald",min:1,max:4,w:3},
    {id:"minecraft:slime_ball",min:1,max:4,w:3},
    {id:"minecraft:lead",min:1,max:1,w:2},
    {id:"minecraft:cooked_beef",min:1,max:3,w:4},
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
    {id:"minecraft:music_disc_far",min:1,max:1,w:2},
    {id:"minecraft:spyglass",min:1,max:1,w:2},
    {id:"minecraft:lapis_lazuli",min:2,max:6,w:4},
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
    {id:"minecraft:enchanted_book",min:1,max:1,w:3},
    {id:"minecraft:golden_carrot",min:1,max:3,w:3},
    {id:"minecraft:redstone",min:4,max:9,w:5},
    {id:"minecraft:gold_block",min:1,max:1,w:2},
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
    {id:"minecraft:horse_armor_gold",min:1,max:1,w:2},
    {id:"minecraft:horse_armor_iron",min:1,max:1,w:2},
    {id:"minecraft:saddle",min:1,max:1,w:2},
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

function lootFill(c,table,x,y,z,guaranteed){
  const t=LOOT[table]||LOOT.default;
  let h=((Math.imul(x|0,374761393)^Math.imul(y|0,668265263)^Math.imul(z|0,1274126177))>>>0)||1;
  const rnd=()=>{h=(Math.imul(h,1664525)+1013904223)>>>0;return h/4294967296;};
  const rolls=t.rolls[0]+((rnd()*(t.rolls[1]-t.rolls[0]+1))|0);
  // Per-chest mutable weights: each time an entry is picked its weight decays,
  // so repeated identical drops are far less likely → more varied chests.
  const wts=t.pool.map(p=>p.w);
  let total=t.total;
  // Distinct, shuffled slots so rolls never overwrite each other.
  const slots=[];for(let i=0;i<c.size;i++)slots.push(i);
  for(let i=slots.length-1;i>0;i--){const j=(rnd()*(i+1))|0;const tmp=slots[i];slots[i]=slots[j];slots[j]=tmp;}
  let sp=0;
  for(let i=0;i<rolls;i++){
    if(total<=0.0001){total=0;for(let k=0;k<wts.length;k++)total+=wts[k];if(total<=0)break;}
    let r=rnd()*total,ei=0;
    for(let k=0;k<t.pool.length;k++){r-=wts[k];if(r<=0){ei=k;break;}}
    const e=t.pool[ei];
    const n=e.min+((rnd()*(e.max-e.min+1))|0);
    total-=wts[ei]*0.6;wts[ei]*=0.4;          // decay this entry's weight
    const slot=slots[sp++%slots.length];
    try{c.setItem(slot,new IS(e.id,Math.max(1,n)));}catch{}
  }
  // Guaranteed items: dropped into the first empty slot so they always make it in.
  if(guaranteed)for(const g of guaranteed){
    try{
      let slot=-1;
      for(let s2=0;s2<c.size;s2++){if(!c.getItem(s2)){slot=s2;break;}}
      if(slot<0)slot=slots[(rnd()*slots.length)|0];
      c.setItem(slot,new IS(g.id,Math.max(1,g.count||1)));
    }catch{}
  }
}
// The only sanctioned way to place a chest. Places block, fills container,
// retries once next tick if the block entity lags. `guaranteed` (optional) is
// an array of {id,count} that is always inserted (e.g. shipwreck heart-of-the-sea).
function placeChest(m,x,y,z,table,guaranteed){
  sb(m,x,y,z,K.chest);
  if(!IS)return;
  const fill=()=>{
    try{
      const b=m.getBlock({x,y,z});
      if(!b||!b.typeId.includes("chest"))return false;
      const inv=b.getComponent("minecraft:inventory");
      const c=inv&&inv.container;
      if(!c)return false;
      lootFill(c,table,x,y,z,guaranteed);
      return true;
    }catch{return false;}
  };
  if(!fill())try{s.run(fill);}catch{}
}

// ── OPTION-1 PERSISTENT SPAWNER REGISTRY ───────────────────────
// Script-placed mob_spawner blocks can't be configured via API, so we maintain
// a registry of {x,y,z,mob} entries and periodically spawn mobs ourselves —
// but ONLY while the spawner block is still present at that location.  If a
// player mines the spawner the registry entry is removed and spawning stops.
//
// Persistence: the registry is serialised to a single dynamic property
// (JSON string) so it survives world reloads. We cap entries at 512 to keep
// the property under Bedrock's ~32 KB limit per property.
const SPAWNER_REG_KEY="wgSpawners";
const MAX_SPAWNER_ENTRIES=512;
const SPAWNER_CAP=6;         // max living mobs per spawner
const SPAWNER_RADIUS=16;     // only active when a player is within this many blocks
const SPAWNER_INTERVAL=100;  // ticks between registry sweeps (5 s)
const SPAWNER_CHANCE=0.40;   // probability to attempt a spawn per active entry per sweep

// In-memory map: key "x,y,z" → mob string (no "minecraft:" prefix)
const _spawnerReg=new Map();
let _spawnerDirty=false;

function _spawnerKey(x,y,z){return x+","+y+","+z;}

function _loadSpawnerReg(){
  try{
    const raw=w.getDynamicProperty(SPAWNER_REG_KEY);
    if(typeof raw==="string"&&raw.length>2){
      const arr=JSON.parse(raw);
      for(const e of arr)_spawnerReg.set(_spawnerKey(e.x,e.y,e.z),{x:e.x,y:e.y,z:e.z,mob:e.mob});
    }
  }catch{}
}
function _saveSpawnerReg(){
  if(!_spawnerDirty)return;
  _spawnerDirty=false;
  try{
    const arr=[];
    for(const e of _spawnerReg.values()){
      arr.push({x:e.x,y:e.y,z:e.z,mob:e.mob});
      if(arr.length>=MAX_SPAWNER_ENTRIES)break;
    }
    w.setDynamicProperty(SPAWNER_REG_KEY,JSON.stringify(arr));
  }catch{}
}

// Called at startup — defer one tick so the dimension is ready.
s.runTimeout(()=>{try{_loadSpawnerReg();}catch{}},2);

// Register a spawner. Also places the block and seeds the initial mobs (as
// before), but now the registry keeps them coming back long-term.
const _spOff=[[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[2,0,0],[0,0,2],[0,1,0]];
function dungeonMob(x,z){
  const r=colRnd(x,z,313);
  return r<0.40?"zombie":r<0.72?"skeleton":r<0.90?"spider":"cave_spider";
}
function placeSpawner(m,x,y,z,mob){
  sb(m,x,y,z,K.spawner);
  if(!mob)return;
  // Register for recurring spawns
  const key=_spawnerKey(x,y,z);
  if(!_spawnerReg.has(key)){
    if(_spawnerReg.size<MAX_SPAWNER_ENTRIES){
      _spawnerReg.set(key,{x,y,z,mob});
      _spawnerDirty=true;
    }
  }
  // Seed the room with a small initial group
  let placed=0;
  for(const o of _spOff){
    if(placed>=3)break;
    try{m.spawnEntity("minecraft:"+mob,{x:x+o[0]+0.5,y:y+o[1],z:z+o[2]+0.5});placed++;}catch{}
  }
}

// Periodic sweep: for each registered spawner check block still exists,
// player is nearby, mob count is below cap, then maybe spawn one more.
s.runInterval(()=>{
  if(!K||_spawnerReg.size===0)return;
  try{
    const m=dim();
    const players=w.getPlayers();
    const toRemove=[];
    for(const[key,entry] of _spawnerReg){
      const{x,y,z,mob}=entry;
      // Verify the spawner block still exists — if not, unregister.
      try{
        const b=m.getBlock({x,y,z});
        if(!b||!b.typeId.includes("mob_spawner")){toRemove.push(key);continue;}
      }catch{continue;}
      // Check player proximity
      let nearP=false;
      for(const p of players){
        const pl=p.location;
        if(Math.abs(pl.x-x)<=SPAWNER_RADIUS&&Math.abs(pl.y-y)<=SPAWNER_RADIUS*2&&Math.abs(pl.z-z)<=SPAWNER_RADIUS){nearP=true;break;}
      }
      if(!nearP)continue;
      if(Math.random()>SPAWNER_CHANCE)continue;
      // Count nearby mobs of this type
      let count=0;
      try{
        const nearby=m.getEntities({type:"minecraft:"+mob,location:{x,y,z},maxDistance:SPAWNER_RADIUS});
        count=nearby.length;
      }catch{}
      if(count>=SPAWNER_CAP)continue;
      // Spawn one in a random adjacent air position
      const off=_spOff[(Math.random()*_spOff.length)|0];
      try{m.spawnEntity("minecraft:"+mob,{x:x+off[0]+0.5,y:y+off[1],z:z+off[2]+0.5});}catch{}
    }
    for(const k of toRemove){_spawnerReg.delete(k);_spawnerDirty=true;}
    _saveSpawnerReg();
  }catch{}
},SPAWNER_INTERVAL);

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
  if(sy>178)return 11;
  if(Math.max(Math.abs(wx),Math.abs(wz))>1500&&Math.abs(p2(wx*1.5e-4+8888,wz*1.5e-4))<0.015)return 17;
  const t=fbm2(wx*8e-4+500,wz*8e-4,3,2.0,0.5);
  const h=fbm2(wx*9e-4,    wz*9e-4+500,3,2.0,0.5);
  // Temperature thresholds recalibrated to the noise's true distribution so the
  // hot (desert/savanna/mesa) and cold (taiga/snowy/ice-spikes) biomes all
  // generate at sensible frequencies instead of sitting in unreachable tails.
  if(t<-0.37)return 16;                          // ice spikes
  if(t<-0.27)return 10;                          // snowy
  if(t<-0.16)return 9;                           // taiga
  if(t>=-0.16&&t<-0.04&&h<0.04)return 15;        // pale garden
  if(t>0.26&&h<0.00)return 1;                    // desert (hot & dry)
  if(t>0.27&&h>0.15&&sy>SEA+8)return 18;         // mesa (hot, raised)
  if(t>0.15&&h<0.12)return 2;                    // savanna (warm & dryish)
  if(t>0.16&&h>0.40&&sy<=SEA+6)return 7;         // mangrove (hot wet lowland)
  if(t>0.18&&h>0.30)return 6;                    // jungle (hot & wet)
  if(h>0.34&&sy<=SEA+8)return 8;                 // swamp
  if(h>0.44&&t>0.04&&t<0.30)return 13;           // dark oak
  if(t>0.08&&h>0.10&&h<0.34&&t<0.34)return 14;   // cherry
  if(h>0.24&&t<0.08)return 5;                    // birch
  if(h>0.10)return 4;                            // forest
  return 3;                                      // plains
}

// ── TERRAIN HEIGHT ─────────────────────────────────────────────
function surfY(wx,wz){
  const c=fbm2(wx*1.2e-3,       wz*1.2e-3,       5,2.0,0.50)*120;
  const h=fbm2(wx*7.0e-3+1000,  wz*7.0e-3,       4,2.1,0.45)*35;
  const rr=(1-Math.abs(fbm2(wx*1.8e-2+2000,wz*1.8e-2,3,2.2,0.40)))*20-10;
  const d=fbm2(wx*5.0e-2+3000,  wz*5.0e-2,       2,2.3,0.35)*5;
  let sy=Math.round(BASE+c+h+rr+d);
  const mt=fbm2(wx*5.5e-4+15000,wz*5.5e-4,3,2.0,0.5)*P2N;
  if(mt>0.20){
    const ridge=1-Math.abs(p2(wx*2.2e-3+16000,wz*2.2e-3));
    const f=Math.min(1,(mt-0.20)/0.26);
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
const _SYC_OFF=33554432;          // 2^25 — keeps the packed key positive and exactly representable
function surfYM(wx,wz){
  // Pack the column coord into a single exact integer key (valid across the full
  // ±30M Bedrock world border); fall back to a string key only past 2^25.
  const k=(wx>=-_SYC_OFF&&wx<_SYC_OFF&&wz>=-_SYC_OFF&&wz<_SYC_OFF)
    ?(wx+_SYC_OFF)*67108864+(wz+_SYC_OFF)
    :wx+","+wz;
  let v=_syc.get(k);
  if(v===undefined){
    v=surfY(wx,wz);
    if(_syc.size>=25000){let n=0;for(const ek of _syc.keys()){_syc.delete(ek);if(++n>=5000)break;}}
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

// ── BULK PREFILL (per chunk: bedrock floor + deepslate band + deep-ocean water) ──
function* prefillChunk(m,x0,z0,maxS,allOcean){
  const r={bed:false,water:false,waterTop:maxS,dsOK:false};
  if(!BV||typeof m.fillBlocks!=="function")return r;
  const yFloor=Math.max(BY,WMIN);
  r.bed=bulkFill(m,x0,yFloor,z0,x0+15,yFloor,z0+15,K.bedrock);
  yield;
  // Deepslate band (dsLo..DS_TOP) is the same height across the whole chunk, so
  // fill it once chunk-wide instead of once per column (was 256 fills/chunk in
  // deep worlds). Caves/variants still override per-block in fillCol.
  const dsLo=Math.max(BY+1,WMIN+1);
  if(dsLo<=DS_TOP){
    r.dsOK=true;
    for(let y=dsLo;y<=DS_TOP;y+=FILL_MAX_H){
      if(!bulkFill(m,x0,y,z0,x0+15,Math.min(y+FILL_MAX_H-1,DS_TOP),z0+15,K.deepslate))r.dsOK=false;
      yield;
    }
  }else r.dsOK=true;   // no deepslate band in shallow worlds → nothing to fill
  if(allOcean&&maxS<SEA){
    r.water=true;
    for(let y=maxS+1;y<=SEA;y+=FILL_MAX_H){
      if(!bulkFill(m,x0,y,z0,x0+15,Math.min(y+FILL_MAX_H-1,SEA),z0+15,K.water))r.water=false;
      yield;
    }
  }
  return r;
}

// ── FAST COLUMN NOISE HELPERS (fillCol hot path) ───────────────────────────
// _cp / _sp are module-level singletons; _cavePrep() writes column-constant
// noise inputs once per column so caveAtF() / stoneBlkF() read properties
// instead of recomputing multiplications on every y iteration.
const _cp={rx:0,rz:0,c1x:0,c1z:0,c2x:0,c2z:0,s1x:0,s1z:0,s2x:0,s2z:0,t1x:0,t1z:0,t2x:0,t2z:0,dx:0,dz:0};
const _sp={nax:0,naz:0,nbx:0,nbz:0,cbx:0,cbz:0,grpx:0,grpz:0,colx:0,colz:0,lux:0,drpx:0,drpz:0};
function _cavePrep(wx,wz){
  _cp.rx=wx*0.0025+40000;_cp.rz=wz*0.0025;
  _cp.c1x=wx*0.012;_cp.c1z=wz*0.012+45000;
  _cp.c2x=wx*0.02+47000;_cp.c2z=wz*0.02;
  _cp.s1x=wx*0.035;_cp.s1z=wz*0.035;
  _cp.s2x=wx*0.035+50;_cp.s2z=wz*0.035+50;
  _cp.t1x=wx*0.025;_cp.t1z=wz*0.025;
  _cp.t2x=wx*0.025+30;_cp.t2z=wz*0.025+30;
  _cp.dx=wx*0.018;_cp.dz=wz*0.018;
  _sp.nax=wx*0.04;_sp.naz=wz*0.04;
  _sp.nbx=wx*0.04+400;_sp.nbz=wz*0.04+400;
  _sp.cbx=wx*0.006+25000;_sp.cbz=wz*0.006;
  _sp.grpx=wx*0.03+31000;_sp.grpz=wz*0.03;
  _sp.colx=wx*0.05+6000;_sp.colz=wz*0.05;
  _sp.lux=wx*0.05+7000;
  _sp.drpx=wx*0.04+5000;_sp.drpz=wz*0.04;
}
function caveAtF(y){
  if(y<=WMIN+2)return false;
  const reg=p3(_cp.rx,y*0.0025,_cp.rz);
  if(reg>0.10+y*0.0004){
    if(p3(_cp.c1x,y*0.045,_cp.c1z)>0.34)return true;
    if(p3(_cp.c2x,y*0.02,_cp.c2z)>0.58)return true;
    return false;
  }
  const s7=y*0.0245;
  const n1=p3(_cp.s1x,s7,_cp.s1z),n2=p3(_cp.s2x,s7,_cp.s2z);
  if(n1*n1+n2*n2<0.016)return true;
  if(y<=60&&y>=-260){const s15=y*0.015;const sv1=p3(_cp.t1x,s15,_cp.t1z),sv2=p3(_cp.t2x,s15+30,_cp.t2z);if(sv1*sv1+sv2*sv2<0.013)return true;}
  if(y<=-80&&p3(_cp.dx,y*0.018,_cp.dz)>0.62)return true;
  return false;
}
function stoneBlkF(wy,ds){
  const na=p3(_sp.nax,wy*0.04,_sp.naz),nb=p3(_sp.nbx,wy*0.04,_sp.nbz);
  if(ds){if(na>0.46&&wy>DS_TOP-60)return K.tuff;if(nb>0.54&&wy>DS_TOP-90)return K.calcite;if(na<-0.50)return K.dripstone;return K.deepslate;}
  if(wy<80&&na>0.44)return K.granite;if(wy<100&&nb>0.45)return K.diorite;
  if(na<-0.44)return K.andesite;if(wy<70&&na>0.52&&nb>0)return K.calcite;
  return K.stone;
}

// ── FILL COLUMN (one column at a time: foundation → detail; returns top Y) ─
// WATER CAVE LOGIC: regional zones (CAVE_WATER_T, now lowered → more common)
// fill carved cave air up to a flat local level. Additionally, ANY carved
// cave that opens beneath the seabed (sy<SEA) is flooded by the ocean pass so
// "caves that open into a water feature" become water caves automatically.
function fillCol(m,wx,wz,sy,bm,pre){
  const isLush=bm===4||bm===5||bm===6||bm===14;
  const isCold=bm===9||bm===10||bm===16;
  const isDrip=p3(wx*0.03+5500,0,wz*0.03)>0.50;   // MORE COMMON dripstone
  const stTop=sy-5;
  _cavePrep(wx,wz);

  const yFloor=Math.max(BY,WMIN);
  if(!pre.bed)sb(m,wx,yFloor,wz,K.bedrock);

  const stLo=Math.max(DS_TOP+1,WMIN+1);
  const stOK=sy>=stLo?bulkFill(m,wx,stLo,wz,wx,sy,wz,K.stone):false;
  const dsOK=pre.dsOK;   // deepslate band was pre-filled chunk-wide in prefillChunk

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
  // Submerged column (ocean / river / lake): caves opening just under the water
  // body flood, becoming water caves.
  const submerged=sy<SEA;
  const floodTop=submerged?sy:-1e9;
  // Deep dark: caves at DEEPDARK_TOP (-300) and below get sculk-coated in coherent
  // regional patches. Sensors / shriekers are added in the deferred decorate pass.
  const deepDark=!!K.sculk&&(p2(wx*0.004+33000,wz*0.004)*P2N>-0.05);

  let top=yFloor;
  let prevCave=false;

  for(let y=yFloor+1;y<=sy;y++){
    const ds=y<=DS_TOP;
    const prefilled=ds?dsOK:stOK;
    if(caveAtF(y)){
      if(lavaCol&&y<=LAVA_LAKE_TOP)sb(m,wx,y,wz,K.lava);
      else if(y<=wLvl||(submerged&&y>=floodTop-30&&y<floodTop))sb(m,wx,y,wz,K.water);
      else{
        if(prefilled)sb(m,wx,y,wz,K.air);
        if(!prevCave&&y-1>yFloor){
          // cb = cave-content field. Mushroom side (cb>0.45) → mushroom caves.
          // The old amethyst side (cb<-0.50) is now LUSH caves (moss floors,
          // carpet, dripleaf/azalea added in the deferred caveDecorate pass).
          // Floor blocks penetrate 1-2 extra blocks down into the wall.
          const cb=p3(_sp.cbx,y*0.006,_sp.cbz);
          const grp=p3(_sp.grpx,y*0.03,_sp.grpz);
          if(y<=DEEPDARK_TOP&&deepDark){                 // DEEP DARK / sculk floor
            sb(m,wx,y-1,wz,K.sculk);
            if(y-2>yFloor)sb(m,wx,y-2,wz,K.sculk);       // penetrate into floor
            if(grp>0.55&&K.sculk_vein)sb(m,wx,y,wz,K.sculk_vein);
          }else if(cb>0.45){                             // MUSHROOM CAVE floor
            sb(m,wx,y-1,wz,K.mycelium);
            if(y-2>yFloor)sb(m,wx,y-2,wz,K.mycelium);    // penetrate into floor
            if(grp>0.40&&K.brn_mush)sb(m,wx,y,wz,grp>0.72?K.red_mush:K.brn_mush);
          }else if(cb<-0.50){                            // LUSH CAVE floor
            const M=K.moss||K.mycelium;
            sb(m,wx,y-1,wz,M);
            if(y-2>yFloor)sb(m,wx,y-2,wz,K.rooted_dirt||M);  // penetrate into floor
            if(grp>0.30&&K.moss_carpet)sb(m,wx,y,wz,K.moss_carpet);
            else if(grp<-0.50&&K.t_grass)sb(m,wx,y,wz,K.t_grass);
          }
        }
      }
      prevCave=true;continue;
    }
    top=y;

    let blk;
    if(!ds&&y>stTop)blk=K.stone;
    else if(!ds&&isCold&&y<60&&p3(_sp.colx,y*0.05,_sp.colz)>0.73)blk=K.packed_ice;
    else if(!ds&&isLush&&y>-64&&y<40&&p3(_sp.lux,y*0.05,_sp.colz)>0.62)blk=K.moss||stoneBlkF(y,false);
    else if(!ds&&isDrip&&!isLush&&y<50&&p3(_sp.drpx,y*0.04,_sp.drpz)>0.56)blk=K.dripstone;
    else blk=stoneBlkF(y,ds);

    if(prevCave){
      const cb=p3(_sp.cbx,y*0.006,_sp.cbz);
      const grp=p3(_sp.grpx,y*0.03,_sp.grpz);
      if(y<=DEEPDARK_TOP&&deepDark){                   // deep-dark ceiling → sculk
        blk=K.sculk;
      }else if(cb<-0.50){                              // lush-cave ceiling → moss
        blk=K.moss||blk;
      }else if(cb>0.45&&grp>0.30){                     // mushroom-cave ceiling
        blk=K.brn_mush_blk;
      }
    }
    prevCave=false;

    const base=ds?K.deepslate:K.stone;
    if(blk!==base||!prefilled)sb(m,wx,y,wz,blk);
  }

  const ty=top;

  // Vertical water filler: bulk-fill tall runs (1 engine call) instead of
  // placing each block; fall back to per-block for short runs / no-BV.
  const fillWater=(y1,y2)=>{
    if(y2<y1)return;
    if(y2-y1>=3&&bulkFill(m,wx,y1,wz,wx,y2,wz,K.water))return;
    for(let y=y1;y<=y2;y++)sb(m,wx,y,wz,K.water);
  };

  // Ocean / river / lake — also floods cave shafts opening at the seabed,
  // turning any cave that opens into the ocean into a water cave.
  if(sy<SEA){
    fillWater(top+1,sy);
    if(bm===1||bm===2){sb(m,wx,ty,wz,K.sand);for(let d=1;d<=2&&ty-d>DS_TOP;d++)sb(m,wx,ty-d,wz,K.sand);return ty;}
    const wTop=pre.water?Math.min(pre.waterTop,SEA):SEA;
    fillWater(sy+1,wTop);
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
  if(K.bee_nest&&rnd()>0.95)sb(m,wx+1,ty+h-2,wz,K.bee_nest);
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
  const LF=K.cherry_leaf,LG=K.cherry_log;
  // Vanilla cherry: a short trunk that forks into 2-4 upward-angled branches,
  // each capped by a rounded pink blossom blob; petals scatter on the ground.
  const h=5+((rnd()*3)|0);                     // trunk 5..7
  trunk1(m,wx,ty,wz,LG,h);
  // Round blossom blob helper.
  const blob=(bx,by,bz,r)=>{
    for(let dx=-r;dx<=r;dx++)for(let dy=-1;dy<=1;dy++)for(let dz=-r;dz<=r;dz++){
      if(dx*dx+dz*dz+dy*dy*2>r*r+1)continue;
      if(Math.abs(dx)===r&&Math.abs(dz)===r&&rnd()<0.6)continue;
      sb(m,bx+dx,by+dy,bz+dz,LF);
    }
  };
  // central crown
  blob(wx,ty+h,wz,2);
  // forked branches
  const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]];
  const nB=2+((rnd()*3)|0);                     // 2..4 branches
  const used={};
  for(let i=0;i<nB;i++){
    let di=(rnd()*dirs.length)|0;
    if(used[di]){di=(di+1)%dirs.length;}
    used[di]=1;
    const d=dirs[di];
    const reach=2+((rnd()*2)|0);                // branch length 2..3
    let bx=wx,bz=wz,by=ty+h-1-((rnd()*2)|0);
    for(let step=1;step<=reach;step++){
      bx+=d[0];bz+=d[1];by+=1;
      sb(m,bx,by,bz,LG);
    }
    blob(bx,by+1,bz,2);
  }
  // ground petals
  if(K.pink_petals)for(let i=0,n=2+((rnd()*3)|0);i<n;i++){
    const px=wx+((rnd()*5)|0)-2,pz=wz+((rnd()*5)|0)-2;
    sb(m,px,ty,pz,K.pink_petals);
  }
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
// CORAL_COLORS maps index → {block, plant, fan} permutation triplet so we can
// pick a consistent colour per column without multiple noise lookups.
const CORAL_COLORS_KEY=['blue','pink','purple','red','yellow'];
let _coralSets=null;
function getCoralSet(i){
  if(!_coralSets){
    _coralSets=[];
    for(const c of CORAL_COLORS_KEY)_coralSets.push({blk:K['coral_'+c],fan:K['coral_fan_'+c],plant:K['coral_plant_'+c]});
  }
  return _coralSets[i%5];
}
function placeOceanFeat(m,wx,ty,wz,bm){
  if(bm===12){
    // Coral reef: column-level noise for reef zone density, separate noise for
    // colour. Layers: sand base → coral block → coral fan / plant → sea pickle.
    const reefN=p2(wx*0.04+9000,wz*0.04)*P2N;
    if(reefN<0.25)return;                          // ~60 % of reef columns active
    const dead=reefN<0.35;                         // outer fringe → dead coral
    const ci=(Math.abs(p2(wx*0.13+19000,wz*0.13))*5)|0;
    const cs=getCoralSet(ci);

    // always sand directly under the formation
    sb(m,wx,ty,wz,K.sand);

    // base block: live or dead coral block
    const baseBlk=(!dead&&cs.blk)?cs.blk:K.sand;
    sb(m,wx,ty,wz,baseBlk);

    // column height 0-2: some columns are just a flat fan
    const colH=colRnd(wx,wz,611);
    if(colH<0.50){
      // short: coral fan or dead fan on top of the base
      const fan=dead?K.dead_coral_fan:cs.fan;
      if(fan)sb(m,wx,ty+1,wz,fan);
    }else if(colH<0.80){
      // medium: second coral block + fan
      const blk2=(!dead&&cs.blk)?cs.blk:K.sand;
      sb(m,wx,ty+1,wz,blk2);
      const fan=dead?K.dead_coral_fan:cs.fan;
      if(fan)sb(m,wx,ty+2,wz,fan);
    }else{
      // tall: two stacked coral blocks + plant + optional sea pickle
      const blk2=(!dead&&cs.blk)?cs.blk:K.sand;
      sb(m,wx,ty+1,wz,blk2);
      const plant=dead?null:cs.plant;
      if(plant)sb(m,wx,ty+2,wz,plant);
      if(!dead&&K.sea_pickle&&colRnd(wx,wz,613)<0.25)sb(m,wx,ty+2,wz,K.sea_pickle);
    }

    // side fans on adjacent faces (2-4 sides) for the denser core patches
    if(!dead&&reefN>0.55){
      const sideFan=cs.fan;
      if(sideFan){
        const sides=[[1,0],[-1,0],[0,1],[0,-1]];
        for(const[sx,sz] of sides){
          if(colRnd(wx+sx*37,wz+sz*41,617)<0.55)
            sb(m,wx+sx,ty+1,wz+sz,sideFan);
        }
      }
    }
    return;
  }

  // Any submerged column (ocean, river, lake, swamp, mangrove): seagrass on the
  // floor. Kelp forests only rise in open-ocean columns of sufficient depth.
  if(ty>=SEA-1)return;
  const sg=p2(wx*0.12+10000,wz*0.12)*P2N;
  const rr=colRnd(wx,wz,711);
  if(K.seagrass&&rr<0.25){
    sb(m,wx,ty+1,wz,K.seagrass);
  }else if(bm===0&&K.kelp&&ty<=SEA-5&&sg<-0.30){
    const kh=Math.min(SEA-ty-2,3+Math.floor(Math.abs(sg)*16));
    for(let y=1;y<=kh;y++)sb(m,wx,ty+y,wz,K.kelp);
  }
}

// ── SURFACE FLORA ──────────────────────────────────────────────
// Every grassy biome gets a set of at least 3 flowers. Plains uses the full
// palette at the base rate; all other grassy biomes spawn their themed set at
// one third of the plains rate. Tall flowers (rose bush, peony, lilac,
// sunflower) are placed as proper 2-block plants.
let FLOWER_SETS=null,TALL_SET=null;
function initFlowers(){
  if(FLOWER_SETS)return;
  const F=K;
  const tulips=[F.red_tulip,F.orange_tulip,F.white_tulip,F.pink_tulip].filter(Boolean);
  const tall=[F.rose_bush,F.peony,F.lilac,F.sunflower].filter(Boolean);
  const ALL=[F.dandelion,F.poppy,F.allium,F.azure,F.cornfl,F.oxeye,F.lily_v,F.blue_orch,...tulips,...tall].filter(Boolean);
  FLOWER_SETS={
    2:[F.dandelion,F.poppy,F.azure].filter(Boolean),                                    // savanna
    3:ALL,                                                                              // plains: every flower
    4:[F.poppy,F.dandelion,F.rose_bush,F.peony,F.lilac,F.azure,F.oxeye,F.allium].filter(Boolean), // forest
    5:[F.lily_v,F.dandelion,F.poppy,F.oxeye,F.cornfl].filter(Boolean),                  // birch
    6:[F.dandelion,F.poppy,...tulips].filter(Boolean),                                  // jungle
    8:[F.blue_orch,F.dandelion,F.poppy].filter(Boolean),                                // swamp
    9:[F.poppy,F.dandelion,F.lily_v].filter(Boolean),                                   // taiga
    11:[F.dandelion,F.poppy,F.cornfl,F.oxeye,F.allium].filter(Boolean),                 // mountain meadow
    13:[F.lily_v,F.allium,F.oxeye].filter(Boolean),                                     // dark oak
    14:[F.allium,F.pink_tulip,F.peony,F.lilac,F.dandelion].filter(Boolean),             // cherry
    15:[F.lily_v,F.oxeye,F.dandelion].filter(Boolean),                                  // pale garden
  };
  TALL_SET=new Set(tall);
}
function placeFlora(m,wx,ty,wz,bm){
  initFlowers();
  const r=colRnd(wx,wz,11),r2=colRnd(wx,wz,23);
  const fset=FLOWER_SETS[bm];
  if(fset&&fset.length&&!(bm===11&&ty>200)){
    const rate=bm===3?0.05:0.0167;          // others = 1/3 of plains
    if(r<rate){
      const fl=fset[(r2*fset.length)|0];
      if(fl){ if(TALL_SET.has(fl))placeTall(m,wx,ty+1,wz,fl); else sb(m,wx,ty+1,wz,fl); return; }
    }
  }
  switch(bm){
    case 1:if(r<0.04&&K.dead_bush)sb(m,wx,ty+1,wz,K.dead_bush);break;
    case 2:if(r<0.05&&K.dead_bush)sb(m,wx,ty+1,wz,K.dead_bush);else if(r<0.23&&K.t_grass)sb(m,wx,ty+1,wz,K.t_grass);break;
    case 3:if(r<0.33&&K.t_grass)sb(m,wx,ty+1,wz,K.t_grass);break;
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
// True if this column's surface is beach sand (handled by fillCol's doBeach).
// Deserts/badlands/savanna are excluded so their own flora still spawns.
function isBeachSand(wx,wz,sy,bm){
  if(bm===1||bm===2||bm===18)return false;
  if(sy<=SEA+3){const bn=p2(wx*0.005+8000,wz*0.005);return bn>0.38;}
  return false;
}
function* placeFeat(m,cx,cz,surfs,bms,tys){
  const x0=cx*16,z0=cz*16;
  for(let wx=x0;wx<x0+16;wx++){
    for(let wz=z0;wz<z0+16;wz++){
      const si=(wx-x0)*16+(wz-z0);
      const sy=surfs[si],bm=bms[si];
      if(sy<SEA){placeOceanFeat(m,wx,tys[si],wz,bm);continue;}
      const ty=tys[si];

      // No trees or foliage on bare sand (beaches) unless it's a desert biome.
      const sandy=isBeachSand(wx,wz,sy,bm);

      if(bm!==0&&bm!==12&&!sandy)placeFlora(m,wx,ty,wz,bm);
      if(sandy)continue;

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
  placeSpawner(m,cx,wy+1,cz,"silverfish");
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
let _shLayout=null;
function computeSHLayout(){
  if(_shLayout)return _shLayout;
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

    // ── Additional levels: a chain of rooms, each joined by a corridor that may
    //    slope down a level (real multistory). Level 2 almost always, 3 common,
    //    4 occasional. Some rooms sprout a perpendicular side-branch room, so the
    //    stronghold grows into a larger multi-floor network.
    let prevDist=dist1,prevHd=r1.hd;
    const levelChance=[0.92,0.62,0.30];   // chance to extend to levels 2,3,4
    for(let L=0;L<levelChance.length;L++){
      if(shRd()>levelChance[L])break;
      const slope=shRd()>0.40;            // slopes common → vertical spread
      const clen=7+shRi(7);
      const sxN=ddx*(prevDist+prevHd+1),szN=ddz*(prevDist+prevHd+1);
      tasks.push({type:'corridor',sx:sxN,sz:szN,ddx,ddz,len:clen,wy,slope});
      if(slope)wy-=(clen>>1);
      const rtN=(L===0&&di!==libDir&&shRd()>0.7)?'library':RTYPES[shRi(RTYPES.length)];
      const rN=RDEF[rtN];
      const distN=prevDist+prevHd+1+clen+rN.hd;
      tasks.push({type:rtN,cx:ddx*distN,cz:ddz*distN,ddx,ddz,hd:rN.hd,hw:rN.hw,wy});
      // perpendicular side-branch room
      if(shRd()>0.55){
        const perp=DIRS[(di+(shRd()>0.5?1:3))%4];
        const pdx=perp[0],pdz=perp[1];
        const bl=6+shRi(5);
        const bsx=ddx*distN+pdx*(rN.hw+1),bsz=ddz*distN+pdz*(rN.hw+1);
        tasks.push({type:'corridor',sx:bsx,sz:bsz,ddx:pdx,ddz:pdz,len:bl,wy});
        const rtB=RTYPES[shRi(RTYPES.length)];
        const rB=RDEF[rtB];
        const bdist=(rN.hw+1)+bl+rB.hd;
        tasks.push({type:rtB,cx:ddx*distN+pdx*bdist,cz:ddz*distN+pdz*bdist,ddx:pdx,ddz:pdz,hd:rB.hd,hw:rB.hw,wy});
      }
      prevDist=distN;prevHd=rN.hd;
    }
  }
  _shLayout=tasks;
  return tasks;
}

// ── STRONGHOLD PIECE (each chunk within range contributes its parts) ──
function* placeStrongholdPiece(m,cx,cz){
  if(Math.abs(cx)>11||Math.abs(cz)>11)return; // wider radius for the larger build
  if(SHY<WMIN)return;
  const layout=computeSHLayout();

  // Portal room + entrance shaft: chunk (0,0) only — enlarged 17×17 hall
  if(cx===0&&cz===0){
    yield* shHollow(m,SHX-8,SHY,SHZ-8,SHX+8,SHY+9,SHZ+8);
    const epfBase=K.end_frame||K.obsidian;
    // Helper: returns a frame permutation facing toward the portal center.
    // Bedrock "minecraft:cardinal_direction" on end_portal_frame is the direction
    // the frame FACES (toward center). Frames at fz==-2 face south, fz==+2 face
    // north, fx==-2 face east, fx==+2 face west.
    function mkEPF(fx,fz){
      if(!K.end_frame)return K.obsidian;
      try{
        // Determine which edge this frame is on: fz==±2 is the N/S edge,
        // fx==±2 is the E/W edge. Check |fz|==2 first to avoid ambiguity
        // (all corner slots have exactly one axis at ±2).
        let dir;
        if(Math.abs(fz)===2) dir=fz<0?"south":"north";
        else                  dir=fx<0?"east":"west";
        return B.resolve("minecraft:end_portal_frame").withState("minecraft:cardinal_direction",dir);
      }catch{return epfBase;}
    }
    // 12-frame end portal ring
    for(const[fx,fz] of [[-1,-2],[0,-2],[1,-2],[-1,2],[0,2],[1,2],
                          [-2,-1],[-2,0],[-2,1],[2,-1],[2,0],[2,1]])
      sb(m,SHX+fx,SHY+1,SHZ+fz,mkEPF(fx,fz));
    // raised platform around the portal
    for(let x=SHX-3;x<=SHX+3;x++)for(let z=SHZ-3;z<=SHZ+3;z++)sb(m,x,SHY,z,K.s_brick||K.stone);
    for(let x=SHX-1;x<=SHX+1;x++)for(let z=SHZ-1;z<=SHZ+1;z++)sb(m,x,SHY,z,K.lava); // central lava well below frame
    // silverfish spawner in a corner (not inside the ring)
    placeSpawner(m,SHX+6,SHY+1,SHZ+6,"silverfish");
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
  placeSpawner(m,wx,ry+1,wz,dungeonMob(wx,wz));
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
    if(rnd()<0.7)placeSpawner(m,scx,ry+1,scz,dungeonMob(scx,scz));
    placeChest(m,scx+1,ry+1,scz,"dungeon");
    if(rnd()<0.5)placeChest(m,scx-1,ry+1,scz,"storage");
    yield;
  }
  // ── LOWER LEVEL (multistory) — a basement chamber beneath the hall with its
  //    own spawner and loot, linked by a ladder shaft. Makes the dungeon span
  //    two floors.
  if(rnd()<0.85){
    const by=ry-7;
    if(by>DS_TOP+6){
      yield* dungeonRoom(m,wx,by,wz,6,6);
      placeSpawner(m,wx,by+1,wz,dungeonMob(wx+7,wz+7));
      for(const[ox,oz] of [[-4,-4],[4,4],[-4,4],[4,-4]])
        placeChest(m,wx+ox,by+1,wz+oz,rnd()<0.5?"dungeon":"treasury");
      if(K.cobweb)for(const[ox,oz] of [[-5,0],[5,0],[0,-5],[0,5]])sb(m,wx+ox,by+4,wz+oz,K.cobweb);
      // ladder shaft from the hall floor down into the basement
      const sxp=wx+5,szp=wz+5;
      for(let y=by+1;y<=ry;y++){
        sb(m,sxp+1,y,szp,K.cobble||K.stone);sb(m,sxp-1,y,szp,K.cobble||K.stone);
        sb(m,sxp,y,szp+1,K.cobble||K.stone);sb(m,sxp,y,szp-1,K.cobble||K.stone);
        if(K.ladder)try{sb(m,sxp,y,szp,K.ladder);}catch{}else sb(m,sxp,y,szp,K.air);
      }
      yield;
    }
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
  // 3 chests — treasure chest has a 50% chance to hold a Heart of the Sea
  const heart=colRnd(wx,wz,909)<0.5;
  placeChest(m,wx-5,hy+1,wz,"shipwreck_supply");
  placeChest(m,wx,hy+1,wz,"shipwreck_treasure",heart?[{id:"minecraft:heart_of_the_sea",count:1}]:null);
  placeChest(m,wx+5,hy+6,wz,"shipwreck_map");
  yield;
}

// GEODE — now placeable at ANY y (caller passes a wide-range ry). Spread
// placement handled in placeStructures (per-chunk rare hash, isolated).
function* geodeGen(m,wx,wz,ry){
  if(!K.amethyst||!K.s_basalt)return;
  if(ry<=WMIN+6||ry>=WMAX-6)return;
  const rad=5+(Math.abs(p2(wx*0.1,wz*0.1))*2|0)%3;
  // Embed check: a geode must sit in rock, not float in an open cave. Sample the
  // centre + axis points; require most to be solid (not carved cave) and below
  // the surface, so the geode is at least partially embedded in a wall.
  let solid=0;
  for(const[dx,dy,dz] of [[0,0,0],[rad,0,0],[-rad,0,0],[0,rad,0],[0,-rad,0],[0,0,rad],[0,0,-rad]]){
    if(!caveAt(wx+dx,ry+dy,wz+dz)&&ry+dy<surfYM(wx+dx,wz+dz)-1)solid++;
  }
  if(solid<3)return;                       // too exposed → would float; skip
  const CL=K.am_cluster;
  for(let dx=-rad-2;dx<=rad+2;dx++){
    for(let dy=-rad-2;dy<=rad+2;dy++)for(let dz=-rad-2;dz<=rad+2;dz++){
      const dist=Math.sqrt(dx*dx+dy*dy+dz*dz);
      if     (dist<=rad-2)sb(m,wx+dx,ry+dy,wz+dz,K.air);
      else if(dist<=rad-1){
        // inner amethyst shell with budding amethyst + inward clusters
        const isBud=Math.abs(p3(wx+dx,ry+dy,wz+dz))>0.55;
        sb(m,wx+dx,ry+dy,wz+dz,isBud?(K.bud_amethyst||K.amethyst):K.amethyst);
        if(isBud&&CL&&Math.abs(p3((wx+dx)*0.7,(ry+dy)*0.7,(wz+dz)*0.7))>0.6){
          const ix=dx>0?-1:dx<0?1:0,iy=dy>0?-1:dy<0?1:0,iz=dz>0?-1:dz<0?1:0;
          sb(m,wx+dx+ix,ry+dy+iy,wz+dz+iz,CL);  // cluster grows inward
        }
      }
      else if(dist<=rad  )sb(m,wx+dx,ry+dy,wz+dz,K.calcite);
      else if(dist<=rad+1)sb(m,wx+dx,ry+dy,wz+dz,K.s_basalt);
    }
    yield;
  }
}

// ── CAVE FEATURES (deferred → placed in the structure phase so the parts that
// spill into neighbouring chunks land on terrain that already exists and are
// NOT overwritten). All bounds-guarded by sb(); spill stays < 1 chunk.
// Find the highest cave floor (solid with air above) in [yBot,yTop] at x,z.
function findCaveFloor(x,z,yTop,yBot){
  let prevAir=false;
  for(let y=yTop;y>=yBot;y--){
    const air=caveAt(x,y,z);
    if(prevAir&&!air)return y;   // solid here, air above → floor
    prevAir=air;
  }
  return null;
}
// Paint a cave-decoration block 2-3 blocks INTO the surrounding walls/floor/
// ceiling around an anchor. Uses caveAt() (cheap noise) to tell air from solid,
// stamping outward from each nearby cave-air cell so the decoration penetrates
// the rock rather than only coating the exposed face.
const _PCS=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
function paintCaveShell(m,x,y,z,block,depth){
  if(!block)return;
  const R=3;
  for(let dx=-R;dx<=R;dx++)for(let dy=-R;dy<=R;dy++)for(let dz=-R;dz<=R;dz++){
    const ax=x+dx,ay=y+dy,az=z+dz;
    if(!caveAt(ax,ay,az))continue;                 // start only from cave air
    for(const[ux,uy,uz] of _PCS){
      for(let t=1;t<=depth;t++){
        const sx=ax+ux*t,sy=ay+uy*t,sz=az+uz*t;
        if(sy<=WMIN+1)break;
        if(caveAt(sx,sy,sz))break;                 // reached more air → stop
        sb(m,sx,sy,sz,block);
      }
    }
  }
}
// VANILLA-STYLE LUSH SPOT: mossy floor (penetrating into walls), moss carpet,
// azalea bushes, big + small dripleaf, a clay-rimmed water puddle, and ceiling
// features (spore blossom, glow berries / cave vines, hanging roots, glow lichen).
function decorateLushSpot(m,x,fy,z){
  const M=K.moss||K.mycelium;
  paintCaveShell(m,x,fy,z,M,2+((colRnd(x,z,560)*2)|0));   // moss 2-3 blocks into walls
  // ceiling height
  let ceil=null;
  for(let h=2;h<=14;h++){if(!caveAt(x,fy+h,z)){ceil=fy+h-1;break;}}
  // floor carpet + plants
  for(let dx=-2;dx<=2;dx++)for(let dz=-2;dz<=2;dz++){
    if(dx*dx+dz*dz>5)continue;
    const fx=x+dx,fz=z+dz;
    if(caveAt(fx,fy,fz)||!caveAt(fx,fy+1,fz))continue;     // need solid floor, air above
    sb(m,fx,fy,fz,M);
    const r=colRnd(fx,fz,581);
    if(r<0.16&&K.azalea)sb(m,fx,fy+1,fz,(colRnd(fx,fz,582)<0.4&&K.flow_azalea)?K.flow_azalea:K.azalea);
    else if(r<0.30&&K.small_drip)placeTall(m,fx,fy+1,fz,K.small_drip);
    else if(r<0.62&&K.moss_carpet)sb(m,fx,fy+1,fz,K.moss_carpet);
  }
  // clay-rimmed water puddle with a big dripleaf rising from it
  if(K.clay&&K.water){
    sb(m,x,fy,z,K.water);
    for(const[dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]])
      if(!caveAt(x+dx,fy,z+dz))sb(m,x+dx,fy,z+dz,K.clay);
    if(K.big_drip&&colRnd(x,z,584)<0.6){
      sb(m,x+1,fy,z,K.clay);
      sb(m,x+1,fy+1,z,K.big_drip_stem||K.big_drip);
      sb(m,x+1,fy+2,z,K.big_drip);
    }
  }
  // ceiling features
  if(ceil!=null){
    if(K.spore&&colRnd(x,z,583)<0.5)sb(m,x,ceil,z,K.spore);
    for(let dx=-2;dx<=2;dx++)for(let dz=-2;dz<=2;dz++){
      if(dx*dx+dz*dz>5)continue;
      const cxp=x+dx,czp=z+dz;
      if(caveAt(cxp,ceil+1,czp)||!caveAt(cxp,ceil,czp))continue; // solid ceiling, air below
      const r=colRnd(cxp,czp,585);
      if(r<0.26&&K.cave_vine){
        const len=1+((colRnd(cxp,czp,586)*3)|0);
        for(let v=0;v<len&&caveAt(cxp,ceil-v,czp);v++)
          sb(m,cxp,ceil-v,czp,(K.cave_vine_berry&&colRnd(cxp+v,czp,587)<0.4)?K.cave_vine_berry:K.cave_vine);
      }else if(r<0.46&&K.hanging_roots)sb(m,cxp,ceil,czp,K.hanging_roots);
      else if(r<0.62&&K.glow_lichen)sb(m,cxp,ceil,czp,K.glow_lichen);
    }
  }
}
// DEEP-DARK sculk spot: sculk-coated floor/walls (penetrating), with sculk
// sensors, shriekers (can_summon), a catalyst, and floor veins. A shrieker +
// sensor are guaranteed at the centre so every sculk pocket is "live".
function decorateSculkSpot(m,x,fy,z){
  const S=K.sculk;if(!S)return;
  paintCaveShell(m,x,fy,z,S,2+((colRnd(x,z,620)*2)|0));   // sculk 2-3 blocks into walls
  for(let dx=-2;dx<=2;dx++)for(let dz=-2;dz<=2;dz++){
    if(dx*dx+dz*dz>5)continue;
    const fx=x+dx,fz=z+dz;
    if(caveAt(fx,fy,fz)||!caveAt(fx,fy+1,fz))continue;     // need solid floor, air above
    sb(m,fx,fy,fz,S);
    const r=colRnd(fx,fz,621);
    if(r<0.10&&K.sculk_shrieker)sb(m,fx,fy+1,fz,K.sculk_shrieker);
    else if(r<0.26&&K.sculk_sensor)sb(m,fx,fy+1,fz,K.sculk_sensor);
    else if(r<0.33&&K.sculk_catalyst)sb(m,fx,fy+1,fz,K.sculk_catalyst);
    else if(r<0.45&&K.sculk_vein)sb(m,fx,fy+1,fz,K.sculk_vein);
  }
  // guaranteed centre features so the pocket always has a working sensor/shrieker
  if(K.sculk_shrieker)sb(m,x,fy+1,z,K.sculk_shrieker);
  if(K.sculk_sensor&&!caveAt(x+1,fy,z)&&caveAt(x+1,fy+1,z))sb(m,x+1,fy+1,z,K.sculk_sensor);
  if(K.sculk_catalyst&&!caveAt(x-1,fy,z)&&caveAt(x-1,fy+1,z))sb(m,x-1,fy+1,z,K.sculk_catalyst);
}
// BIG cave mushroom with VARIETY: 0 upright-tall, 1 wide-flat, 2 sideways,
// 3 diagonal. Bigger horizontally & vertically than vanilla huge mushrooms.
function bigMushroom(m,wx,ty,wz,variant,brown){
  const cap=brown?K.brn_mush_blk:K.red_mush_blk;
  if(!cap)return;
  const stem=K.mush_stem||cap;
  if(variant===1){                                  // WIDE FLAT
    const h=3+((colRnd(wx,wz,521)*2)|0);
    for(let y=0;y<h;y++)sb(m,wx,ty+y,wz,stem);
    const R=3;
    for(let dx=-R;dx<=R;dx++)for(let dz=-R;dz<=R;dz++)
      if(dx*dx+dz*dz<=R*R+1)sb(m,wx+dx,ty+h,wz+dz,cap);
  }else if(variant===2){                            // SIDEWAYS
    const len=3+((colRnd(wx,wz,523)*3)|0);
    const d=(colRnd(wx,wz,525)*4)|0;
    const dx=[1,-1,0,0][d],dz=[0,0,1,-1][d];
    sb(m,wx,ty,wz,stem);sb(m,wx,ty+1,wz,stem);
    for(let i=0;i<=len;i++)sb(m,wx+dx*i,ty+2,wz+dz*i,stem);
    const ex=wx+dx*len,ez=wz+dz*len;
    for(let ddx=-1;ddx<=1;ddx++)for(let ddz=-1;ddz<=1;ddz++){
      sb(m,ex+ddx,ty+2,ez+ddz,cap);sb(m,ex+ddx,ty+3,ez+ddz,cap);
    }
  }else if(variant===3){                            // DIAGONAL
    const steps=4+((colRnd(wx,wz,527)*3)|0);
    const dx=colRnd(wx,wz,529)<0.5?1:-1,dz=colRnd(wx,wz,531)<0.5?1:-1;
    let cxp=wx,czp=wz;
    for(let i=0;i<steps;i++){sb(m,cxp,ty+i,czp,stem);cxp+=dx;czp+=dz;}
    for(let ddx=-2;ddx<=2;ddx++)for(let ddz=-2;ddz<=2;ddz++)
      if(!(Math.abs(ddx)===2&&Math.abs(ddz)===2))sb(m,cxp+ddx,ty+steps,czp+ddz,cap);
  }else{                                            // UPRIGHT TALL
    const h=6+((colRnd(wx,wz,533)*5)|0);            // 6..10 tall
    for(let y=0;y<h;y++)sb(m,wx,ty+y,wz,stem);
    for(let dx=-2;dx<=2;dx++)for(let dz=-2;dz<=2;dz++){
      if(Math.abs(dx)===2&&Math.abs(dz)===2)continue;
      sb(m,wx+dx,ty+h,wz+dz,cap);sb(m,wx+dx,ty+h+1,wz+dz,cap);
    }
    sb(m,wx,ty+h+2,wz,cap);
  }
}
// Deferred cave-decoration pass: builds lush-cave features and big mushrooms on
// cave floors of the matching region, penetrates the decoration into the walls,
// and seeds axolotls into lush cave water. Generator → watchdog-safe.
function* caveDecorate(m,cx,cz,surfs,bms){
  const x0=cx*16,z0=cz*16,ci=8*16+8;
  const yTopBase=Math.min(surfs[ci]-6,45);
  const yBot=Math.max(WMIN+6,-180);
  let anyLush=false;
  for(let i=0;i<6;i++){
    const ox=2+((colRnd(cx,cz,540+i)*12)|0);
    const oz=2+((colRnd(cz,cx,560+i)*12)|0);
    const x=x0+ox,z=z0+oz;
    const yTop=Math.min(yTopBase,(surfs[ox*16+oz]||yTopBase)-6);
    if(yTop>yBot){
      const fy=findCaveFloor(x,z,yTop,yBot);
      if(fy!=null&&fy>WMIN+4&&caveAt(x,fy+1,z)&&caveAt(x,fy+2,z)){
        const cb=p3(x*0.006+25000,fy*0.006,z*0.006);
        if(cb<-0.50){                                   // LUSH cave (was amethyst)
          decorateLushSpot(m,x,fy,z);
          anyLush=true;
        }else if(cb>0.45){                              // MUSHROOM cave
          paintCaveShell(m,x,fy,z,K.mycelium,2);
          bigMushroom(m,x,fy+1,z,(colRnd(x,z,573)*4)|0,colRnd(x,z,575)>0.4);
        }
      }
    }
    yield;
  }
  // Axolotls: spawn into any cave water near a lush spot we just decorated.
  if(anyLush){
    try{
      const wx=x0+8,wz=z0+8;let found=null;
      const yhi=Math.min(surfs[ci]-3,SEA-1),ylo=Math.max(WMIN+4,-70);
      for(let y=yhi;y>=ylo;y--){
        const b=m.getBlock({x:wx,y,z:wz});
        if(b&&b.typeId==="minecraft:water"){found=y;break;}
      }
      if(found!=null&&colRnd(cx,cz,577)<0.7){
        const n=1+((colRnd(cx,cz,579)*3)|0);
        for(let i=0;i<n;i++)try{m.spawnEntity("minecraft:axolotl",{x:wx+0.5,y:found,z:wz+0.5});}catch{}
      }
    }catch{}
    yield;
  }
  // DEEP DARK pass: decorate sculk pockets (sensors + shriekers) on cave floors
  // at DEEPDARK_TOP and below, where the deep-dark region noise passes.
  if(K.sculk&&WMIN<=DEEPDARK_TOP-10){
    const dBot=Math.max(WMIN+6,-500);
    for(let i=0;i<4;i++){
      const ox=2+((colRnd(cx,cz,640+i)*12)|0);
      const oz=2+((colRnd(cz,cx,660+i)*12)|0);
      const x=x0+ox,z=z0+oz;
      const fy=findCaveFloor(x,z,DEEPDARK_TOP-2,dBot);
      if(fy!=null&&fy<=DEEPDARK_TOP&&fy>WMIN+4&&caveAt(x,fy+1,z)&&caveAt(x,fy+2,z)
         &&p2(x*0.004+33000,z*0.004)*P2N>-0.05){
        decorateSculkSpot(m,x,fy,z);
      }
      yield;
    }
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
// Biome → passive pool ("minecraft:" prefix added automatically). Pools list
// the passive/neutral mobs that naturally belong to each biome — NO hostiles.
// "axolotl" appears in lush biomes but is only ever placed into water (see the
// spawn loops); on dry ground it is skipped.
const PASSIVES={
  1:["rabbit","camel"],
  2:["cow","sheep","horse","donkey","chicken"],
  3:["cow","sheep","pig","chicken","horse","donkey"],
  4:["cow","sheep","pig","chicken","wolf","rabbit","axolotl"],
  5:["cow","sheep","pig","chicken","rabbit","axolotl"],
  6:["chicken","parrot","ocelot","panda","axolotl"],
  7:["frog","chicken"],
  8:["frog","chicken"],
  9:["sheep","pig","chicken","rabbit","wolf","fox"],
  10:["rabbit","fox","polar_bear"],
  11:["goat","llama","sheep"],
  13:["wolf","sheep","pig","chicken","rabbit"],
  14:["pig","sheep","rabbit","axolotl"],
  15:["rabbit"],
  17:["mooshroom"],
  18:["rabbit"],
};
const isAxolotl=k=>k.indexOf("axolotl")>=0;
// Find a water block at/below (x, yhi) within range; returns its Y or null.
function findWaterColumn(m,x,z,yhi,ylo){
  for(let y=yhi;y>=ylo;y--){
    try{const b=m.getBlock({x,y,z});if(b&&b.typeId==="minecraft:water")return y;}catch{}
  }
  return null;
}
function spawnPassives(m,cx,cz,surfs,bms){
  try{
    const si=8*16+8,sy=surfs[si],bm=bms[si];
    if(sy<SEA)return;
    const pool=PASSIVES[bm];
    if(!pool)return;
    if(bm!==17&&colRnd(cx,cz,55)>0.30)return;
    const kind=pool[(colRnd(cx,cz,61)*pool.length)|0];
    if(isAxolotl(kind))return; // axolotls handled by the lush cave-water pass
    const id="minecraft:"+kind;
    const n=2+((colRnd(cx,cz,67)*3)|0);
    for(let i=0;i<n;i++){
      const ox=4+((colRnd(cx+i,cz,71)*8)|0),oz=4+((colRnd(cx,cz+i,73)*8)|0);
      const s2=surfs[ox*16+oz];
      if(s2>=SEA)try{m.spawnEntity(id,{x:cx*16+ox,y:s2+2,z:cz*16+oz});}catch{}
    }
  }catch{}
}

// ── PLACE STRUCTURES (registry-driven generator) ───────────────
function* placeStructures(m,cx,cz,surfs,bms){
  if(Math.abs(cx)<=11&&Math.abs(cz)<=11){
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
  try{yield* caveDecorate(m,cx,cz,surfs,bms);}catch{}
  yield* placeVillage(m,cx,cz);
}

// ── JOB SYSTEM ────────────────────────────────────────────────
// Strictly sequential, player-driven chunk loader.
//   • Only ONE chunk job is ever in flight; the loader never starts another
//     chunk until the current one has completely finished.
//   • When idle it re-picks by priority:
//       1. Finish structures for a terrain-complete chunk whose 8 neighbours all
//          have terrain (so cross-border structure blocks land on real terrain
//          and are never overwritten by a later column fill).
//       2. Else load the UNBUILT chunk nearest a player that is cardinally
//          adjacent to an already-built chunk (flood-fill outward growth).
//       3. Else, if nothing around the player is built yet, load the chunk the
//          player is standing in first, then grow outward from there.
// "Built" is read from the completion sets first; when they are silent the
// centre column is sampled — a chunk that is only air, or only air + flowing
// water, across the height range counts as unbuilt.
const FULL=new Set();           // chunks fully complete (terrain+structures); persisted
const TERRAIN=new Set();        // chunks whose terrain (phase 0) is complete
const STRUCT_PENDING=new Map(); // key → {cx,cz}; terrain done, structures still owed
const PROBE_BUILT=new Set();    // probe-confirmed built (built stays built)
const PROBE_EMPTY=new Set();    // probe-confirmed empty (cleared once we build it)
const _structWait=new Map();    // chunk → number of times its structure phase was deferred
let run=false;
const ck=(cx,cz)=>`${cx},${cz}`;

function isDone(key){
  if(FULL.has(key))return true;
  try{if(w.getDynamicProperty("wgD_"+key)){FULL.add(key);return true;}}catch{}
  return false;
}
function markDone(key){
  FULL.add(key);
  try{w.setDynamicProperty("wgD_"+key,true);}catch{}
}

// "Is this chunk generated?" probe. The sets answer instantly; otherwise sample
// the centre column — first at the expected surface (one read for ordinary
// land/ocean terrain), then coarsely across the full height as a fallback. A
// column that is only air / flowing-water everywhere sampled is treated as
// unbuilt; any solid or source-liquid block means it has been generated.
const PROBE_LO=-512,PROBE_HI=512,PROBE_STRIDE=64;
const _notEmpty=t=>!!t&&t!=="minecraft:air"&&t!=="minecraft:flowing_water";
function _columnHasSolid(m,bx,bz){
  try{
    const sy=surfYM(bx,bz);
    for(let i=0;i<3;i++){
      const y=sy-(i===0?0:i===1?1:4);
      if(y<PROBE_LO||y>PROBE_HI)continue;
      const b=m.getBlock({x:bx,y,z:bz});
      if(b&&_notEmpty(b.typeId))return true;
    }
    for(let y=PROBE_HI;y>=PROBE_LO;y-=PROBE_STRIDE){
      const b=m.getBlock({x:bx,y,z:bz});
      if(b&&_notEmpty(b.typeId))return true;
    }
  }catch{return false;}   // unloaded / unreadable → treat as not built
  return false;
}
function chunkBuilt(m,cx,cz){
  const k=ck(cx,cz);
  if(FULL.has(k)||TERRAIN.has(k)||PROBE_BUILT.has(k))return true;
  if(PROBE_EMPTY.has(k))return false;
  if(isDone(k)){TERRAIN.add(k);return true;}
  if(_columnHasSolid(m,cx*16+8,cz*16+8)){PROBE_BUILT.add(k);return true;}
  PROBE_EMPTY.add(k);return false;
}
function chunkLoaded(m,cx,cz){
  try{
    const py=Math.max(WMIN,Math.min(0,WMAX));
    return !!m.getBlock({x:cx*16+8,y:py,z:cz*16+8});
  }catch{return false;}
}
function adjacentToBuilt(m,cx,cz){
  return chunkBuilt(m,cx+1,cz)||chunkBuilt(m,cx-1,cz)||chunkBuilt(m,cx,cz+1)||chunkBuilt(m,cx,cz-1);
}
function allNeighborsBuilt(m,cx,cz){
  return chunkBuilt(m,cx+1,cz)&&chunkBuilt(m,cx-1,cz)&&chunkBuilt(m,cx,cz+1)&&chunkBuilt(m,cx,cz-1)
       &&chunkBuilt(m,cx+1,cz+1)&&chunkBuilt(m,cx-1,cz+1)&&chunkBuilt(m,cx+1,cz-1)&&chunkBuilt(m,cx-1,cz-1);
}

// Two-phase generation:
//   phase 0 = terrain (bedrock, columns, ore veins, surface features)
//   phase 1 = structures (dungeons, strongholds, shipwrecks, geodes, cave
//             features, villages, mob seeding) — deferred until every one of
//             the 8 neighbouring chunks has finished its terrain phase, so any
//             structure blocks that spill across a chunk border land on terrain
//             that already exists and are never overwritten by a later column
//             fill. All structure builders are generators (yield) → watchdog-safe.
function* genJob(cx,cz,phase){
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

  if(phase===1){
    // Terrain (this chunk + all neighbours) already exists → safe to stamp
    // structures that cross chunk borders.
    try{yield* placeStructures(m,cx,cz,surfs,bms);}catch{}
    return;
  }

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
  // structures intentionally deferred to phase 1
}

// ── SCHEDULER (one chunk at a time, time-budgeted) ────────────
let _currentJob=null,_jobCx=0,_jobCz=0,_jobFail0=0,_jobPhase=0;
const STRUCT_GIVEUP=60;   // stamp a chunk's structures even if a neighbour never finishes building

// Pick the next unit of work, or null when there is nothing to do right now.
const _pcs=[];
function _distSq(cx,cz){let best=Infinity;for(let i=0;i<_pcs.length;i+=2){const dx=cx-_pcs[i],dz=cz-_pcs[i+1],d=dx*dx+dz*dz;if(d<best)best=d;}return best;}
function pickNext(m){
  let players;
  try{players=w.getPlayers();}catch{return null;}
  if(!players||!players.length)return null;
  _pcs.length=0;
  for(const p of players){const pl=p.location;_pcs.push(Math.floor(pl.x/16),Math.floor(pl.z/16));}
  const distSq=_distSq;
  const REACH=(RADIUS+2)*(RADIUS+2);

  // 1) Finish structures for interior chunks (all 8 neighbours already have terrain).
  let bestS=null,bestSD=Infinity;
  for(const [k,{cx,cz}] of STRUCT_PENDING){
    if(FULL.has(k)){STRUCT_PENDING.delete(k);continue;}
    const d=distSq(cx,cz);
    if(d>REACH)continue;
    if(!chunkLoaded(m,cx,cz))continue;
    const wv=_structWait.get(k)||0;
    if(!allNeighborsBuilt(m,cx,cz)&&wv<STRUCT_GIVEUP){_structWait.set(k,wv+1);continue;}
    if(d<bestSD){bestSD=d;bestS={cx,cz,phase:1};}
  }
  if(bestS)return bestS;

  // 2/3) Terrain expansion toward the nearest player.
  let bestAdj=null,bestAdjD=Infinity;   // unbuilt + cardinally adjacent to a built chunk
  let home=null,homeD=Infinity;         // a player's own chunk (fresh-start seed)
  for(const c of pcs){
    const pcx=c[0],pcz=c[1];
    for(let dx=-RADIUS;dx<=RADIUS;dx++)for(let dz=-RADIUS;dz<=RADIUS;dz++){
      const cx=pcx+dx,cz=pcz+dz,k=ck(cx,cz);
      if(FULL.has(k)||TERRAIN.has(k)||isDone(k))continue;   // already built
      if(!chunkLoaded(m,cx,cz))continue;                    // engine hasn't loaded it yet
      const d=distSq(cx,cz);
      if(dx===0&&dz===0&&d<homeD){homeD=d;home={cx,cz,phase:0};}
      if(d<bestAdjD&&adjacentToBuilt(m,cx,cz)){bestAdjD=d;bestAdj={cx,cz,phase:0};}
    }
  }
  if(bestAdj)return bestAdj;   // nearest frontier chunk that touches built terrain
  if(home)return home;         // nothing built nearby → load the player's own chunk first
  return null;
}

function finishJob(){
  const k=ck(_jobCx,_jobCz);
  if(_jobPhase===0){
    TERRAIN.add(k);PROBE_EMPTY.delete(k);
    STRUCT_PENDING.set(k,{cx:_jobCx,cz:_jobCz});
  }else{
    markDone(k);PROBE_EMPTY.delete(k);
    STRUCT_PENDING.delete(k);_structWait.delete(k);
    if(FULL.size>DONE_CACHE_MAX){
      FULL.clear();TERRAIN.clear();STRUCT_PENDING.clear();PROBE_BUILT.clear();PROBE_EMPTY.clear();_structWait.clear();
    }
  }
  _currentJob=null;
}

// Advance ONLY the in-flight job within the per-tick time budget. Returns as soon
// as the job finishes (or aborts); the next chunk is not chosen until a later
// tick, so one chunk always loads completely before another begins.
function stepCurrent(){
  const t0=NOW?NOW():0;
  const stepCap=NOW?MAX_STEPS_PER_TICK:8;
  let steps=0;
  while(steps<stepCap&&(!NOW||NOW()-t0<BUDGET_MS)){
    let r;
    try{r=_currentJob.next();}catch{r={done:true};}
    steps++;
    if(_chunkFails-_jobFail0>FAIL_ABORT){   // chunk unloaded mid-build → drop, retry later
      try{if(!r.done&&_currentJob.return)_currentJob.return();}catch{}
      _currentJob=null;return;
    }
    if(r.done){finishJob();return;}
  }
}

function kick(){
  if(run)return;
  run=true;
  const ticker=s.runInterval(()=>{try{
    if(_currentJob){stepCurrent();return;}   // never start another chunk mid-load
    const m=dim();
    const next=pickNext(m);
    if(!next){run=false;s.clearRun(ticker);return;}
    _jobCx=next.cx;_jobCz=next.cz;_jobPhase=next.phase;_jobFail0=_chunkFails;
    _currentJob=genJob(next.cx,next.cz,_jobPhase);
    stepCurrent();                            // begin the freshly selected chunk
  }catch{}},SCHED_INTERVAL);
}

// Players moving into fresh territory wake the idle loader.
s.runInterval(()=>{try{if(!run&&w.getPlayers().length)kick();}catch{}},20);

// ── PERIODIC PASSIVE-MOB RESPAWNS ──────────────────────────────
// Passive mobs keep appearing in their biomes on a long, jittered ~5–8 minute
// timer per player — herds of 2–4 drawn from the local biome's FULL passive
// roster (no hostiles). Axolotls only spawn into nearby water (incl. caves),
// otherwise that pick is skipped. Long intervals + small herds + vanilla mob
// caps keep this cheap and overpopulation-free.
const _nextMobTick=new Map(); // player.id → tick when next herd may spawn
function jitterTicks(){return 6000+((Math.random()*3600)|0);} // 5min..8min
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
      const pool=PASSIVES[bm];
      if(!pool)continue;
      const kind=pool[(Math.random()*pool.length)|0];
      const n=2+((Math.random()*3)|0);
      if(isAxolotl(kind)){
        // place axolotls into water near the player (surface pools or caves)
        const py=Math.floor(loc.y);
        for(let i=0;i<n;i++){
          const a=Math.random()*6.2832,dist=6+((Math.random()*14)|0);
          const sx=wx+Math.round(Math.cos(a)*dist),sz=wz+Math.round(Math.sin(a)*dist);
          const wy=findWaterColumn(m,sx,sz,Math.min(py+6,SEA-1),Math.max(WMIN+4,py-40));
          if(wy!=null)try{m.spawnEntity("minecraft:axolotl",{x:sx+0.5,y:wy,z:sz+0.5});}catch{}
        }
        continue;
      }
      if(sy<SEA)continue;
      const id="minecraft:"+kind;
      for(let i=0;i<n;i++){
        // spawn 16–36 blocks away in a random direction (out of immediate sight)
        const a=Math.random()*6.2832,dist=16+((Math.random()*20)|0);
        const sx=wx+Math.round(Math.cos(a)*dist),sz=wz+Math.round(Math.sin(a)*dist);
        const ssy=surfYM(sx,sz);
        if(ssy<SEA)continue;
        try{m.spawnEntity(id,{x:sx,y:ssy+2,z:sz});}catch{}
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

// ══════════════════════════════════════════════════════════════════════
// LOCATE — a /locate-style finder for this SCRIPT world's biomes & structures.
//   In-game usage (either works):
//     • Chat:        !locate <name>             e.g.  !locate desert
//                    !locate biome <name>             !locate structure village
//     • Scriptevent: /scriptevent wg:locate <name>
//   Biomes and structures are placed deterministically from the world seed, so
//   the finder simply replays the same placement maths over a spiral of chunks
//   and returns the nearest match. The search runs across ticks (system.runJob)
//   so it never freezes the game.
// ══════════════════════════════════════════════════════════════════════
const BIOME_IDS={
  ocean:0,desert:1,savanna:2,plains:3,forest:4,birch:5,birch_forest:5,
  jungle:6,mangrove:7,mangrove_swamp:7,swamp:8,taiga:9,snowy:10,snow:10,
  snowy_plains:10,mountain:11,mountains:11,coral:12,coral_reef:12,
  dark_oak:13,dark_forest:13,cherry:14,cherry_grove:14,pale:15,pale_garden:15,
  ice_spikes:16,ice:16,mooshroom:17,mushroom:17,mushroom_island:17,mesa:18,badlands:18,
};
const STRUCT_ALIAS={
  dungeon:'dungeon',ruin:'ruin',mineshaft:'mineshaft',ruined_portal:'ruined_portal',
  portal:'ruined_portal',shipwreck:'shipwreck',outpost:'pillager_outpost',
  pillager_outpost:'pillager_outpost',desert_temple:'desert_temple',temple:'desert_temple',
  jungle_temple:'jungle_temple',village:'village',stronghold:'stronghold',geode:'geode',
  fossil:'fossil',sculk_cave:'sculk_cave',sculk:'sculk_cave',deep_dark:'sculk_cave',deepdark:'sculk_cave',
};
const _tell=(pl,msg)=>{try{if(pl&&pl.sendMessage)pl.sendMessage(msg);else w.sendMessage(msg);}catch{}};

// Returns false, or {x,z} of the structure's world position, if `name` would
// generate in chunk (cx,cz) — replays placeStructures' exact selection logic.
function structurePresentAt(name,cx,cz){
  if(name==='stronghold')return (cx===0&&cz===0)?{x:SHX,z:SHZ}:false;
  const wx=cx*16+8,wz=cz*16+8;
  const sy=surfYM(wx,wz),bm=biome(wx,wz,sy);
  const nearOrigin=Math.abs(cx)<=1&&Math.abs(cz)<=1;
  if(name==='village'){
    const vc=getVillageCenter(cx,cz);
    if(!vc)return false;
    if(Math.floor(vc.vcx/16)!==cx||Math.floor(vc.vcz/16)!==cz)return false;
    const vsy=surfYM(vc.vcx,vc.vcz),vbm=biome(vc.vcx,vc.vcz,vsy);
    if(vbm===0||vbm===11||vbm===12||vbm===16||vbm===17)return false;
    return {x:vc.vcx,z:vc.vcz};
  }
  if(name==='geode')return (!nearOrigin&&colRnd(cx,cz,409)<0.028)?{x:wx,z:wz}:false;
  if(name==='fossil')return (!nearOrigin&&colRnd(cx,cz,401)<0.045)?{x:wx,z:wz}:false;
  if(name==='sculk_cave'){
    if(p2(wx*0.004+33000,wz*0.004)*P2N<=-0.05)return false;
    const dBot=Math.max(WMIN+6,-500);
    if(DEEPDARK_TOP-2<=dBot)return false;
    const fy=findCaveFloor(wx,wz,DEEPDARK_TOP-2,dBot);
    return (fy!=null&&fy<=DEEPDARK_TOP)?{x:wx,z:wz,y:fy+1}:false;
  }
  if(nearOrigin)return false;            // registry structures skip the 3×3 origin
  let mainUsed=false;
  for(const st of STRUCTURES){
    if(st.group==="main"&&mainUsed)continue;
    const v=p2(cx*st.s+st.o,cz*st.s)*P2N;
    if(!st.test(v))continue;
    if(st.ok&&!st.ok(bm,sy))continue;
    if(st.group==="main")mainUsed=true;
    if(st.name===name)return {x:wx,z:wz};
  }
  return false;
}

function* ringChunks(pcx,pcz,r){
  if(r===0){yield[pcx,pcz];return;}
  for(let dx=-r;dx<=r;dx++){yield[pcx+dx,pcz-r];yield[pcx+dx,pcz+r];}
  for(let dz=-r+1;dz<=r-1;dz++){yield[pcx-r,pcz+dz];yield[pcx+r,pcz+dz];}
}

// Spiral outward from the player, nearest-match guaranteed, time-sliced.
function* locateSearch(player,kind,name,targetId,ox,oz){
  const pcx=Math.floor(ox/16),pcz=Math.floor(oz/16);
  const MAXR=500;            // chunks (~8000 blocks)
  const PROC_CAP=600000;
  let best=null,bestD=Infinity,processed=0;
  for(let r=0;r<=MAXR;r++){
    if(best&&(r*16)*(r*16)>bestD)break;       // no closer match possible
    for(const c of ringChunks(pcx,pcz,r)){
      const cx=c[0],cz=c[1];
      let hit=null;
      if(kind==='biome'){
        const wx=cx*16+8,wz=cz*16+8,sy=surfYM(wx,wz);
        if(biome(wx,wz,sy)===targetId)hit={x:wx,y:sy,z:wz};
      }else{
        const p=structurePresentAt(name,cx,cz);
        if(p)hit={x:p.x,z:p.z,y:p.y};
      }
      if(hit){
        const dd=(hit.x-ox)*(hit.x-ox)+(hit.z-oz)*(hit.z-oz);
        if(dd<bestD){bestD=dd;best=hit;}
      }
      if((++processed%4096)===0)yield;
      if(processed>PROC_CAP){r=MAXR+1;break;}
    }
    yield;
  }
  if(best){
    const y=(best.y!==undefined)?best.y:surfYM(best.x,best.z);
    const dist=Math.round(Math.sqrt(bestD));
    _tell(player,`§a[Locate] Nearest §f${name}§a is at §f${best.x}, ${y}, ${best.z}  §7(${dist} blocks away)`);
  }else{
    _tell(player,`§c[Locate] No §f${name}§c found within ${MAXR*16} blocks.`);
  }
}

function startLocate(player,kind,name,id,ox,oz){
  try{initNoise();}catch{}
  try{updateBounds(dim());}catch{}
  _tell(player,`§7[Locate] Searching for §f${name}§7…`);
  const job=locateSearch(player,kind,name,id,ox,oz);
  if(s.runJob){try{s.runJob(job);return;}catch{}}
  // Fallback driver if runJob is unavailable: ~3000 steps/tick.
  const h=s.runInterval(()=>{try{for(let i=0;i<3000;i++){if(job.next().done){s.clearRun(h);return;}}}catch{s.clearRun(h);}},1);
}

function runLocate(player,argstr,ox,oz){
  const parts=String(argstr||"").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if(!parts.length||parts[0]==='help'||parts[0]==='list'){
    _tell(player,"§e[Locate] Usage: §f!locate <name>§e  or  §f!locate biome|structure <name>");
    _tell(player,"§7 Biomes: ocean desert savanna plains forest birch jungle mangrove swamp taiga snowy mountain coral dark_oak cherry pale ice_spikes mooshroom mesa");
    _tell(player,"§7 Structures: dungeon ruin mineshaft ruined_portal shipwreck outpost desert_temple jungle_temple village stronghold geode fossil sculk_cave");
    return;
  }
  let kind=null,name=parts[0];
  if(parts[0]==='biome'||parts[0]==='structure'){kind=parts[0];name=parts[1]||"";}
  if(!name){_tell(player,"§c[Locate] Specify a biome or structure name. Try §f!locate help");return;}
  if(kind==='biome'||(kind===null&&name in BIOME_IDS)){
    if(!(name in BIOME_IDS)){_tell(player,`§c[Locate] Unknown biome '${name}'.`);return;}
    startLocate(player,'biome',name,BIOME_IDS[name],ox,oz);
  }else{
    const canon=STRUCT_ALIAS[name];
    if(!canon){_tell(player,`§c[Locate] Unknown name '${name}'. Try §f!locate help`);return;}
    startLocate(player,'structure',canon,null,ox,oz);
  }
}

// Chat interface: "!locate ..." or ".locate ..."
try{
  w.beforeEvents?.chatSend?.subscribe?.((ev)=>{
    try{
      const msg=ev.message||"";
      if(!/^[!.]locate(\s|$)/i.test(msg))return;
      ev.cancel=true;
      const player=ev.sender;
      const loc=player?player.location:{x:0,z:0};
      const args=msg.replace(/^[!.]locate\s*/i,"");
      s.run(()=>{try{runLocate(player,args,loc.x,loc.z);}catch{}});
    }catch{}
  });
}catch{}

// Scriptevent interface: /scriptevent wg:locate <name>
try{
  s.afterEvents?.scriptEventReceive?.subscribe?.((ev)=>{
    try{
      if(ev.id!=="wg:locate")return;
      const player=ev.sourceEntity&&ev.sourceEntity.typeId==="minecraft:player"?ev.sourceEntity:null;
      const loc=player?player.location:{x:0,z:0};
      runLocate(player,ev.message,loc.x,loc.z);
    }catch{}
  });
}catch{}
