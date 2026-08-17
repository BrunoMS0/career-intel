# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# Dependencies, cached on the lockfile alone so editing source does not reinstall.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# lib/db.ts throws at import when DATABASE_URL is unset, and `next build`
# imports it while collecting page data. postgres.js connects lazily, so this
# placeholder is never dialled -- it only has to exist. The real one arrives at
# run time from the environment.
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# `standalone` emits a server plus only the node_modules it traced, and it does
# not include the static assets -- those are copied separately, next to it.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/app/favicon.ico ./app/favicon.ico

USER node
EXPOSE 3000
CMD ["node", "server.js"]
