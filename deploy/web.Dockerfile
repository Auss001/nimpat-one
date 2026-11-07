# Builds the customer app or the staff dashboard into a small web server for Cloud Run.
#   docker build -f deploy/web.Dockerfile --build-arg APP_DIR=app .
FROM node:24-bookworm-slim AS build
ARG APP_DIR=app
ARG VITE_APP_URL=
WORKDIR /web
COPY ${APP_DIR}/package.json ${APP_DIR}/package-lock.json ./
RUN npm ci
COPY ${APP_DIR}/ ./
RUN VITE_APP_URL=${VITE_APP_URL} npm run build

FROM nginx:1.29-alpine
COPY deploy/web.nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /web/dist /usr/share/nginx/html
ENV PORT=8080
EXPOSE 8080
