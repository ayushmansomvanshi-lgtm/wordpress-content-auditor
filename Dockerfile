FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD ["npm", "start"]
