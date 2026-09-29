/* inject-v34.js — 回放 gzip + 版本 v34（执行后删除） */
const fs = require('fs');
const path = require('path');

// 1) replays.js：gzip 存取（向后兼容旧纯 JSON 文件）
const rfile = path.join(__dirname, '..', 'server', 'src', 'replays.js');
let s = fs.readFileSync(rfile, 'utf8');
if (!s.includes('zlib')) {
  s = s.replace(`const fs = require('fs');
const path = require('path');`, `const fs = require('fs');
const path = require('path');
const zlib = require('zlib'); // v34 回放文件 gzip 落盘（省约 70% 磁盘）`);

  // saveReplay：写 gzip buffer
  const oldSave = "    const f = replayFile(roomNo);\n    fs.writeFileSync(f + '.tmp', JSON.stringify(payload));\n    fs.renameSync(f + '.tmp', f);";
  const newSave = "    const f = replayFile(roomNo);\n    fs.writeFileSync(f + '.tmp', zlib.gzipSync(Buffer.from(JSON.stringify(payload)))); // v34 gzip\n    fs.renameSync(f + '.tmp', f);";
  if (!s.includes(oldSave)) { console.error('SAVE MISS'); process.exit(1); }
  s = s.replace(oldSave, newSave);

  // getReplay：先试 gzip，再兼容旧纯 JSON
  const oldGet = "function getReplay(roomNo) {\n  try {\n    return JSON.parse(fs.readFileSync(replayFile(roomNo), 'utf8'));\n  } catch (e) {\n    return null;\n  }\n}";
  const newGet = "function getReplay(roomNo) {\n  try {\n    const buf = fs.readFileSync(replayFile(roomNo));\n    try {\n      return JSON.parse(zlib.gunzipSync(buf).toString('utf8')); // v34 gzip 格式\n    } catch (e) {\n      return JSON.parse(buf.toString('utf8')); // v34 前的旧纯 JSON 兼容\n    }\n  } catch (e) {\n    return null;\n  }\n}";
  if (!s.includes(oldGet)) { console.error('GET MISS'); process.exit(1); }
  s = s.replace(oldGet, newGet);
  fs.writeFileSync(rfile, s);
}

// 2) 版本 v34
const pub = path.join(__dirname, '..', 'server', 'public');
let sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
sw = sw.replace("const V = 'flychess-v33';", "const V = 'flychess-v34';");
fs.writeFileSync(path.join(pub, 'sw.js'), sw);
const idx = path.join(__dirname, '..', 'server', 'src', 'index.js');
idx = fs.readFileSync(idx, 'utf8').replace("version: 'v33', ts: Date.now(),", "version: 'v34', ts: Date.now(),");
fs.writeFileSync(path.join(__dirname, '..', 'server', 'src', 'index.js'), idx);
let ih = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
ih = ih.replace('版本 v33。设置自动保存', '版本 v34。设置自动保存');
fs.writeFileSync(path.join(pub, 'index.html'), ih);
const tid = path.join(__dirname, '..', 'tests', 'test-identity.js');
let tt = fs.readFileSync(tid, 'utf8');
tt = tt.replace("health.body.version === 'v33'", "health.body.version === 'v34'");
fs.writeFileSync(tid, tt);
console.log('v34 injected');
