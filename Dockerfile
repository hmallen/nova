# Nova — zero dependencies, so this is copy-and-run: no npm install, no
# lockfile, no build stage.
FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
COPY lib ./lib
COPY public ./public
# Pre-create the store dir owned by the runtime user so a keyless
# `docker run` (no volume) works too. Named volumes inherit this ownership;
# bind mounts don't — see README.
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production
EXPOSE 3000
VOLUME /app/data
USER node
CMD ["node", "server.js"]
