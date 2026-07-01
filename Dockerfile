# Envio HyperIndex runtime image for the Polygon PoS checkpoint indexer.
# Modeled on https://github.com/nodeify-eth/envio-test/blob/main/Dockerfile
#
# The data-nexus EnvioIndexer operator builds this via kaniko from the repo root.
# Node 22 is the newest LTS Envio officially supports.
FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Copy manifests first for layer caching. pnpm-workspace.yaml carries the
# esbuild build-script approval (allowBuilds), so it MUST be present before
# install or `pnpm codegen` fails with ERR_PNPM_IGNORED_BUILDS.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm codegen

ENV NODE_ENV=production

# 8080 = Hasura GraphQL API, 8081 = indexer health/metrics
EXPOSE 8080 8081

CMD ["pnpm", "start"]
