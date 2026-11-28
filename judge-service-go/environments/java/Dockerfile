# The sandbox agent (cmd/judge-agent, docs/judge/JUDGE_AGENT_PLAN.md Phase 2), built from the
# judge's own source: the build context is judge-service-go/ (see the docker-compose files).
FROM golang:alpine AS judge-agent
WORKDIR /src
COPY go.mod go.sum ./
COPY pkg/agentproto ./pkg/agentproto
COPY cmd/judge-agent ./cmd/judge-agent
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /judge-agent ./cmd/judge-agent

FROM eclipse-temurin:11-jdk
# NOTE: eclipse-temurin:11-jdk-alpine is amd64-only (no arm64 manifest), which
# breaks builds on ARM64 hosts with "no match for platform in manifest".
# The Debian/Ubuntu-based (non-alpine) tag is multi-arch, so use that instead.

# Create a non-root user 'judge'
RUN addgroup --system judge && adduser --system --ingroup judge judge

# Download Gson library
ARG GSON_VERSION=2.10.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget \
    && wget -O /tmp/gson.jar https://repo1.maven.org/maven2/com/google/code/gson/gson/${GSON_VERSION}/gson-${GSON_VERSION}.jar \
    && mkdir -p /usr/share/java \
    && mv /tmp/gson.jar /usr/share/java/gson.jar \
    && apt-get purge -y --auto-remove wget \
    && rm -rf /var/lib/apt/lists/*

ENV CLASSPATH /usr/share/java/gson.jar:.

# Class-data archives (JUDGE_FIX_PLAN T8): the JDK and Gson classes javac and a typical judged
# program load, pre-parsed once here so every compile and run maps them instead of loading
# them again. Recorded from cds/Train.java. javac.jsa is used by javac, run.jsa by the
# program; the judge passes -Xshare:auto, so a missing or unusable archive is silently
# ignored rather than failing a run. The -Xshare:on checks fail the build if an archive does
# not load. The run archive is dumped with gson.jar alone on the classpath: at run time the
# judge's classpath is gson.jar:., which starts with it, as CDS requires.
COPY environments/java/cds/Train.java /opt/cds/train/Train.java
RUN cd /opt/cds/train \
    && javac -J-XX:DumpLoadedClassList=/opt/cds/javac.lst -cp /usr/share/java/gson.jar:. Train.java \
    && java -Xshare:dump -XX:SharedClassListFile=/opt/cds/javac.lst -XX:SharedArchiveFile=/opt/cds/javac.jsa \
    && echo "line" | java -XX:DumpLoadedClassList=/opt/cds/run.lst -cp /usr/share/java/gson.jar:. Train > /dev/null 2>&1 \
    && java -Xshare:dump -XX:SharedClassListFile=/opt/cds/run.lst -XX:SharedArchiveFile=/opt/cds/run.jsa -cp /usr/share/java/gson.jar \
    && javac -J-Xshare:on -J-XX:SharedArchiveFile=/opt/cds/javac.jsa -cp /usr/share/java/gson.jar:. Train.java \
    && echo "line" | java -Xshare:on -XX:SharedArchiveFile=/opt/cds/run.jsa -cp /usr/share/java/gson.jar:. Train > /dev/null \
    && cd / && rm -rf /opt/cds/train /opt/cds/*.lst \
    && chmod 0644 /opt/cds/*.jsa

# Set the user
# The function-mode harnesses, compiled once here instead of with every submission
# (pkg/central/adapters/java.go). They find Solution and the method at run time, so they
# compile without them; the build fails if one still needs Solution.
COPY pkg/wrappers/java_single_wrapper.tpl /opt/judge-java-src/single/Main.java
COPY pkg/wrappers/java_batch_wrapper.tpl /opt/judge-java-src/batch/Main.java
RUN for h in single batch; do \
      mkdir -p /opt/judge-java/$h \
      && javac -cp /usr/share/java/gson.jar -d /opt/judge-java/$h /opt/judge-java-src/$h/Main.java \
      && test -f /opt/judge-java/$h/Main.class && test -f /opt/judge-java/$h/ListNode.class || exit 1; \
    done \
    && rm -rf /opt/judge-java-src && chmod -R a+rX /opt/judge-java

# The resident Java compiler (pkg/compilesvc), run in a compiler container of its own.
COPY environments/java/compile-server/CompileServer.java /opt/judge-java/compile-server-src/CompileServer.java
RUN javac -cp /usr/share/java/gson.jar -d /opt/judge-java/compile-server /opt/judge-java/compile-server-src/CompileServer.java     && test -f /opt/judge-java/compile-server/CompileServer.class     && rm -rf /opt/judge-java/compile-server-src && chmod -R a+rX /opt/judge-java/compile-server

# Root-owned and on the read-only root filesystem: no submission can change it.
COPY --from=judge-agent /judge-agent /usr/local/bin/judge-agent

USER judge
