// spine-merge.mjs
// Merge multiple spine skeleton layers (role + scene + bg) into a single
// SkeletonData JSON + multi-page atlas. Layer order determines slot draw order
// (first layer = back). Bone order is re-arranged so every parent precedes its
// children (role first when bg dropRoot reparents into role's root).
//
// Config (JSON):
// {
//   "outSkeleton": ".../merged.json",
//   "outAtlas": ".../merged.atlas",
//   "atlasBase": "merged",              // page png names: merged.png, merged_2.png, ...
//   "headerFrom": 0,                    // layer index providing skeleton header (x/y/w/h)
//   "layers": [
//     { "file": "...skel|json", "atlas": "...atlas", "dropRoot": true,
//       "renameBones": { "Old": "New" } },
//     ...
//   ]
// }
import fs from 'fs';
import path from 'path';
import { SkeletonBinary, SkeletonJson, TextureAtlas, AtlasAttachmentLoader } from '@esotericsoftware/spine-core';
import { skeletonDataToJson } from './spine-serialize.mjs';

const DEG = Math.PI / 180;

function mul(a, b) {
  return {
    a: a.a * b.a + a.b * b.c,
    b: a.a * b.b + a.b * b.d,
    c: a.c * b.a + a.d * b.c,
    d: a.c * b.b + a.d * b.d,
    x: a.a * b.x + a.b * b.y + a.x,
    y: a.c * b.x + a.d * b.y + a.y,
  };
}
function invert(m) {
  const det = m.a * m.d - m.b * m.c;
  return {
    a: m.d / det, b: -m.b / det,
    c: -m.c / det, d: m.a / det,
    x: (m.b * m.y - m.d * m.x) / det,
    y: (m.c * m.x - m.a * m.y) / det,
  };
}
// Local bone matrix from a JSON bone map (shearX ignored, matches runtime when shearX=0).
function localMatrix(b) {
  const rx = (b.rotation || 0) * DEG;
  const ry = ((b.rotation || 0) + 90 + (b.shearY || 0)) * DEG;
  const sx = b.scaleX != null ? b.scaleX : 1;
  const sy = b.scaleY != null ? b.scaleY : 1;
  return {
    a: Math.cos(rx) * sx,
    b: Math.cos(ry) * sy,
    c: Math.sin(rx) * sx,
    d: Math.sin(ry) * sy,
    x: b.x || 0,
    y: b.y || 0,
  };
}
// Decompose an affine matrix back into a JSON bone local (x,y,rotation,scaleX,scaleY,shearY).
function decompose(m) {
  const scaleX = Math.sqrt(m.a * m.a + m.c * m.c) || 1;
  const scaleY = Math.sqrt(m.b * m.b + m.d * m.d) || 1;
  let rotation = Math.atan2(m.c, m.a) / DEG;
  const sy = Math.atan2(m.d, m.b) / DEG - 90 - rotation;
  return { x: m.x, y: m.y, rotation, scaleX, scaleY, shearY: sy };
}

function loadSkeleton(file, atlasFile) {
  const atlas = new TextureAtlas(fs.readFileSync(atlasFile, 'utf8'), { load: () => {} });
  const loader = new AtlasAttachmentLoader(atlas);
  if (/\.json$/i.test(file)) {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new SkeletonJson(loader).readSkeletonData(j);
  }
  return new SkeletonBinary(loader).readSkeletonData(new Uint8Array(fs.readFileSync(file)));
}

