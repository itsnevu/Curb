FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/gateway ./apps/gateway
# The lockfile is authoritative: a build that silently resolves different versions than
# the ones tested is not the thing that was tested.
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @curb/shared --filter @curb/policy-engine --filter @curb/gateway build
# Drop dev dependencies (typescript, vitest, …) before they are copied into the runtime.
# why not `pnpm prune --prod`: it rejects --filter, and unfiltered it prompts
# for confirmation — a build that hangs on a TTY question is not a build.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
      --config.confirmModulesPurge=false

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app ./
# Never run a network-facing proxy as root.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/gateway/dist/index.js"]
