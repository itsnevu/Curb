FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY packages ./packages
COPY apps/gateway ./apps/gateway
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @curb/shared --filter @curb/policy-engine --filter @curb/gateway build

FROM node:20-slim
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 8080
CMD ["node", "apps/gateway/dist/index.js"]
