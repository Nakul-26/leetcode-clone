FROM eclipse-temurin:21-jdk
# NOTE: eclipse-temurin's *-alpine tags are amd64-only for many JDK versions.
# The Debian/Ubuntu-based (non-alpine) tag is multi-arch, so use that instead
# (same reasoning as the Java sandbox image).

# The Kotlin compiler is pure JVM bytecode distributed as a zip (bin scripts +
# jars), so it's architecture-independent — no need for an arch-specific image.
ARG KOTLIN_VERSION=2.0.21
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget unzip \
    && wget -q -O /tmp/kotlin-compiler.zip "https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN_VERSION}/kotlin-compiler-${KOTLIN_VERSION}.zip" \
    && unzip -q /tmp/kotlin-compiler.zip -d /opt \
    && rm /tmp/kotlin-compiler.zip \
    && apt-get purge -y --auto-remove wget unzip \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/kotlinc/bin:${PATH}"

# Download Gson library (same dependency the Java sandbox image uses)
ARG GSON_VERSION=2.10.1
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget \
    && wget -O /tmp/gson.jar https://repo1.maven.org/maven2/com/google/code/gson/gson/${GSON_VERSION}/gson-${GSON_VERSION}.jar \
    && mkdir -p /usr/share/java \
    && mv /tmp/gson.jar /usr/share/java/gson.jar \
    && apt-get purge -y --auto-remove wget \
    && rm -rf /var/lib/apt/lists/*

# The judge's function-mode harnesses, compiled once here instead of with every submission
# (JUDGE_FIX_PLAN T9): a submission then compiles only its Solution.kt, ~4 s instead of ~13 s
# on one core. They find Solution by reflection, so they compile without it. Copies of
# pkg/wrappers/kotlin_wrapper.tpl and kotlin_batch_wrapper.tpl (a judge test keeps them equal).
# The build fails if either does not compile.
COPY harness /opt/judge-harness-src
RUN kotlinc -cp /usr/share/java/gson.jar -d /opt/judge-harness/single /opt/judge-harness-src/single/Harness.kt \
 && kotlinc -cp /usr/share/java/gson.jar -d /opt/judge-harness/batch /opt/judge-harness-src/batch/Harness.kt \
 && test -f /opt/judge-harness/single/HarnessKt.class && test -f /opt/judge-harness/batch/HarnessKt.class \
 && rm -rf /opt/judge-harness-src /root/.kotlin && chmod -R a+rX /opt/judge-harness

# Create a non-root user 'judge' with a writable home (kotlinc writes compiler
# cache files under $HOME).
RUN addgroup --system judge && adduser --system --ingroup judge --home /home/judge judge \
    && mkdir -p /home/judge && chown -R judge:judge /home/judge

ENV HOME=/home/judge

USER judge
WORKDIR /app
