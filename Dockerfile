FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

ENV NODE_ENV=production
# Cloud Run injects PORT=8080; app reads process.env.PORT (see src/env.ts).
EXPOSE 8080

# Run migrate + seed against Supabase once before first traffic (not on every container start).
CMD ["node", "dist/src/server.js"]