// Rename bone references throughout a serialized JSON document.
function applyRenameBones(json, rename) {
  if (!rename || !Object.keys(rename).length) return;
  const r = (n) => (rename[n] || n);
  if (json.bones) for (const b of json.bones) {
    b.name = r(b.name);
    if (b.parent) b.parent = r(b.parent);
  }
  if (json.slots) for (const s of json.slots) s.bone = r(s.bone);
  for (const arr of [json.ik, json.transform, json.path, json.physics]) {
    if (!arr) continue;
    for (const c of arr) {
      c.bones = c.bones.map(r);
      if (c.target) c.target = r(c.target);
      if (c.bone) c.bone = r(c.bone);
    }
  }
  if (json.skins) for (const skin of json.skins) {
    if (skin.bones) skin.bones = skin.bones.map(r);
    for (const list of ['ik', 'transform', 'path', 'physics']) if (skin[list]) skin[list] = skin[list].map(r);
  }
  if (json.animations) {
    for (const anim of Object.values(json.animations)) {
      if (anim.bones) {
        const nb = {};
        for (const k of Object.keys(anim.bones)) nb[r(k)] = anim.bones[k];
        anim.bones = nb;
      }
    }
  }
}

function setLocal(bone, local) {
  for (const f of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'shearY']) {
    const v = f === 'scaleX' || f === 'scaleY' ? 1 : 0;
    if (local[f] !== v) bone[f] = local[f];
    else delete bone[f];
  }
}

// Drop this layer's root bone: its direct children are reparented under the
// merged root. Child worlds are computed within the layer's own bones (so the
// layer's root offset is included); the new local is relative to the merged
// root's world, preserving world position.
function dropRootBone(layer, combined, rootName, mergedRootWorld) {
  const bones = layer.json.bones;
  const root = bones.find(b => !b.parent);
  if (!root) throw new Error('dropRoot: no root bone found in this layer');
  const byName = new Map(bones.map(b => [b.name, b]));
  const cache = new Map();
  const worldOf = (name, stack = []) => {
    if (cache.has(name)) return cache.get(name);
    if (stack.includes(name)) throw new Error(`bone cycle at ${name}`);
    const b = byName.get(name);
    let m = localMatrix(b);
    if (b.parent) m = mul(worldOf(b.parent, stack.concat(name)), m);
    cache.set(name, m);
    return m;
  };
  const rootWorld = worldOf(root.name);
  const rootInv = invert(mergedRootWorld);
  for (const child of bones.filter(b => b.parent === root.name)) {
    const world = mul(rootWorld, localMatrix(child));
    setLocal(child, decompose(mul(rootInv, world)));
    child.parent = rootName;
  }
  const ci = combined.indexOf(root);
  if (ci >= 0) combined.splice(ci, 1);
  bones.splice(bones.indexOf(root), 1);
  return root.name;
}

