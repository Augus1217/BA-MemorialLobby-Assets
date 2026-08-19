// spine-serialize.mjs
// SkeletonData -> Spine JSON (round-trip to SkeletonJson.readSkeletonData).
// Reconstructs bezier control points from the runtime's flattened segment chain
// via least squares (the flattening in CurveTimeline.setBezier is a linear map).
import {
  RegionAttachment, MeshAttachment, BoundingBoxAttachment, PathAttachment,
  PointAttachment, ClippingAttachment, DeformTimeline, SequenceTimeline,
  RotateTimeline, TranslateTimeline, TranslateXTimeline, TranslateYTimeline,
  ScaleTimeline, ScaleXTimeline, ScaleYTimeline, ShearTimeline, ShearXTimeline,
  ShearYTimeline, InheritTimeline, AttachmentTimeline, RGBATimeline, RGBTimeline,
  AlphaTimeline, RGBA2Timeline, RGB2Timeline, EventTimeline, DrawOrderTimeline,
  IkConstraintTimeline, TransformConstraintTimeline,
  PathConstraintPositionTimeline, PathConstraintSpacingTimeline,
  PathConstraintMixTimeline, PhysicsConstraintInertiaTimeline,
  PhysicsConstraintStrengthTimeline, PhysicsConstraintDampingTimeline,
  PhysicsConstraintMassTimeline, PhysicsConstraintWindTimeline,
  PhysicsConstraintGravityTimeline, PhysicsConstraintMixTimeline,
  PhysicsConstraintResetTimeline,
} from '@esotericsoftware/spine-core';

function hexByte(x) {
  let s = Math.round(x * 255).toString(16);
  return s.length === 1 ? '0' + s : s;
}
export function colorHex(c) {
  return hexByte(c.r) + hexByte(c.g) + hexByte(c.b) + hexByte(c.a);
}
function isWhite(c) { return c.r === 1 && c.g === 1 && c.b === 1 && c.a === 1; }
function isZero(c) { return c.r === 0 && c.g === 0 && c.b === 0 && c.a === 0; }

const AA = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const BB = [0, 1, 3, 6, 10, 15, 21, 28, 36];
const CC = [0, 0, 1, 4, 10, 20, 35, 56, 84];

function solve2(A, b) {
  let s00 = 0, s01 = 0, s11 = 0, d0 = 0, d1 = 0;
  for (let i = 0; i < A.length; i++) {
    const a0 = A[i][0], a1 = A[i][1], bi = b[i];
    s00 += a0 * a0; s01 += a0 * a1; s11 += a1 * a1; d0 += a0 * bi; d1 += a1 * bi;
  }
  const det = s00 * s11 - s01 * s01;
  if (Math.abs(det) < 1e-20) return [0, 0];
  return [(d0 * s11 - s01 * d1) / det, (s00 * d1 - s01 * d0) / det];
}

// Reconstruct (cx1, cy1, cx2, cy2) for one bezier curve of a timeline frame.
// pts: 9 stored segment points. t0/t3 frame times, v0/v3 frame values.
function fitBezier(pts, t0, t3, v0, v3) {
  const p1 = 0.243, p2 = 0.027;
  const q1 = -0.102, q2 = 0.042;
  const r1 = 0.018, r2 = -0.018;
  const kx0 = -0.271 * t0 + 0.001 * t3, kx1 = 0.054 * t0 + 0.006 * t3, kx2 = -0.006 * t0 + 0.006 * t3;
  const ky0 = -0.271 * v0 + 0.001 * v3, ky1 = 0.054 * v0 + 0.006 * v3, ky2 = -0.006 * v0 + 0.006 * v3;
  const A = [], bx = [], by = [];
  for (let i = 0; i < 9; i++) {
    A.push([AA[i] * p1 + BB[i] * q1 + CC[i] * r1, AA[i] * p2 + BB[i] * q2 + CC[i] * r2]);
    bx.push(pts[i][0] - t0 - (AA[i] * kx0 + BB[i] * kx1 + CC[i] * kx2));
    by.push(pts[i][1] - v0 - (AA[i] * ky0 + BB[i] * ky1 + CC[i] * ky2));
  }
  const x = solve2(A, bx);
  const y = solve2(A, by);
  return [x[0], y[0], x[1], y[1]];
}

