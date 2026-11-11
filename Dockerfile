# The headless server (examples/server) against a Neon database, or Postgres behind Neon's WebSocket proxy (docker-compose.yml runs one).
#   docker build -t understudy-server .
#   docker run -e DATABASE_URL=... -e UNDERSTUDY_API_KEY=... -e CLAUDE_SECRET_KEY=... -p 8787:8787 understudy-server
# Secrets are passed at run time with -e; none is baked into the image.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --workspaces --include-workspace-root

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/examples/server ./examples/server
USER node
EXPOSE 8787
CMD ["npm", "run", "start", "--workspace", "@jadd0/understudy-example-server"]
