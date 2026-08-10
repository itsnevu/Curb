FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY packages ./packages
COPY apps/control-plane ./apps/control-plane
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @curb/shared --filter @curb/policy-engine --filter @curb/control-plane build

FROM node:20-slim
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 8090
CMD ["node", "apps/control-plane/dist/index.js"]
