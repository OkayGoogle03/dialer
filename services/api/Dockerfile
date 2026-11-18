# API image for Cloudflare Containers. Build context is the REPOSITORY ROOT (see wrangler.jsonc image_build_context).
FROM node:22-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=development
RUN npm install -g pnpm@12.8.1
WORKDIR /app

# Dependency layer: manifests only, so source edits do not reinstall packages.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/validation/package.json packages/validation/
COPY packages/event-schemas/package.json packages/event-schemas/
COPY packages/ui/package.json packages/ui/
COPY services/api/package.json services/api/
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY services/api services/api
RUN pnpm --filter @dialer/shared-types --filter @dialer/validation --filter @dialer/event-schemas build \
 && pnpm --filter @dialer/api build

ENV NODE_ENV=production \
    PORT=3000
USER node
EXPOSE 3000
CMD ["node", "services/api/dist/main.js"]
