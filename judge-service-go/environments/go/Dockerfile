FROM golang:1.24-alpine

# Install any necessary build tools
RUN apk add --no-cache build-base

# Create a non-root user 'judge'
RUN addgroup -S judge && adduser -S -G judge judge

# Set Go environment variables for writable directories
ENV GOCACHE=/tmp/.cache/go-build
ENV GOPATH=/tmp/go

# Pre-built Go build cache for the standard packages submissions commonly import. A container's
# GOCACHE starts empty, so its first submission used to compile the standard library from scratch
# (~16 s). judge-warmup copies this into GOCACHE when the judge creates the container.
# Built with exactly the settings submissions use (GOFLAGS etc., see the Go adapter's compile
# command), because Go's cache keys include them; with different settings the cache is ignored.
RUN mkdir -p /opt/gocache /tmp/warm && cd /tmp/warm \
 && printf 'package main\n\nimport (\n\t"bufio"\n\t"container/heap"\n\t"fmt"\n\t"math"\n\t"os"\n\t"sort"\n\t"strconv"\n\t"strings"\n)\n\nvar _ = heap.Init\n\nfunc main() {\n\tr := bufio.NewReader(os.Stdin)\n\tvar n int\n\tfmt.Fscan(r, &n)\n\ts := []int{n}\n\tsort.Ints(s)\n\tfmt.Println(strings.TrimSpace(strconv.Itoa(s[0])), math.Abs(1))\n}\n' > main.go \
 && export GOCACHE=/opt/gocache GOFLAGS=-mod=mod GOPROXY=off GOSUMDB=off GO111MODULE=on GOTOOLCHAIN=local \
 && go mod init solution && go build -o main . \
 && cd / && rm -rf /tmp/warm /tmp/go && chmod -R a+rX /opt/gocache

COPY judge-warmup /usr/local/bin/judge-warmup
RUN chmod 755 /usr/local/bin/judge-warmup

# Set the working directory
WORKDIR /app

# Set the user
USER judge