// Serialize frames of a CurveTimeline with N values per frame.
// valueProps: property names for the values (e.g. ['x','y']), or a single string.
function curveFrames(tl, valueProps) {
  const props = Array.isArray(valueProps) ? valueProps : [valueProps];
  const fc = tl.getFrameCount();
  const entries = tl.getFrameEntries();
  const frames = tl.frames;
  const curves = tl.curves;
  const out = [];
  for (let f = 0; f < fc; f++) {
    const base = f * entries;
    const frame = { time: frames[base] };
    for (let i = 0; i < props.length; i++) frame[props[i]] = frames[base + 1 + i];
    if (f < fc - 1) {
      const ct = curves[f];
      if (ct === 1) frame.curve = 'stepped';
      else if (ct >= 2) {
        const chainBase = ct - 2;
        const t0 = frames[base], t3 = frames[base + entries];
        const bez = [];
        for (let v = 0; v < props.length; v++) {
          const v0 = frames[base + 1 + v], v3 = frames[base + entries + 1 + v];
          const pts = [];
          for (let k = 0; k < 9; k++) pts.push([curves[chainBase + v * 18 + k * 2], curves[chainBase + v * 18 + k * 2 + 1]]);
          bez.push(...fitBezier(pts, t0, t3, v0, v3));
        }
        frame.curve = bez;
      }
    }
    out.push(frame);
  }
  return out;
}

function colorFrameProps(tl, lightProp, darkProp) {
  const fc = tl.getFrameCount();
  const entries = tl.getFrameEntries();
  const frames = tl.frames;
  const curves = tl.curves;
  const out = [];
  for (let f = 0; f < fc; f++) {
    const base = f * entries;
    const frame = { time: frames[base] };
    const vals = [];
    for (let i = 0; i < entries - 1; i++) vals.push(frames[base + 1 + i]);
    if (darkProp) {
      frame[lightProp] = colorHex({ r: vals[0], g: vals[1], b: vals[2], a: vals[3] });
      frame[darkProp] = colorHex({ r: vals[4], g: vals[5], b: vals[6], a: 1 });
    } else {
      frame[lightProp] = colorHex({ r: vals[0], g: vals[1], b: vals[2], a: entries >= 5 ? vals[3] : 1 });
    }
    if (f < fc - 1) {
      const ct = curves[f];
      if (ct === 1) frame.curve = 'stepped';
      else if (ct >= 2) {
        const chainBase = ct - 2;
        const t0 = frames[base], t3 = frames[base + entries];
        const bez = [];
        for (let v = 0; v < entries - 1; v++) {
          const v0 = frames[base + 1 + v], v3 = frames[base + entries + 1 + v];
          const pts = [];
          for (let k = 0; k < 9; k++) pts.push([curves[chainBase + v * 18 + k * 2], curves[chainBase + v * 18 + k * 2 + 1]]);
          bez.push(...fitBezier(pts, t0, t3, v0, v3));
        }
        frame.curve = bez;
      }
    }
    out.push(frame);
  }
  return out;
}

function attachmentFrames(tl) {
  const fc = tl.getFrameCount();
  const out = [];
  for (let f = 0; f < fc; f++) out.push({ time: tl.frames[f], name: tl.attachmentNames[f] });
  return out;
}

function eventFrames(tl, eventsByName) {
  return tl.events.map(ev => {
    const data = ev.data;
    const frame = { time: ev.time, name: data.name };
    if (ev.intValue !== data.intValue) frame.int = ev.intValue;
    if (ev.floatValue !== data.floatValue) frame.float = ev.floatValue;
    if (ev.stringValue != null) frame.string = ev.stringValue;
    return frame;
  });
}

