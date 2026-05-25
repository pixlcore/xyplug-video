FROM node:24-trixie-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      procps \
      lsof \
      iproute2 && \
    rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY index.js ./

RUN npm install --omit=dev
RUN npm install -g @pixlcore/xyrun

CMD ["xyrun", "node", "index.js"]
