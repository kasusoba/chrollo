# ---- Build Stage ----
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

RUN pnpm build

# ---- Runtime Stage ----
FROM node:22-alpine AS runner

# exiftool-vendored ships a Perl-based exiftool on Linux
RUN apk add --no-cache perl

WORKDIR /app

# Copy deps and compiled output from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/index.js"]
