#!/usr/bin/env bash
# 飞行棋网页版 —— 一键部署到腾讯云
# 用法：Git Bash 里执行  bash deploy.sh
# 令牌不入库：ADMIN_TOKEN 从本地 .env.local（参考 .env.local.example）或环境变量读取
set -e

[ -f "$(dirname "$0")/.env.local" ] && source "$(dirname "$0")/.env.local"
ADMIN_TOKEN="${ADMIN_TOKEN:?缺少 ADMIN_TOKEN：请在项目根目录创建 .env.local（可复制 .env.local.example）或 export ADMIN_TOKEN=xxx}"

KEY="C:/Users/Administrator/.ssh/id_flychess"
HOST="root@129.211.29.228"
REMOTE_DIR="/opt/flychess"
DATA_DIR="/opt/flychess-data"   # 战绩/房间/回放的 JSON 落盘目录（宿主机，容器重建不丢；本宿主禁用 SQLite，一律 JSON 原子写）
TARBALL="/tmp/flychess-server.tar.gz"

echo "==> 1/5 打包 server/"
cd "$(dirname "$0")/server"
rm -f "$TARBALL"
tar -czf "$TARBALL" \
  --exclude=node_modules --exclude=data \
  --exclude=test-e2e.js --exclude=test-seat.js .

echo "==> 2/5 上传"
scp -i "$KEY" -o StrictHostKeyChecking=no "$TARBALL" "$HOST":/root/flychess-server.tar.gz

echo "==> 3/5 服务器解包"
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" "mkdir -p $REMOTE_DIR $DATA_DIR \
  && rm -rf $REMOTE_DIR/src $REMOTE_DIR/public $REMOTE_DIR/routes 2>/dev/null || true \
  && cd $REMOTE_DIR && tar -xzf /root/flychess-server.tar.gz -C $REMOTE_DIR"

echo "==> 4/5 docker build（node:24-alpine，首次拉镜像较慢）"
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" "cd $REMOTE_DIR \
  && docker build -t flychess:1.0 . 2>&1 | tail -8"

