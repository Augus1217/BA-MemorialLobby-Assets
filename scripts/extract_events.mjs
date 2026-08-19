import { SkeletonBinary, EventTimeline, TextureAtlas, AtlasAttachmentLoader } from '@esotericsoftware/spine-core';
import * as fs from 'fs';
import * as path from 'path';

const spineDir = process.argv[2] || '/home/augus/BA_MemorialLobbyElectron/assets/spine';
const targetLobbies = process.argv[3]?.split(',') || [];

function extractEvents(lobbyDir) {
  const files = fs.readdirSync(lobbyDir);
  const atlasFile = files.find(f => f.endsWith('.atlas') && !f.match(/_(1|2|3)\.atlas$/));
  if (!atlasFile) return null;

  let skelFile = files.find(f => f.endsWith('.skel') && !f.match(/_(1|2|3)\.skel$/)
    && !f.includes('_scene') && !f.includes('_bg'));
  let skelDir = lobbyDir;
  if (!skelFile) {
    for (const sub of files) {
      const subPath = path.join(lobbyDir, sub);
      try {
        if (fs.statSync(subPath).isDirectory()) {
          const subFiles = fs.readdirSync(subPath);
          const sf = subFiles.find(f => f.endsWith('.skel') && !f.match(/_(1|2|3)\.skel$/));
          if (sf) { skelFile = sf; skelDir = subPath; break; }
        }
      } catch {}
    }
  }
  if (!skelFile) return null;

  try {
    const atlasText = fs.readFileSync(path.join(lobbyDir, atlasFile), 'utf8');
    const atlas = new TextureAtlas(atlasText, { load: () => {} });
    const loader = new AtlasAttachmentLoader(atlas);
    const buf = fs.readFileSync(path.join(skelDir, skelFile));
    const binary = new SkeletonBinary(loader);
    binary.scale = 1;
    const skeletonData = binary.readSkeletonData(new Uint8Array(buf));

    const events = {};
    for (const anim of skeletonData.animations) {
      const animEvents = [];
      for (const timeline of anim.timelines) {
        if (timeline instanceof EventTimeline) {
          for (const ev of timeline.events) {
            const name = ev.data?.name || ev.name || '';
            animEvents.push({
              t: Math.round(ev.time * 10000) / 10000,
              name: name
            });
          }
        }
      }
      if (animEvents.length > 0) {
        events[anim.name] = animEvents;
      }
    }
    return Object.keys(events).length > 0 ? events : null;
  } catch (e) {
    console.error(`Error ${path.basename(lobbyDir)}: ${e.message}`);
    return null;
  }
}

const lobbies = targetLobbies.length
  ? targetLobbies
  : fs.readdirSync(spineDir).filter(f => fs.statSync(path.join(spineDir, f)).isDirectory());

const result = {};
for (const lobby of lobbies) {
  const lobbyDir = path.join(spineDir, lobby);
  if (!fs.existsSync(lobbyDir)) continue;
  const events = extractEvents(lobbyDir);
  if (events) {
    result[lobby] = events;
    const total = Object.values(events).reduce((s, e) => s + e.length, 0);
    console.error(`${lobby}: ${Object.keys(events).length} anims, ${total} events`);
  }
}

console.log(JSON.stringify(result));
