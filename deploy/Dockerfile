# Two runtime targets, because the web service and the report worker have genuinely
# different needs. Measured from the previous single image: the Chromium + CJK font
# layer was 812 MB and node_modules was 563 MB, and the web service needs neither in
# full — it serves HTTP and streams already-encrypted PDFs, it never renders one.
# Only the worker runs Chromium, and only the worker executes the TypeScript scripts.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NOVA_DIST_DIR=.next
RUN npm run build

# ---- web ---------------------------------------------------------------------------
# Uses Next's standalone output, which is what next.config.ts already asks for with
# `output: "standalone"`. Running `next start` against a standalone build is the
# combination Next warns about, so this target runs server.js instead.
# No Chromium and no CJK fonts: the web service never renders a PDF.
FROM node:24-bookworm-slim AS web
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# The web service reads the private report directory to stream PDF downloads.
RUN mkdir -p /var/lib/nova/reports && chown -R node:node /var/lib/nova
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]

# ---- worker ------------------------------------------------------------------------
# Renders the PDFs, so it needs Chromium and the CJK fonts, and it runs the TypeScript
# scripts directly, so it keeps the full dependency tree and source. This stage is
# intentionally the same as the previous single-runtime image, which was verified end
# to end: it published reports and produced valid bilingual PDFs.
# Left last so a bare `docker build` produces the complete image.
FROM node:24-bookworm-slim AS worker
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV NOVA_DIST_DIR=.next
ENV NOVA_CHROMIUM_EXECUTABLE=/usr/bin/chromium
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/next.config.ts /app/tsconfig.json ./
RUN mkdir -p /var/lib/nova/reports && chown -R node:node /var/lib/nova
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
