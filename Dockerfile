# ---- Build stage ----
# Use full node image (not slim) for native addon compilation (better-sqlite3)
FROM node:22 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ---- Runtime stage ----
FROM node:22-slim AS runtime

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist/ ./dist/
COPY licenses/ ./licenses/

# The relay never starts a CLI or executes caller tools.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV PORT=3456
EXPOSE 3456

VOLUME /app/data

CMD ["node", "dist/server.js"]

# Optional official CLI for interactive login only; never used for inference.
FROM runtime AS cli-auth
USER root
ARG CLAUDE_CODE_VERSION=2.1.318
RUN npm install --global @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && claude --version \
    && mkdir -p /home/node/.claude \
    && chown node:node /home/node/.claude \
    && chmod 700 /home/node/.claude
COPY --chmod=755 bin/claude-auth /usr/local/bin/claude-auth
ENV CLAUDE_CONFIG_DIR=/home/node/.claude \
    UPSTREAM_AUTH_SOURCE=claude_cli \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
USER node
VOLUME /home/node/.claude

# Keep plain docker build behavior unchanged. Opt in with --target cli-auth.
FROM runtime AS default
