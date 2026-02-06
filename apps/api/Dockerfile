FROM node:20-alpine

WORKDIR /app

# Only copy manifests first (better caching)
COPY package.json package-lock.json ./
RUN npm ci

# Now copy source
COPY . .

# Build TS -> dist
RUN npm run build

# Remove dev deps for smaller image
RUN npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 8787

CMD ["npm", "run", "start"]