function ikFrames(tl) {
  const fc = tl.getFrameCount();
  const entries = tl.getFrameEntries();
  const frames = tl.frames;
  const curves = tl.curves;
  const out = [];
  for (let f = 0; f < fc; f++) {
    const base = f * entries;
    const frame = {
      time: frames[base],
      mix: frames[base + 1],
      softness: frames[base + 2],
      bendPositive: frames[base + 3] >= 0,
      compress: frames[base + 4] !== 0,
      stretch: frames[base + 5] !== 0,
    };
    if (f < fc - 1) {
      const ct = curves[f];
      if (ct === 1) frame.curve = 'stepped';
      else if (ct >= 2) {
        const chainBase = ct - 2;
        const t0 = frames[base], t3 = frames[base + entries];
        const bez = [];
        for (let v = 0; v < 2; v++) {
          const v0 = frames[base + 1 + v], v3 = frames[base + entries + 1 + v];
          const pts = [];
          for (let k = 0; k < 9; k++) pts.push([curves[chainBase + v * 18 + k * 2], curves[chainBase + v * 18 + k * 2 + 1]]);
          bez.push(...fitBezier(pts, t0, t3, v0, v3));
        }
        frame.curve = bez;
      }
    }
    out.push(frame);
  }
  return out;
}

function transformFrames(tl) {
  const props = ['mixRotate', 'mixX', 'mixY', 'mixScaleX', 'mixScaleY', 'mixShearY'];
  const frames = curveFrames(tl, props);
  for (const f of frames) {
    if (f.mixY === f.mixX) delete f.mixY;
    if (f.mixScaleY === f.mixScaleX) delete f.mixScaleY;
  }
  return frames;
}

function pathMixFrames(tl) {
  const props = ['mixRotate', 'mixX', 'mixY'];
  const frames = curveFrames(tl, props);
  for (const f of frames) if (f.mixY === f.mixX) delete f.mixY;
  return frames;
}

function inheritFrames(tl) {
  const fc = tl.getFrameCount();
  const out = [];
  for (let f = 0; f < fc; f++) out.push({ time: tl.frames[f], inherit: ['Normal', 'OnlyTranslation', 'NoRotationOrReflection', 'NoScale', 'NoScaleOrReflection'][tl.frames[fc + f]] });
  return out;
}

// Serialize a mesh/region/vertex attachment to JSON map.
function serializeAttachment(att, entryName, sd) {
  const map = {};
  if (att instanceof MeshAttachment) {
    map.path = att.path;
    if (att.sequence) map.sequence = { count: att.sequence.regions.length, start: att.sequence.start, digits: att.sequence.digits, setup: att.sequence.setupIndex };
    if (att.parentMesh) {
      map.type = 'linkedmesh';
      map.parent = att.parentMesh.name;
      if (att.parentMesh !== att.timelineAttachment) map.timelines = true;
      if (!isWhite(att.color)) map.color = colorHex(att.color);
      return map;
    }
    map.type = 'mesh';
    map.uvs = Array.from(att.regionUVs);
    map.triangles = Array.from(att.triangles);
    if (att.bones) {
      map.vertices = interleaveVertices(att.bones, att.vertices);
    } else {
      map.vertices = Array.from(att.vertices);
    }
    map.hull = att.hullLength / 2;
    map.width = att.region ? att.region.originalWidth : att.width;
    map.height = att.region ? att.region.originalHeight : att.height;
    if (att.edges && att.edges.length) map.edges = Array.from(att.edges);
    if (!isWhite(att.color)) map.color = colorHex(att.color);
  } else if (att instanceof RegionAttachment) {
    map.path = att.path;
    if (att.sequence) map.sequence = { count: att.sequence.regions.length, start: att.sequence.start, digits: att.sequence.digits, setup: att.sequence.setupIndex };
    map.x = att.x; map.y = att.y;
    map.scaleX = att.scaleX; map.scaleY = att.scaleY;
    map.rotation = att.rotation;
    map.width = att.region ? att.region.originalWidth : att.width;
    map.height = att.region ? att.region.originalHeight : att.height;
    if (!isWhite(att.color)) map.color = colorHex(att.color);
  } else if (att instanceof BoundingBoxAttachment) {
    map.type = 'boundingbox';
    map.vertexCount = att.worldVerticesLength >> 1;
    map.vertices = serializeVertices(att, sd);
    if (!isWhite(att.color)) map.color = colorHex(att.color);
  } else if (att instanceof PathAttachment) {
    map.type = 'path';
    map.closed = att.closed;
    map.constantSpeed = att.constantSpeed;
    map.vertexCount = att.worldVerticesLength >> 1;
    map.vertices = serializeVertices(att, sd);
    if (att.lengths && att.lengths.length) map.lengths = Array.from(att.lengths);
    if (!isWhite(att.color)) map.color = colorHex(att.color);
  } else if (att instanceof PointAttachment) {
    map.type = 'point';
    map.x = att.x; map.y = att.y; map.rotation = att.rotation;
    if (!isWhite(att.color)) map.color = colorHex(att.color);
  } else if (att instanceof ClippingAttachment) {
    map.type = 'clipping';
    if (att.endSlot) map.end = att.endSlot.name;
    map.vertexCount = att.worldVerticesLength >> 1;
    map.vertices = serializeVertices(att, sd);
    if (!isWhite(att.color)) map.color = colorHex(att.color);
  }
  return map;
}