// Remap bone indices in interleaved mesh vertices.
// Format: [boneCount, boneIdx, x, y, weight, boneIdx, x, y, weight, ..., boneCount, ...]
// boneIdx references the skeleton's bones array and must be remapped.
function remapMeshBoneIndices(vertices, remap) {
  for (let i = 0; i < vertices.length;) {
    const boneCount = vertices[i++];
    for (let n = 0; n < boneCount; n++) {
      vertices[i] = remap.get(vertices[i]);
      i += 4; // skip boneIdx, x, y, weight
    }
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

// Merge two JSON values; if both are non-array objects, merge keys recursively.
// If both are arrays (frame lists), require equality else conflict.
function mergeValue(dst, src, ctx) {
  if (src === undefined) return;
  if (dst === undefined) return src;
  if (Array.isArray(dst) && Array.isArray(src)) {
    if (deepEqual(dst, src)) return dst;
    throw new Error(`merge conflict at ${ctx}: two layers provide the same timeline/frame list`);
  }
  if (typeof dst === 'object' && dst !== null && typeof src === 'object' && src !== null && !Array.isArray(dst) && !Array.isArray(src)) {
    for (const k of Object.keys(src)) dst[k] = mergeValue(dst[k], src[k], `${ctx}.${k}`);
    return dst;
  }
  if (deepEqual(dst, src)) return dst;
  throw new Error(`merge conflict at ${ctx}: ${JSON.stringify(dst)} vs ${JSON.stringify(src)}`);
}

function mergeAnimations(result, layers, animPick = {}) {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (!layer.json.animations) continue;
    for (const [animName, anim] of Object.entries(layer.json.animations)) {
      const keep = animPick[animName];
      if (keep !== undefined) {
        const set = Array.isArray(keep) ? keep : [keep];
        if (!set.includes(i)) continue;
      }
      result[animName] = result[animName] || {};
      if (anim.events) {
        // event timelines may exist in several layers -> concat, dedupe by identity
        const existing = result[animName].events || [];
        result[animName].events = existing.concat(anim.events);
      }
      for (const key of Object.keys(anim)) {
        if (key === 'events') continue;
        result[animName][key] = mergeValue(result[animName][key], anim[key], `anim ${animName} ${key}`);
      }
    }
  }
  for (const anim of Object.values(result)) {
    if (anim.events) anim.events.sort((a, b) => a.time - b.time);
  }
}

function mergeSkins(layers) {
  const skins = {};
  for (const layer of layers) {
    for (const skin of layer.json.skins || []) {
      skins[skin.name] = skins[skin.name] || { name: skin.name };
      const dst = skins[skin.name];
      if (skin.bones) dst.bones = (dst.bones || []).concat(skin.bones);
      for (const list of ['ik', 'transform', 'path', 'physics']) {
        if (skin[list]) dst[list] = (dst[list] || []).concat(skin[list]);
      }
      if (skin.attachments) {
        for (const [slotName, atts] of Object.entries(skin.attachments)) {
          if (dst.attachments && dst.attachments[slotName]) {
            throw new Error(`skin '${skin.name}' slot '${slotName}' defined in multiple layers`);
          }
          dst.attachments = dst.attachments || {};
          dst.attachments[slotName] = atts;
        }
      }
    }
  }
  return Object.values(skins);
}

function mergeConstraintArray(layers, key) {
  const out = [];
  const seen = new Set();
  for (const layer of layers) {
    for (const c of layer.json[key] || []) {
      if (seen.has(c.name)) throw new Error(`${key} '${c.name}' defined in multiple layers`);
      seen.add(c.name);
      out.push(c);
    }
  }
  return out;
}

function mergeAtlas(layerAtlasTexts, pageNames) {
  const pages = [];
  for (let i = 0; i < layerAtlasTexts.length; i++) {
    const text = layerAtlasTexts[i];
    const lines = text.split(/\r?\n/);
    // first non-empty line is the page image file name
    let idx = 0;
    while (idx < lines.length && !lines[idx].trim()) idx++;
    if (idx >= lines.length) throw new Error(`empty atlas text for layer ${i}`);
    lines[idx] = pageNames[i];
    pages.push(lines.join('\n'));
  }
  return pages.join('\n');
}

// Reparent `boneName` under `newParentName`, recomputing its local transform so
// the world transform is preserved. Worlds are computed from the merged (already
// renamed / root-dropped) bone list.
function reparent(bones, boneName, newParentName) {
  const matrixByName = new Map();
  const byName = new Map(bones.map(b => [b.name, b]));
  const worldOf = (name, stack = []) => {
    if (matrixByName.has(name)) return matrixByName.get(name);
    if (stack.includes(name)) throw new Error(`bone cycle at ${name}`);
    const b = byName.get(name);
    if (!b) throw new Error(`reparent: unknown bone '${name}'`);
    let m = localMatrix(b);
    if (b.parent) m = mul(worldOf(b.parent, stack.concat(name)), m);
    matrixByName.set(name, m);
    return m;
  };
  const bone = byName.get(boneName);
  if (!bone) throw new Error(`reparent: unknown bone '${boneName}'`);
  const world = worldOf(boneName);
  const parentWorld = worldOf(newParentName);
  const local = decompose(mul(invert(parentWorld), world));
  bone.parent = newParentName;
  for (const f of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'shearY']) {
    const v = f === 'scaleX' || f === 'scaleY' ? 1 : 0;
    if (local[f] !== v) bone[f] = local[f];
    else delete bone[f];
  }
}