echo "==> 5/5 重启容器 + 冒烟"
# 80（免端口访问）+ 3000（保留）双映射；不用 nginx，直接绕开本宿主容器写不了 pid 的老问题
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" "docker rm -f flychess >/dev/null 2>&1 || true \
  && docker run -d --name flychess -p 80:3000 -p 3000:3000 \
     -v $DATA_DIR:/app/data -e AI_STEP_DELAY=700 -e ADMIN_TOKEN=${ADMIN_TOKEN} --restart unless-stopped \
     --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
     flychess:1.0 \
  && sleep 4 \
  && echo '--- health ---' && curl -s http://127.0.0.1/health \
  && echo && echo '--- stats ---' && curl -s 'http://127.0.0.1/api/stats/top?n=3' \
  && echo && echo '--- pve ---' && curl -s 'http://127.0.0.1/api/pve/levels?nick=smoke' | head -c 160 \
  && echo && echo '--- puzzle ---' && curl -s 'http://127.0.0.1/api/puzzle/today?nick=smoke' \
  && echo && echo '--- guild rank ---' && curl -s 'http://127.0.0.1/api/guild/rank' \
  && echo && echo '--- static ---' \
  && for p in / /js/app.js /js/board.js /js/i18n.js /js/qr.js /js/fx.js /css/style.css; do printf '%s ' \$p; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1\$p; done \
  && echo '--- v13 social/commercial ---' \
  && echo -n 'subscribe: ' && curl -s -X POST -H 'Content-Type: application/json' -d '{\"nick\":\"smoke\",\"type\":\"month\",\"token\":\"smoke-secret\"}' http://127.0.0.1/api/subscribe | head -c 90 \
  && echo && echo -n 'weekly: ' && curl -s 'http://127.0.0.1/api/weekly?nick=smoke' | head -c 90 \
  && echo && echo -n 'events: ' && curl -s 'http://127.0.0.1/api/events' | head -c 90 \
  && echo && echo -n 'guildWar: ' && curl -s 'http://127.0.0.1/api/guild/war' | head -c 90 \
  && echo && echo -n 'payCreate: ' && curl -s -X POST -H 'Content-Type: application/json' -d '{\"nick\":\"smoke\",\"product\":\"month\"}' http://127.0.0.1/api/pay/create | head -c 130 \
  && echo && echo -n 'dashboard: ' && curl -s "http://127.0.0.1/api/admin/dashboard?token=${ADMIN_TOKEN}" | head -c 130 \
  && echo && echo '--- v15 identity/gzip ---' \
  && echo -n 'health: ' && curl -s http://127.0.0.1/health | head -c 120 \
  && echo && echo -n 'adReward(认领+发放): ' && curl -s -X POST -H 'Content-Type: application/json' -d '{\"nick\":\"smoke\",\"kind\":\"coin\",\"token\":\"smoke-secret\"}' http://127.0.0.1/api/ad/reward | head -c 60 \
  && echo && echo -n 'adReward(间隔拦截): ' && curl -s -X POST -H 'Content-Type: application/json' -d '{\"nick\":\"smoke\",\"kind\":\"coin\",\"token\":\"smoke-secret\"}' http://127.0.0.1/api/ad/reward | head -c 60 \
  && echo && echo -n 'transfer(冒名应拒): ' && curl -s -X POST -H 'Content-Type: application/json' -d '{\"from\":\"smoke\",\"to\":\"x\",\"amount\":1,\"token\":\"wrong\"}' http://127.0.0.1/api/coins/transfer | head -c 60 \
  && echo && echo '--- v16 nick-owner/flood ---' \
  && echo -n 'create(正确凭证): ' && curl -s -X POST -H 'Content-Type: application/json' -d '{\"nickName\":\"smoke\",\"token\":\"smoke-secret\"}' http://127.0.0.1/api/rooms | head -c 40 \
  && sleep 3 && echo && echo -n 'create(冒名应拒 NICK_TAKEN): ' && curl -s -X POST -H 'Content-Type: application/json' -d '{\"nickName\":\"smoke\",\"token\":\"hacker\"}' http://127.0.0.1/api/rooms | head -c 60 \
  && echo && echo '--- v17 boards/hall ---' \
  && echo -n 'boards: ' && curl -s 'http://127.0.0.1/api/stats/boards?n=3' | head -c 100 \
  && echo && echo -n 'hall: ' && curl -s 'http://127.0.0.1/api/stats/hall' | head -c 120 \
  && echo && echo -n 'audit: ' && curl -s "http://127.0.0.1/api/admin/audit?token=${ADMIN_TOKEN}&n=3" | head -c 160 \
  && echo && echo '--- v18 mail ---' \
  && echo -n 'mail(smoke): ' && curl -s 'http://127.0.0.1/api/mail?nick=smoke' | head -c 100 \
  && echo && echo -n 'mailRead: ' && curl -s -X POST -H 'Content-Type: application/json' -d '{\"nick\":\"smoke\"}' http://127.0.0.1/api/mail/read | head -c 40 \
  && echo && echo '--- v21 tournament ---' \
  && echo -n 'tourState: ' && curl -s 'http://127.0.0.1/api/tournament?nick=smoke' | head -c 80   && echo && echo -n 'champions: ' && curl -s 'http://127.0.0.1/api/tournament/champions' | head -c 60   && echo && echo '--- v23 ops ---'   && echo -n 'metrics: ' && curl -s "http://127.0.0.1/api/admin/metrics?token=${ADMIN_TOKEN}" | head -c 140 \
  && echo \
  && echo '--- v13 static assets ---' \
  && for p in /manifest.webmanifest /icon.svg /sw.js; do printf '%s ' \$p; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1\$p; done \
  && echo '--- logs ---' && docker logs --tail 10 flychess"

echo "==> 完成：http://129.211.29.228 （80 端口，免端口号）"