// Reconstruct interleaved JSON vertices from runtime bones + decomposed vertices.
// runtime bones: [boneCount, idx, idx, ..., boneCount, ...] (flat)
// runtime vertices: [x, y, w, x, y, w, ...] (triplets)
// output: [boneCount, idx, x, y, w, idx, x, y, w, ..., boneCount, ...]
function interleaveVertices(bones, vertices) {
  const out = [];
  let vi = 0;
  for (let i = 0; i < bones.length;) {
    const boneCount = bones[i++];
    out.push(boneCount);
    for (let n = 0; n < boneCount; n++) {
      out.push(bones[i++]);
      out.push(vertices[vi++]);
      out.push(vertices[vi++]);
      out.push(vertices[vi++]);
    }
  }
  return out;
}

function serializeVertices(att, sd) {
  if (att.bones) return interleaveVertices(att.bones, att.vertices);
  return Array.from(att.vertices);
}

function serializeSkin(skin, slots, sd) {
  const json = { name: skin.name };
  if (skin.bones && skin.bones.length) json.bones = skin.bones.map(b => b.name);
  const ik = [], tr = [], pa = [], ph = [];
  for (const c of skin.constraints) {
    const n = c.name;
    if (c.constructor.name === 'IkConstraintData') ik.push(n);
    else if (c.constructor.name === 'TransformConstraintData') tr.push(n);
    else if (c.constructor.name === 'PathConstraintData') pa.push(n);
    else if (c.constructor.name === 'PhysicsConstraintData') ph.push(n);
  }
  if (ik.length) json.ik = ik;
  if (tr.length) json.transform = tr;
  if (pa.length) json.path = pa;
  if (ph.length) json.physics = ph;
  const atts = {};
  for (let si = 0; si < slots.length; si++) {
    const dict = skin.attachments[si];
    if (!dict) continue;
    const slotName = slots[si].name;
    const slotAtts = {};
    for (const attName of Object.keys(dict)) {
      slotAtts[attName] = serializeAttachment(dict[attName], attName, sd);
    }
    if (Object.keys(slotAtts).length) atts[slotName] = slotAtts;
  }
  if (Object.keys(atts).length) json.attachments = atts;
  return json;
}

