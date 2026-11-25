FROM node:24-bookworm-slim

WORKDIR /workspace
RUN npm install --global pnpm@11.25.0 \
    && mkdir -p /workspace \
    && chown node:node /workspace

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/api/package.json apps/api/package.json
COPY --chown=node:node apps/web/package.json apps/web/package.json
USER node

RUN pnpm install --frozen-lockfile

COPY --chown=node:node . .

EXPOSE 3000 5173
CMD ["pnpm", "dev", "--seed"]
