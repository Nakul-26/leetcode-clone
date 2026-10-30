// Command docker-guard is a Docker API proxy that lets the judge manage its own sandboxes
// and nothing else on the host (JUDGE_FIX_PLAN S2). See guard.go for the rules.
//
// Environment:
//
//	GUARD_LISTEN         address to listen on (default :2375)
//	GUARD_DOCKER_SOCKET  the Docker socket (default /var/run/docker.sock)
//	GUARD_MAX_MEMORY_MB  the largest memory limit a sandbox may get (default 4096)
package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"
)

func main() {
	listen := envOr("GUARD_LISTEN", ":2375")
	socket := envOr("GUARD_DOCKER_SOCKET", "/var/run/docker.sock")

	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", socket)
		},
		MaxIdleConnsPerHost: 64,
		IdleConnTimeout:     90 * time.Second,
	}
	g := newGuard(&url.URL{Scheme: "http", Host: "docker"}, transport)
	if v := os.Getenv("GUARD_MAX_MEMORY_MB"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			g.maxMemoryMb = n
		}
	}

	srv := &http.Server{
		Addr:              listen,
		Handler:           g,
		ReadHeaderTimeout: 10 * time.Second,
	}
	slog.Info("docker-guard listening", "addr", listen, "socket", socket, "maxMemoryMb", g.maxMemoryMb)
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("docker-guard stopped", "error", err)
		os.Exit(1)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