function serializeAnimation(name, anim, sd) {
  const out = {};
  for (const tl of anim.timelines) {
    if (tl.boneIndex !== undefined) {
      const boneName = sd.bones[tl.boneIndex].name;
      out.bones = out.bones || {};
      out.bones[boneName] = out.bones[boneName] || {};
      const t = out.bones[boneName];
      if (tl instanceof RotateTimeline) t.rotate = curveFrames(tl, 'value');
      else if (tl instanceof TranslateTimeline) t.translate = curveFrames(tl, ['x', 'y']);
      else if (tl instanceof TranslateXTimeline) t.translatex = curveFrames(tl, 'value');
      else if (tl instanceof TranslateYTimeline) t.translatey = curveFrames(tl, 'value');
      else if (tl instanceof ScaleTimeline) t.scale = curveFrames(tl, ['x', 'y']);
      else if (tl instanceof ScaleXTimeline) t.scalex = curveFrames(tl, 'value');
      else if (tl instanceof ScaleYTimeline) t.scaley = curveFrames(tl, 'value');
      else if (tl instanceof ShearTimeline) t.shear = curveFrames(tl, ['x', 'y']);
      else if (tl instanceof ShearXTimeline) t.shearx = curveFrames(tl, 'value');
      else if (tl instanceof ShearYTimeline) t.sheary = curveFrames(tl, 'value');
      else if (tl instanceof InheritTimeline) t.inherit = inheritFrames(tl);
      else throw new Error(`Unhandled bone timeline ${tl.constructor.name} for ${boneName}`);
    } else if (tl.slotIndex !== undefined) {
      const slotName = sd.slots[tl.slotIndex].name;
      out.slots = out.slots || {};
      out.slots[slotName] = out.slots[slotName] || {};
      const t = out.slots[slotName];
      if (tl instanceof AttachmentTimeline) t.attachment = attachmentFrames(tl);
      else if (tl instanceof RGBATimeline) t.rgba = colorFrameProps(tl, 'color', null);
      else if (tl instanceof RGBTimeline) t.rgb = colorFrameProps(tl, 'color', null);
      else if (tl instanceof AlphaTimeline) t.alpha = curveFrames(tl, 'value');
      else if (tl instanceof RGBA2Timeline) t.rgba2 = colorFrameProps(tl, 'light', 'dark');
      else if (tl instanceof RGB2Timeline) t.rgb2 = colorFrameProps(tl, 'light', 'dark');
      else if (tl instanceof DeformTimeline) {
        const skinName = findSkinForAttachment(sd, tl);
        out.attachments = out.attachments || {};
        out.attachments[skinName] = out.attachments[skinName] || {};
        out.attachments[skinName][slotName] = out.attachments[skinName][slotName] || {};
        const key = tl.attachment.name;
        out.attachments[skinName][slotName][key] = out.attachments[skinName][slotName][key] || {};
        out.attachments[skinName][slotName][key].deform = deformFrames(tl);
      } else if (tl instanceof SequenceTimeline) {
        const skinName = findSkinForAttachment(sd, tl);
        out.attachments = out.attachments || {};
        out.attachments[skinName] = out.attachments[skinName] || {};
        out.attachments[skinName][slotName] = out.attachments[skinName][slotName] || {};
        const key = tl.attachment.name;
        out.attachments[skinName][slotName][key] = out.attachments[skinName][slotName][key] || {};
        out.attachments[skinName][slotName][key].sequence = sequenceFrames(tl);
      } else throw new Error(`Unhandled slot timeline ${tl.constructor.name} for ${slotName}`);
    } else if (tl.constraintIndex !== undefined) {
      if (tl instanceof IkConstraintTimeline) {
        const cName = sd.ikConstraints[tl.constraintIndex].name;
        out.ik = out.ik || {};
        out.ik[cName] = ikFrames(tl);
      } else if (tl instanceof TransformConstraintTimeline) {
        const cName = sd.transformConstraints[tl.constraintIndex].name;
        out.transform = out.transform || {};
        out.transform[cName] = transformFrames(tl);
      } else if (tl instanceof PathConstraintPositionTimeline) {
        const cName = sd.pathConstraints[tl.constraintIndex].name;
        out.path = out.path || {};
        out.path[cName] = out.path[cName] || {};
        out.path[cName].position = curveFrames(tl, 'value');
      } else if (tl instanceof PathConstraintSpacingTimeline) {
        const cName = sd.pathConstraints[tl.constraintIndex].name;
        out.path = out.path || {};
        out.path[cName] = out.path[cName] || {};
        out.path[cName].spacing = curveFrames(tl, 'value');
      } else if (tl instanceof PathConstraintMixTimeline) {
        const cName = sd.pathConstraints[tl.constraintIndex].name;
        out.path = out.path || {};
        out.path[cName] = out.path[cName] || {};
        out.path[cName].mix = pathMixFrames(tl);
      } else if (tl instanceof PhysicsConstraintResetTimeline) {
        const cName = sd.physicsConstraints[tl.constraintIndex] ? sd.physicsConstraints[tl.constraintIndex].name : '';
        out.physics = out.physics || {};
        out.physics[cName] = out.physics[cName] || {};
        out.physics[cName].reset = Array.from(tl.frames).map(t => ({ time: t }));
      } else {
        const prop = physicsTimelineProp(tl.constructor);
        if (!prop) throw new Error(`Unhandled constraint timeline ${tl.constructor.name}`);
        const cName = sd.physicsConstraints[tl.constraintIndex] ? sd.physicsConstraints[tl.constraintIndex].name : '';
        out.physics = out.physics || {};
        out.physics[cName] = out.physics[cName] || {};
        out.physics[cName][prop] = curveFrames(tl, 'value');
      }
    } else if (tl instanceof EventTimeline) {
      out.events = eventFrames(tl);
    } else if (tl instanceof DrawOrderTimeline) {
      out.drawOrder = drawOrderFrames(tl, sd);
    } else {
      throw new Error(`Unhandled timeline ${tl.constructor.name}`);
    }
  }
  return out;
}

