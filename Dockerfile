# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=22.21.1
ARG MONGODB_DATABASE_TOOLS_VERSION=100.14.1
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

# Node.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Install node modules
COPY package-lock.json package.json ./
RUN npm ci

# Copy application code
COPY . .


# Final stage for app image
FROM base

ARG MONGODB_DATABASE_TOOLS_VERSION

RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y ca-certificates curl && \
    curl -fsSL -o /tmp/mongodb-database-tools.deb "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-debian12-x86_64-${MONGODB_DATABASE_TOOLS_VERSION}.deb" && \
    apt-get install --no-install-recommends -y /tmp/mongodb-database-tools.deb && \
    rm -f /tmp/mongodb-database-tools.deb && \
    rm -rf /var/lib/apt/lists/*

# Copy built application
COPY --from=build /app /app

# Start the server by default, this can be overwritten at runtime
EXPOSE 5000
CMD [ "npm", "run", "start" ]
