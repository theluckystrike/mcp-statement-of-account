# Build context: repository root (monorepo with npm workspaces).
# docker buildx build -f servers/statement-of-account/Dockerfile .
#
# Four siblings are copied and built too, because this server is assembled from them:
# mcp-invoice supplies the invoice ledger, the money formatting and the corrupt-store
# quarantine, mcp-billing-docs the credit note store and the A4 renderer, mcp-deposits the
# deposit store, mcp-quotes the timezone-aware "today". They are read at run time from the
# shared data directory; nothing is fetched over the network.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
COPY packages ./packages
COPY servers ./servers
RUN npm install --no-audit --no-fund \
 && npm run build --workspace @theluckystrike/mcp-timezone \
 && npm run build --workspace @theluckystrike/mcp-license \
 && npm run build --workspace @theluckystrike/mcp-invoice \
 && npm run build --workspace @theluckystrike/mcp-billing-docs \
 && npm run build --workspace @theluckystrike/mcp-quotes \
 && npm run build --workspace @theluckystrike/mcp-deposits \
 && npm run build --workspace @theluckystrike/mcp-statement-of-account

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/servers/timezone/package.json ./servers/timezone/package.json
COPY --from=build /app/servers/timezone/dist ./servers/timezone/dist
COPY --from=build /app/packages/mcp-license/package.json ./packages/mcp-license/package.json
COPY --from=build /app/packages/mcp-license/dist ./packages/mcp-license/dist
COPY --from=build /app/servers/invoice/package.json ./servers/invoice/package.json
COPY --from=build /app/servers/invoice/dist ./servers/invoice/dist
COPY --from=build /app/servers/billing-docs/package.json ./servers/billing-docs/package.json
COPY --from=build /app/servers/billing-docs/dist ./servers/billing-docs/dist
COPY --from=build /app/servers/quotes/package.json ./servers/quotes/package.json
COPY --from=build /app/servers/quotes/dist ./servers/quotes/dist
COPY --from=build /app/servers/deposits/package.json ./servers/deposits/package.json
COPY --from=build /app/servers/deposits/dist ./servers/deposits/dist
COPY --from=build /app/servers/statement-of-account/package.json ./servers/statement-of-account/package.json
COPY --from=build /app/servers/statement-of-account/dist ./servers/statement-of-account/dist
RUN npm install --omit=dev --no-audit --no-fund --workspace @theluckystrike/mcp-statement-of-account --include-workspace-root=false
CMD ["node", "servers/statement-of-account/dist/index.js"]
