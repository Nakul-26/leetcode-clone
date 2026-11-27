# The sandbox agent (cmd/judge-agent, docs/judge/JUDGE_AGENT_PLAN.md Phase 2), built from the
# judge's own source: the build context is judge-service-go/ (see the docker-compose files).
FROM golang:alpine AS judge-agent
WORKDIR /src
COPY go.mod go.sum ./
COPY pkg/agentproto ./pkg/agentproto
COPY cmd/judge-agent ./cmd/judge-agent
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /judge-agent ./cmd/judge-agent

FROM node:20-alpine

# Install TypeScript and tsx
RUN npm install -g typescript tsx

# Create a non-root user 'judge'
RUN addgroup --system judge && adduser --system --ingroup judge judge

# Set the user
# Root-owned and on the read-only root filesystem: no submission can change it.
COPY --from=judge-agent /judge-agent /usr/local/bin/judge-agent

USER judge