function physicsTimelineProp(tlClass) {
  if (tlClass === PhysicsConstraintInertiaTimeline) return 'inertia';
  if (tlClass === PhysicsConstraintStrengthTimeline) return 'strength';
  if (tlClass === PhysicsConstraintDampingTimeline) return 'damping';
  if (tlClass === PhysicsConstraintMassTimeline) return 'mass';
  if (tlClass === PhysicsConstraintWindTimeline) return 'wind';
  if (tlClass === PhysicsConstraintGravityTimeline) return 'gravity';
  if (tlClass === PhysicsConstraintMixTimeline) return 'mix';
  return null;
}

function deformFrames(tl) {
  const fc = tl.getFrameCount();
  const frames = tl.frames;
  const curves = tl.curves;
  const out = [];
  for (let f = 0; f < fc; f++) {
    const frame = { time: frames[f] };
    const verts = tl.vertices[f];
    if (verts && verts.length) {
      const nonZero = verts.some(v => v !== 0);
      if (nonZero) {
        let offset = 0;
        while (offset < verts.length && verts[offset] === 0) offset++;
        frame.vertices = Array.from(verts.slice(offset));
        if (offset) frame.offset = offset;
      }
    }
    if (f < fc - 1) {
      const ct = curves[f];
      if (ct === 1) frame.curve = 'stepped';
      else if (ct >= 2) {
        const chainBase = ct - 2;
        const t0 = frames[f], t3 = frames[f + 1];
        const pts = [];
        for (let k = 0; k < 9; k++) pts.push([curves[chainBase + k * 2], curves[chainBase + k * 2 + 1]]);
        // deform curve: percent domain 0..1
        frame.curve = fitBezier(pts, t0, t3, 0, 1);
      }
    }
    out.push(frame);
  }
  return out;
}

function sequenceFrames(tl) {
  const frames = tl.frames;
  const out = [];
  let lastDelay = 0;
  const modeNames = ['hold', 'once', 'loop', 'pingpong', 'onceReverse', 'loopReverse', 'pingpongReverse'];
  for (let f = 0; f < frames.length / 3; f++) {
    const i = f * 3;
    const frame = { time: frames[i] };
    const modeIndex = frames[i + 1];
    frame.mode = modeNames[modeIndex & 15];
    const index = modeIndex >> 4;
    if (index !== 0) frame.index = index;
    const delay = frames[i + 2];
    if (delay !== lastDelay) frame.delay = delay;
    lastDelay = delay;
    out.push(frame);
  }
  return out;
}

function drawOrderFrames(tl, sd) {
  const slotNames = sd.slots.map(s => s.name);
  const fc = tl.getFrameCount();
  const out = [];
  for (let f = 0; f < fc; f++) {
    const frame = { time: tl.frames[f] };
    const drawOrder = tl.drawOrders[f];
    if (drawOrder) {
      const posOf = {};
      for (let i = 0; i < drawOrder.length; i++) posOf[drawOrder[i]] = i;
      const moved = [];
      for (let s = 0; s < slotNames.length; s++) if (posOf[s] !== s) moved.push(s);
      if (moved.length) {
        frame.offsets = moved.map(s => ({ slot: slotNames[s], offset: posOf[s] - s }));
      }
    }
    out.push(frame);
  }
  return out;
}

