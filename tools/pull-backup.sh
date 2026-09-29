#!/usr/bin/env bash
# pull-backup.sh — v33 异地备份：从服务器拉取最新备份到本地（异地副本，防服务器磁盘故障）
# 用法：Git Bash 里执行 bash tools/pull-backup.sh
set -e

KEY="C:/Users/Administrator/.ssh/id_flychess"
HOST="root@129.211.29.228"
REMOTE_DIR="/opt/flychess-data/backups"
LOCAL_DIR="$(dirname "$0")/../backups-local"

LATEST=$(ssh -i "$KEY" -o StrictHostKeyChecking=no -o BatchMode=yes "$HOST" "ls $REMOTE_DIR | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}\$' | sort | tail -1")
if [ -z "$LATEST" ]; then echo "✗ 服务器上没有备份"; exit 1; fi

mkdir -p "$LOCAL_DIR/$LATEST"
scp -i "$KEY" -o StrictHostKeyChecking=no -q "$HOST:$REMOTE_DIR/$LATEST/*" "$LOCAL_DIR/$LATEST/"
echo "==> 已拉取 $LATEST 到 backups-local/$LATEST"

# 本地验证（复用 verify-backup 逻辑的精简版）
node -e "
const fs = require('fs'), path = require('path');
const dir = path.resolve('$LOCAL_DIR/$LATEST');
let fail = 0;
['stats.json', 'meta.json', 'rooms.json'].forEach((f) => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const extra = f === 'stats.json' ? ' 玩家 ' + Object.keys(raw.players || {}).length : '';
    console.log('  ✓ ' + f + extra);
  } catch (e) { fail++; console.log('  ✗ ' + f + ' 解析失败: ' + e.message); }
});
console.log(fail ? '✗ 异地备份验证失败' : '✅ 异地备份完好');
process.exitCode = fail ? 1 : 0;
"

# 只保留本地最近 7 份，防本地膨胀
ls "$LOCAL_DIR" | grep -E '^[0-9]{4}-' | sort | head -n -7 | while read -r old; do rm -rf "$LOCAL_DIR/$old"; done
echo "==> 本地保留最近 7 份"