export function merge(config, cwd = process.cwd()) {
  const resolved = (p) => path.resolve(cwd, p);
  const layers = config.layers.map(l => {
    const json = skeletonDataToJson(loadSkeleton(resolved(l.file), resolved(l.atlas)));
    return { ...l, json };
  });

  // apply renames to every layer first (attach/drop targets use final names)
  for (const layer of layers) applyRenameBones(layer.json, layer.renameBones);

  // per-layer animation renames (config.animRename = { <layerIndex>: { old: new } }).
  // Applied before the union so same-name animations from different layers stay
  // separate instead of colliding (e.g. bg Idle_01 conveyor -> Sushi_01_R).
  layers.forEach((layer, i) => {
    const ren = config.animRename?.[i];
    if (!ren || !layer.json.animations) return;
    const out = {};
    for (const [name, anim] of Object.entries(layer.json.animations)) {
      out[ren[name] || name] = anim;
    }
    layer.json.animations = out;
  });

  // Capture original bone names per layer BEFORE dropRoot/sort, so we can
  // remap mesh vertex bone indices from layer-local order to final order.
  for (const layer of layers) layer._origBoneNames = layer.json.bones.map(b => b.name);

  // header from headerFrom layer
  let result = {};
  const hdr = layers[config.headerFrom != null ? config.headerFrom : 0].json.skeleton;
  if (hdr && Object.keys(hdr).length) result.skeleton = { ...hdr };

  // merged root name: first layer that does NOT drop its root
  const rootName = layers.find(l => !l.dropRoot)?.json.bones?.find(b => !b.parent)?.name;
  if (!rootName) throw new Error('no layer provides a root bone (all dropRoot)');

  const bones = [];
  for (const layer of layers) if (layer.json.bones) bones.push(...layer.json.bones);

  // world of the merged root within the combined (post-rename) list
  const mergedRootWorld = (() => {
    const byName = new Map(bones.map(b => [b.name, b]));
    const cache = new Map();
    const worldOf = (name, stack = []) => {
      if (cache.has(name)) return cache.get(name);
      if (stack.includes(name)) throw new Error(`bone cycle at ${name}`);
      const b = byName.get(name);
      if (!b) throw new Error(`unknown bone '${name}'`);
      let m = localMatrix(b);
      if (b.parent) m = mul(worldOf(b.parent, stack.concat(name)), m);
      cache.set(name, m);
      return m;
    };
    return worldOf(rootName);
  })();

  // drop roots (dropRoot layers must be listed before the layer whose root
  // becomes the merged root)
  for (const layer of layers) {
    if (layer.dropRoot) {
      layer._droppedRoot = dropRootBone(layer, bones, rootName, mergedRootWorld);
    }
  }

  // subtree attaches on the combined list (targets may live in any layer)
  for (const layer of layers) {
    for (const spec of layer.attachSubtrees || []) {
      reparent(bones, spec.bone, spec.parent);
    }
  }
  // move bones so parents precede children (topological sort)
  const byName = new Map(bones.map(b => [b.name, b]));
  const order = [];
  const visited = new Set();
  const stack = new Set();
  const visit = (b) => {
    if (visited.has(b)) return;
    if (stack.has(b)) throw new Error(`bone cycle involving ${b.name}`);
    stack.add(b);
    if (b.parent && byName.has(b.parent)) visit(byName.get(b.parent));
    stack.delete(b);
    visited.add(b);
    order.push(b);
  };
  for (const b of bones) visit(b);
  result.bones = order;

  // Remap mesh vertex bone indices after bone reordering.
  // The interleaved vertices format is: [boneCount, boneIdx, x, y, weight, ...]
  // where boneIdx references the skeleton's bones array. After reordering,
  // these indices become stale and must be remapped.
  const finalBoneIndex = new Map(order.map((b, i) => [b.name, i]));
  for (const layer of layers) {
    const origBoneNames = layer._origBoneNames; // before dropRoot/sort
    const remap = new Map(); // old index -> new index
    for (let i = 0; i < origBoneNames.length; i++) {
      remap.set(i, finalBoneIndex.get(origBoneNames[i]));
    }
    for (const skin of layer.json.skins || []) {
      for (const [slotName, atts] of Object.entries(skin.attachments || {})) {
        for (const att of Object.values(atts)) {
          if (att.type === 'mesh' && att.vertices && att.uvs && att.vertices.length !== att.uvs.length) {
            remapMeshBoneIndices(att.vertices, remap);
          }
        }
      }
    }
  }

  // slots in layer order (first layer = back), unless pinned by config.slotOrder
  const slots = [];
  for (const layer of layers) if (layer.json.slots) slots.push(...layer.json.slots);
  if (config.slotOrder) {
    const actual = slots.map(s => s.name);
    const expected = [...config.slotOrder];
    if (expected.length !== actual.length || !expected.every(n => actual.includes(n)) || new Set(expected).size !== expected.length) {
      throw new Error('config.slotOrder is not a permutation of the merged slot list');
    }
    slots.sort((a, b) => expected.indexOf(a.name) - expected.indexOf(b.name));
  }
  if (slots.length) result.slots = slots;

  for (const key of ['ik', 'transform', 'path', 'physics']) {
    const arr = mergeConstraintArray(layers, key);
    if (arr.length) result[key] = arr;
  }
  const skins = mergeSkins(layers);
  if (skins.length) result.skins = skins;

  // events union
  const events = {};
  for (const layer of layers) {
    for (const [name, ev] of Object.entries(layer.json.events || {})) {
      if (events[name] !== undefined) {
        if (!deepEqual(events[name], ev)) throw new Error(`event '${name}' conflicts across layers`);
      } else events[name] = ev;
    }
  }
  if (Object.keys(events).length) result.events = events;

  // animations union (animPick restricts a name to specific layer indices)
  result.animations = {};
  mergeAnimations(result.animations, layers, config.animPick || {});

  // atlas
  const pageNames = [];
  const layerAtlas = [];
  for (let i = 0; i < config.layers.length; i++) {
    layerAtlas.push(fs.readFileSync(resolved(config.layers[i].atlas), 'utf8'));
    pageNames.push(i === 0 ? `${config.atlasBase}.png` : `${config.atlasBase}_${i + 1}.png`);
  }
  const atlasText = mergeAtlas(layerAtlas, pageNames);

  return { skeleton: result, atlas: atlasText, pageNames, layerAtlas };
}

