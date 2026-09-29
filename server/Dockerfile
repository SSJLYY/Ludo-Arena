# node:sqlite 需要 Node >= 22.5（24 起稳定），Node 20 无此模块，战绩持久化会直接崩
FROM node:24-alpine

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

# v33 容器健康检查：/health 返回 200 才算就绪（异常时 docker ps 直接显示 unhealthy）
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
