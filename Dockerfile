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

# Model request transport never starts a CLI or executes caller tools.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV PORT=3456
EXPOSE 3456

VOLUME /app/data

CMD ["node", "dist/server.js"]

# Optional official CLI for login and scheduled token refresh; never inference.
FROM runtime AS cli-auth
USER root
ARG CLAUDE_CODE_VERSION=2.1.318
RUN npm install --global @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && claude --version \
    && command -v flock >/dev/null \
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

# Optional inference worker; plain HTTP images retain their dependency set.
FROM cli-auth AS cli-inference
USER root
COPY integration/cli-backend/package.json integration/cli-backend/package-lock.json /app/integration/cli-backend/
RUN npm ci --prefix /app/integration/cli-backend --omit=dev
COPY integration/cli-backend/worker.mjs integration/cli-backend/helpers.mjs /app/integration/cli-backend/
ENV CLAUDE_INFERENCE_BACKEND=cli \
    CLAUDE_CLI_WORKER_PATH=/app/integration/cli-backend/worker.mjs \
    CLAUDE_CLI_EXECUTABLE=/usr/local/bin/claude
USER node

# Keep plain docker build behavior unchanged. Opt in with --target cli-auth.
FROM runtime AS default
