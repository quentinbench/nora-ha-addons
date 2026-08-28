# Dockerfile de l'add-on Home Assistant "MyStock Network Agent".
# (Pour un déploiement Docker standalone hors HA, voir Dockerfile.agent + docker-compose.agent.yml.)
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# mutool (mupdf-tools) : rastérisation PDF → PWG-Raster pour les imprimantes AirPrint raster-only
# (Brother HL-Lxxxx…) qui n'interprètent pas le PDF (sinon → pages blanches).
RUN apk add --no-cache mupdf-tools
COPY package*.json ./
RUN npm install --omit=dev || true
COPY --from=build /app/dist ./dist
# La config est lue depuis les options de l'add-on (/data/options.json) par l'agent.
CMD ["node", "dist/agent.js"]
