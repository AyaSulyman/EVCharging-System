# Multi-stage Dockerfile for backend (Next.js API service)
# Builds with all deps (typescript needed), then creates a slim runtime image.

# Build stage
FROM node:18-alpine AS builder
WORKDIR /app
# Install tools required for some native deps / installs
RUN apk add --no-cache python3 make g++ bash

# Copy package manifests and install
COPY backend/package.json backend/package-lock.json* backend/yarn.lock* ./backend/
WORKDIR /app/backend
# Prefer npm ci if package-lock.json present; fallback to npm install
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy source and build
COPY backend/ .
RUN npm run build

# Production stage
FROM node:18-alpine AS runner
WORKDIR /app/backend
# Create non-root user
RUN addgroup -S chargehub && adduser -S chargehub -G chargehub
# Copy only runtime files from builder
COPY --from=builder /app/backend/.next ./.next
COPY --from=builder /app/backend/public ./public
COPY --from=builder /app/backend/package.json ./package.json
COPY --from=builder /app/backend/node_modules ./node_modules
# Copy other files needed at runtime (e.g., scripts)
COPY --from=builder /app/backend/src ./src

ENV NODE_ENV=production
EXPOSE 4000

USER chargehub
CMD ["npm", "start"]