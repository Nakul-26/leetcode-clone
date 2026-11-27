# The sandbox agent (cmd/judge-agent, docs/judge/JUDGE_AGENT_PLAN.md Phase 2), built from the
# judge's own source: the build context is judge-service-go/ (see the docker-compose files).
FROM golang:alpine AS judge-agent
WORKDIR /src
COPY go.mod go.sum ./
COPY pkg/agentproto ./pkg/agentproto
COPY cmd/judge-agent ./cmd/judge-agent
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /judge-agent ./cmd/judge-agent

FROM gcc:latest

# Install nlohmann-json for the C++ wrapper harness
RUN apt-get update \
    && apt-get install -y --no-install-recommends nlohmann-json3-dev \
    && rm -rf /var/lib/apt/lists/*

# Precompiled <bits/stdc++.h> (JUDGE_FIX_PLAN T7), built with the stdin-mode flags (-O2,
# default standard) in the header's own directory, where g++ looks for it. g++ uses it only
# when the flags match and otherwise silently parses the header as usual, so the last step
# fails the build if a test program does not actually use it. Measured 2026-10-24 on one
# core: a typical bits/stdc++.h program compiles in 0.8 s instead of 2.8 s.
RUN H="$(echo '#include <bits/stdc++.h>' | g++ -O2 -x c++ -H -fsyntax-only - 2>&1 | awk '/stdc\+\+\.h$/ {print $2; exit}')" \
    && g++ -O2 -x c++-header "$H" -o "$H.gch" \
    && printf '#include <bits/stdc++.h>\nint main() {}\n' > /tmp/pch-check.cpp \
    && g++ -O2 -H -o /tmp/pch-check /tmp/pch-check.cpp 2>&1 | grep -q '^! .*stdc++.h.gch' \
    && rm -f /tmp/pch-check /tmp/pch-check.cpp

# Create a non-root user 'judge'
RUN addgroup --system judge && adduser --system --ingroup judge judge

# Set the user
# The judge I/O helper's function bodies, compiled once (pkg/central/adapters/cpp.go), with the
# hash a submission's copy must match for the object to be linked into it.
COPY pkg/wrappers/cpp_judge_io.inc /opt/judge-cpp/judge_io.inc
RUN printf '#include <bits/stdc++.h>\n#include "/opt/judge-cpp/judge_io.inc"\n' > /tmp/judge_io.cpp \
    && g++ -O2 -DJUDGE_IO_OBJECT -c -o /opt/judge-cpp/judge_io.o /tmp/judge_io.cpp \
    && sha256sum /opt/judge-cpp/judge_io.inc | cut -d' ' -f1 > /opt/judge-cpp/judge_io.sha \
    && rm -f /tmp/judge_io.cpp && chmod -R a+rX /opt/judge-cpp

# Root-owned and on the read-only root filesystem: no submission can change it.
COPY --from=judge-agent /judge-agent /usr/local/bin/judge-agent

USER judge
