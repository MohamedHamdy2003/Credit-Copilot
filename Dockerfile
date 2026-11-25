FROM node:24-bookworm-slim

WORKDIR /workspace
RUN npm install --global pnpm@11.25.0 \
    && mkdir -p /workspace \
    && chown node:node /workspace

COPY --chown=node:node . .
USER node

RUN pnpm install --frozen-lockfile

EXPOSE 3000 5173
CMD ["pnpm", "dev", "--seed"]
