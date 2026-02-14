FROM node:24-alpine AS base

WORKDIR /app

# Сборка canvas (chartjs-node-canvas): node-gyp нужен Python и системные библиотеки
RUN apk add --no-cache \
    python3 make g++ \
    cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev pkgconfig

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

CMD ["node", "dist/main"]
