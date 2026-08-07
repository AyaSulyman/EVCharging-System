# Multi-stage Dockerfile for frontend (Next.js App Router)
FROM node:18-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++ bash

COPY frontend/package.json frontend/package-lock.json* frontend/yarn.lock* ./frontend/
WORKDIR /app/frontend
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY frontend/ .
RUN npm run build

FROM node:18-alpine AS runner
WORKDIR /app/frontend
RUN addgroup -S chargehub && adduser -S chargehub -G chargehub

COPY --from=builder /app/frontend/.next ./.next
COPY --from=builder /app/frontend/public ./public
COPY --from=builder /app/frontend/package.json ./package.json
COPY --from=builder /app/frontend/node_modules ./node_modules
COPY --from=builder /app/frontend/src ./src
COPY --from=builder /app/frontend/app ./app

ENV NODE_ENV=production
EXPOSE 3000

USER chargehub
CMD ["npm", "start"]