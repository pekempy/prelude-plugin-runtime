FROM node:24-bookworm-slim
WORKDIR /plugin
# Install deps if package.json has dependencies
COPY package.json ./
RUN npm install --omit=dev || true
# shared and plugin code are volume-mounted at runtime
EXPOSE 8083
CMD ["node", "index.js"]