export function copyPages(config, pageNames, layerAtlas, outDir) {
  for (let i = 0; i < config.layers.length; i++) {
    const src = path.resolve(config.layers[i].atlas.replace(/\.atlas$/i, '.png'));
    const dst = path.join(outDir, pageNames[i]);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    else console.warn(`missing png for layer ${i}: ${src}`);
  }
}

export function main() {
  const args = process.argv.slice(2);
  const cfgIdx = args.findIndex(a => a === '--config');
  if (cfgIdx < 0 || !args[cfgIdx + 1]) {
    console.error('usage: node scripts/spine-merge.mjs --config <config.json> [--out-dir <dir>]');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(args[cfgIdx + 1], 'utf8'));
  const cwd = process.cwd();
  const { skeleton, atlas, pageNames, layerAtlas } = merge(cfg, cwd);
  const cfgOutDir = args.indexOf('--out-dir') >= 0 ? path.resolve(args[args.indexOf('--out-dir') + 1]) : null;
  let skelOut = path.resolve(cwd, cfg.outSkeleton);
  let atlasOut = path.resolve(cwd, cfg.outAtlas);
  if (cfgOutDir) {
    skelOut = path.join(cfgOutDir, path.basename(cfg.outSkeleton));
    atlasOut = path.join(cfgOutDir, path.basename(cfg.outAtlas));
  }
  fs.mkdirSync(path.dirname(skelOut), { recursive: true });
  fs.writeFileSync(skelOut, JSON.stringify(skeleton));
  fs.writeFileSync(atlasOut, atlas);
  copyPages(cfg, pageNames, layerAtlas, path.dirname(skelOut));
  console.log('merged skeleton:', skelOut);
  console.log('merged atlas  :', atlasOut);
  console.log('pages         :', pageNames.join(', '));
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main();
}