function findSkinForAttachment(sd, tl) {
  const slotIndex = tl.slotIndex;
  for (const skin of sd.skins) {
    const dict = skin.attachments[slotIndex];
    if (!dict) continue;
    for (const name of Object.keys(dict)) {
      if (dict[name] === tl.attachment || (dict[name] && dict[name].name === tl.attachment.name && tl.attachment.name === name)) {
        return skin.name;
      }
    }
  }
  return sd.defaultSkin ? sd.defaultSkin.name : 'default';
}

function serializeBone(b) {
  const map = { name: b.name };
  if (b.parent) map.parent = b.parent.name;
  if (b.length !== 0) map.length = b.length;
  if (b.x !== 0) map.x = b.x;
  if (b.y !== 0) map.y = b.y;
  if (b.rotation !== 0) map.rotation = b.rotation;
  if (b.scaleX !== 1) map.scaleX = b.scaleX;
  if (b.scaleY !== 1) map.scaleY = b.scaleY;
  if (b.shearX !== 0) map.shearX = b.shearX;
  if (b.shearY !== 0) map.shearY = b.shearY;
  if (b.inherit !== 0) map.inherit = ['Normal', 'OnlyTranslation', 'NoRotationOrReflection', 'NoScale', 'NoScaleOrReflection'][b.inherit];
  if (b.skinRequired) map.skin = true;
  if (b.color && !isZero(b.color)) map.color = colorHex(b.color);
  return map;
}

function serializeSlot(s, boneByName) {
  const map = { name: s.name, bone: s.boneData.name };
  if (s.color && !isWhite(s.color)) map.color = colorHex(s.color);
  if (s.darkColor) map.dark = colorHex(s.darkColor);
  if (s.attachmentName) map.attachment = s.attachmentName;
  if (s.blendMode !== 0) map.blend = ['normal', 'additive', 'multiply', 'screen'][s.blendMode];
  if (!s.visible) map.visible = false;
  return map;
}

function serializeIk(c) {
  const map = { name: c.name };
  if (c.order !== 0) map.order = c.order;
  map.bones = c.bones.map(b => b.name);
  map.target = c.target.name;
  if (c.mix !== 1) map.mix = c.mix;
  if (c.softness !== 0) map.softness = c.softness;
  if (c.bendDirection < 0) map.bendPositive = false;
  if (c.compress) map.compress = true;
  if (c.stretch) map.stretch = true;
  if (c.uniform) map.uniform = true;
  return map;
}

function serializeTransform(c) {
  const map = { name: c.name };
  if (c.order !== 0) map.order = c.order;
  map.bones = c.bones.map(b => b.name);
  map.target = c.target.name;
  if (c.local) map.local = true;
  if (c.relative) map.relative = true;
  if (c.offsetRotation !== 0) map.rotation = c.offsetRotation;
  if (c.offsetX !== 0) map.x = c.offsetX;
  if (c.offsetY !== 0) map.y = c.offsetY;
  if (c.offsetScaleX !== 0) map.scaleX = c.offsetScaleX;
  if (c.offsetScaleY !== 0) map.scaleY = c.offsetScaleY;
  if (c.offsetShearY !== 0) map.shearY = c.offsetShearY;
  if (c.mixRotate !== 1) map.mixRotate = c.mixRotate;
  if (c.mixX !== 1) map.mixX = c.mixX;
  if (c.mixY !== 1) map.mixY = c.mixY;
  if (c.mixScaleX !== 1) map.mixScaleX = c.mixScaleX;
  if (c.mixScaleY !== 1) map.mixScaleY = c.mixScaleY;
  if (c.mixShearY !== 1) map.mixShearY = c.mixShearY;
  return map;
}

function serializePath(c) {
  const map = { name: c.name };
  if (c.order !== 0) map.order = c.order;
  map.bones = c.bones.map(b => b.name);
  map.target = c.target.name;
  if (c.positionMode !== 0) map.positionMode = ['Fixed', 'Percent'][c.positionMode];
  if (c.spacingMode !== 1) map.spacingMode = ['Length', 'Fixed', 'Percent'][c.spacingMode];
  if (c.rotateMode !== 1) map.rotateMode = ['Tangent', 'Chain', 'ChainScale'][c.rotateMode];
  if (c.offsetRotation !== 0) map.rotation = c.offsetRotation;
  if (c.position !== 0) map.position = c.position;
  if (c.spacing !== 0) map.spacing = c.spacing;
  if (c.mixRotate !== 1) map.mixRotate = c.mixRotate;
  if (c.mixX !== 1) map.mixX = c.mixX;
  if (c.mixY !== 1) map.mixY = c.mixY;
  return map;
}

