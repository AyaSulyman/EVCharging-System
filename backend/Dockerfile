# Multi-stage Dockerfile for backend (Next.js API service)
FROM node:18-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++ bash

# copy package manifests from the backend build context (./backend)
COPY package*.json yarn.lock* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# copy source and build (context is ./backend)
COPY . .
RUN npm run build

FROM node:18-alpine AS runner
WORKDIR /app
RUN addgroup -S chargehub && adduser -S chargehub -G chargehub

# copy runtime files from builder
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src

ENV NODE_ENV=production
EXPOSE 4000

USER chargehub
CMD ["npm", "start"]