FROM node:20-alpine

WORKDIR /app

# Copy root workspace manifests (lockfile lives here)
COPY package.json package-lock.json ./

# Copy workspace package manifest (so npm can resolve workspace)
COPY apps/api/package.json apps/api/package.json

# Install deps for ONLY this workspace (but using root lockfile)
RUN npm ci -w @cliniq/api

# Now copy the actual API code
COPY apps/api apps/api

WORKDIR /app/apps/api

ENV NODE_ENV=production
EXPOSE 8787

CMD ["npm", "run", "start"]
