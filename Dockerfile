FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY db ./db
COPY config ./config
COPY companies ./companies
USER node
EXPOSE 3000
CMD ["sh", "-c", "node scripts/migrate.ts && node src/server.ts"]
