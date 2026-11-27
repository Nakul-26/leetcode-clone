# The sandbox agent (cmd/judge-agent, docs/judge/JUDGE_AGENT_PLAN.md Phase 2), built from the
# judge's own source: the build context is judge-service-go/ (see the docker-compose files).
FROM golang:alpine AS judge-agent
WORKDIR /src
COPY go.mod go.sum ./
COPY pkg/agentproto ./pkg/agentproto
COPY cmd/judge-agent ./cmd/judge-agent
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /judge-agent ./cmd/judge-agent

FROM python:3.10-alpine

# Precompile the standard library. The official image ships it without .pyc files, and the
# sandbox's root filesystem is read-only, so every run compiled each module it imported from
# source: ~110 ms per Python start for the wrapper's usual imports (138 -> 25 ms measured on
# deploy2, 2026-11-22). +27 MB.
RUN python -m compileall -q /usr/local/lib/python3.10 || true

# Create a non-root user 'judge'
RUN addgroup --system judge && adduser --system --ingroup judge judge

# Set the user
# Root-owned and on the read-only root filesystem: no submission can change it.
COPY --from=judge-agent /judge-agent /usr/local/bin/judge-agent

USER judge
