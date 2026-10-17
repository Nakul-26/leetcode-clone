# Dockerfile (multi-stage) - production-ready
# Builder stage
FROM golang:alpine AS builder

# Install any native deps needed for build (if using CGO)
RUN apk add --no-cache build-base git

WORKDIR /src
ENV CGO_ENABLED=0
ENV GOFLAGS="-mod=mod"

# Cache dependencies
COPY go.mod go.sum ./
RUN go mod download

# Copy source and build
COPY . .
RUN --mount=type=cache,target=/root/.cache/go-build \
    go build -ldflags="-s -w" -o /out/go-judge-service .

# Dev stage - used only by docker-compose.yml (target: dev).
#
# Deliberately placed BEFORE the runtime stage. A multi-stage build defaults to the
# LAST stage, so appending this at the end would silently make a plain `docker build`
# - and production, which pins no target - build the dev image instead.
#
# This exists because the previous dev setup could never have worked.
# docker-compose.yml carried `command: sh -c "go build ... && ./tmp/..."`, but the
# runtime stage declares an exec-form ENTRYPOINT, so Docker passed that command as
# *arguments* to the Go binary instead of running it: the container served the
# image-baked binary and silently ignored every local source edit. Even had it run,
# the runtime stage is alpine with no Go toolchain. This stage keeps the toolchain
# and declares no ENTRYPOINT, so the CMD below (or a compose override) really runs.
#
# WORKDIR is /src, where compose bind-mounts the source. That also keeps
# wrapper.GenerateWrapper working: it resolves templates relative to the working
# directory ("pkg/wrappers/..."), which the mount supplies. The runtime stage copies
# those templates to /app and sets WORKDIR /app for the same reason.
FROM golang:alpine AS dev
RUN apk add --no-cache build-base git ca-certificates tzdata wget
WORKDIR /src
ENV CGO_ENABLED=0
ENV GOFLAGS="-mod=mod"
# Pre-populate the module cache so the first in-container build does not re-download.
COPY go.mod go.sum ./
RUN go mod download
RUN mkdir -p /out
EXPOSE 8081
# Rebuild from the bind-mounted source on every container start, so `docker compose
# restart judge-service-go` picks up local edits. Output goes to /out, never /src or
# /tmp: /src is the repo (a build artefact there would show up in git status) and
# /tmp is bind-mounted from the host in docker-compose.yml.
CMD ["sh", "-c", "go build -o /out/go-judge-service . && exec /out/go-judge-service"]

# Runtime stage (small)
FROM alpine:3.19 AS runtime
RUN apk add --no-cache ca-certificates tzdata wget
# Create a non-root user
RUN addgroup -S app && adduser -S -G app app

COPY --from=builder /out/go-judge-service /usr/local/bin/go-judge-service
COPY --from=builder /src/pkg/wrappers /app/pkg/wrappers
RUN chown app:app /usr/local/bin/go-judge-service
RUN chown -R app:app /app/pkg/wrappers

USER app
WORKDIR /app

ENV APP_ENV=production
EXPOSE 8081

ENTRYPOINT ["/usr/local/bin/go-judge-service"]

