package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// JUDGE_FIX_PLAN M1: a queued /run or /raw-run goes through the same HTTP handler and the
// reply carries exactly its status and body.
func TestServeJudgeRPCPassesThroughTheHandler(t *testing.T) {
	var gotPath, gotBody string
	var gotDeadline time.Duration
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		if dl, ok := r.Context().Deadline(); ok {
			gotDeadline = time.Until(dl)
		}
		w.WriteHeader(http.StatusTeapot)
		_, _ = io.WriteString(w, `{"status":"Accepted"}`)
	})
	delivery := func(path, body, expiration string) amqp.Delivery {
		raw, _ := json.Marshal(judgeRPCRequest{Path: path, Body: body})
		return amqp.Delivery{Body: raw, Expiration: expiration}
	}

	reply := serveJudgeRPC(context.Background(), handler, delivery("/run", `{"code":"x"}`, "5000"))
	if reply.Status != http.StatusTeapot || reply.Body != `{"status":"Accepted"}` {
		t.Fatalf("reply = %+v", reply)
	}
	if gotPath != "/run" || gotBody != `{"code":"x"}` {
		t.Fatalf("handler saw %s %q", gotPath, gotBody)
	}
	if gotDeadline <= 0 || gotDeadline > 5*time.Second {
		t.Fatalf("deadline %v, want the caller's 5 s expiration", gotDeadline)
	}

	if reply := serveJudgeRPC(context.Background(), handler, delivery("/stats", "", "")); reply.Status != http.StatusNotFound {
		t.Fatalf("/stats over RPC: %+v, want 404 (only /run and /raw-run)", reply)
	}
	if reply := serveJudgeRPC(context.Background(), handler, amqp.Delivery{Body: []byte("not json")}); reply.Status != http.StatusBadRequest {
		t.Fatalf("bad request: %+v", reply)
	}
}
