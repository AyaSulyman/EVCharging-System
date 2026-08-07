# Multi-stage Dockerfile for frontend (Next.js App Router)
FROM node:18-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++ bash

# copy package files from the frontend build context (./frontend)
COPY package*.json yarn.lock* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# copy the rest of the frontend source from the context
COPY . .
RUN npm run build

FROM node:18-alpine AS runner
WORKDIR /app
RUN addgroup -S chargehub && adduser -S chargehub -G chargehub

# copy runtime assets from builder
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/app ./app

ENV NODE_ENV=production
EXPOSE 3000

USER chargehub
CMD ["npm", "start"]