function serializePhysics(c) {
  const map = { name: c.name };
  if (c.order !== 0) map.order = c.order;
  map.bone = c.bone.name;
  if (c.x !== 0) map.x = c.x;
  if (c.y !== 0) map.y = c.y;
  if (c.rotate !== 0) map.rotate = c.rotate;
  if (c.scaleX !== 0) map.scaleX = c.scaleX;
  if (c.shearX !== 0) map.shearX = c.shearX;
  if (c.limit !== 5000) map.limit = c.limit;
  if (c.step !== 0 && c.step !== 1 / 60) map.fps = Math.round(1 / c.step);
  if (c.inertia !== 1) map.inertia = c.inertia;
  if (c.strength !== 100) map.strength = c.strength;
  if (c.damping !== 1) map.damping = c.damping;
  if (c.massInverse !== 0 && c.massInverse !== 1) map.mass = 1 / c.massInverse;
  if (c.wind !== 0) map.wind = c.wind;
  if (c.gravity !== 0) map.gravity = c.gravity;
  if (c.mix !== 1) map.mix = c.mix;
  if (c.inertiaGlobal) map.inertiaGlobal = true;
  if (c.strengthGlobal) map.strengthGlobal = true;
  if (c.dampingGlobal) map.dampingGlobal = true;
  if (c.massGlobal) map.massGlobal = true;
  if (c.windGlobal) map.windGlobal = true;
  if (c.gravityGlobal) map.gravityGlobal = true;
  if (c.mixGlobal) map.mixGlobal = true;
  return map;
}

function serializeEventData(e) {
  const map = {};
  if (e.intValue !== 0) map.int = e.intValue;
  if (e.floatValue !== 0) map.float = e.floatValue;
  if (e.stringValue != null) map.string = e.stringValue;
  if (e.audioPath) {
    map.audio = e.audioPath;
    if (e.volume !== 1) map.volume = e.volume;
    if (e.balance !== 0) map.balance = e.balance;
  }
  return map;
}

export function skeletonDataToJson(sd) {
  const root = {};
  const skeleton = {};
  if (sd.hash) skeleton.hash = sd.hash;
  if (sd.version) skeleton.spine = sd.version;
  if (sd.x !== 0) skeleton.x = sd.x;
  if (sd.y !== 0) skeleton.y = sd.y;
  if (sd.width !== 0) skeleton.width = sd.width;
  if (sd.height !== 0) skeleton.height = sd.height;
  if (sd.referenceScale !== 100) skeleton.referenceScale = sd.referenceScale;
  if (sd.fps !== 0) skeleton.fps = sd.fps;
  if (sd.imagesPath) skeleton.images = sd.imagesPath;
  if (sd.audioPath) skeleton.audio = sd.audioPath;
  if (Object.keys(skeleton).length) root.skeleton = skeleton;

  if (sd.bones.length) root.bones = sd.bones.map(serializeBone);
  if (sd.slots.length) root.slots = sd.slots.map(s => serializeSlot(s));
  if (sd.ikConstraints.length) root.ik = sd.ikConstraints.map(serializeIk);
  if (sd.transformConstraints.length) root.transform = sd.transformConstraints.map(serializeTransform);
  if (sd.pathConstraints.length) root.path = sd.pathConstraints.map(serializePath);
  if (sd.physicsConstraints.length) root.physics = sd.physicsConstraints.map(serializePhysics);

  if (sd.skins.length) root.skins = sd.skins.map(skin => serializeSkin(skin, sd.slots, sd));

  if (sd.events.length) {
    root.events = {};
    for (const e of sd.events) root.events[e.name] = serializeEventData(e);
  }

  if (sd.animations.length) {
    root.animations = {};
    for (const a of sd.animations) root.animations[a.name] = serializeAnimation(a.name, a, sd);
  }
  return root;
}
