package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// judgeRPCQueue carries the synchronous calls (/run, /raw-run) over RabbitMQ request/reply
// (JUDGE_FIX_PLAN M1). Over HTTP they reached the one judge that JUDGE_SERVICE_URL names; on
// the queue, any judge consuming it takes the request, so they spread across judge servers
// like submissions do. The request runs through the same HTTP handler, in process, and the
// reply carries its status and body, so a caller sees exactly what HTTP would return
// (assessment-api judgeClient.service.js). The HTTP endpoints stay for callers that do not
// use the queue.
const judgeRPCQueue = "judge_rpc"

// Requests are acknowledged on receipt: a run is not retried on another judge if this one
// dies mid-run (the caller times out), so a slow program is never run twice.
const defaultJudgeRPCConcurrency = 16

// Longest a request may run when the caller set no expiration.
const defaultJudgeRPCTimeout = 150 * time.Second

var judgeRPCPaths = map[string]bool{"/run": true, "/raw-run": true}

type judgeRPCRequest struct {
	Path string `json:"path"`
	Body string `json:"body"`
}

type judgeRPCReply struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

// startJudgeRPC consumes judgeRPCQueue on its own channel until ctx ends, reopening the
// channel if it closes while the connection is up. JUDGE_RPC=off turns it off.
func startJudgeRPC(ctx context.Context, conn *amqp.Connection, handler http.Handler) {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("JUDGE_RPC")), "off") {
		slog.Info("Judge RPC consumer disabled (JUDGE_RPC=off)")
		return
	}
	concurrency := getIntEnv("JUDGE_RPC_CONCURRENCY", defaultJudgeRPCConcurrency)
	go func() {
		for ctx.Err() == nil && !conn.IsClosed() {
			if err := consumeJudgeRPC(ctx, conn, handler, concurrency); err != nil {
				slog.Warn("Judge RPC consumer stopped; retrying", "error", err)
			}
			select {
			case <-ctx.Done():
			case <-time.After(5 * time.Second):
			}
		}
	}()
}

func consumeJudgeRPC(ctx context.Context, conn *amqp.Connection, handler http.Handler, concurrency int) error {
	ch, err := conn.Channel()
	if err != nil {
		return err
	}
	defer ch.Close()
	if err := ch.Qos(concurrency, 0, false); err != nil {
		return err
	}
	// Same declaration as the API's (durable, no arguments), so either side may create it.
	if _, err := ch.QueueDeclare(judgeRPCQueue, true, false, false, false, nil); err != nil {
		return err
	}
	deliveries, err := ch.Consume(judgeRPCQueue, "", false, false, false, false, nil)
	if err != nil {
		return err
	}
	slog.Info("Judge RPC consumer started", "queue", judgeRPCQueue, "concurrency", concurrency)

	var publishMu sync.Mutex
	var wg sync.WaitGroup
	defer wg.Wait()
	for {
		select {
		case <-ctx.Done():
			return nil
		case d, ok := <-deliveries:
			if !ok {
				return nil
			}
			_ = d.Ack(false)
			wg.Add(1)
			go func(d amqp.Delivery) {
				defer wg.Done()
				reply := serveJudgeRPC(ctx, handler, d)
				if d.ReplyTo == "" {
					return
				}
				body, _ := json.Marshal(reply)
				publishMu.Lock()
				err := ch.PublishWithContext(context.Background(), "", d.ReplyTo, false, false, amqp.Publishing{
					ContentType:   "application/json",
					CorrelationId: d.CorrelationId,
					Body:          body,
				})
				publishMu.Unlock()
				if err != nil {
					slog.Warn("Judge RPC reply failed", "status", reply.Status, "error", err)
				}
			}(d)
		}
	}
}

// serveJudgeRPC runs one request through the HTTP handler and returns what it answered.
func serveJudgeRPC(ctx context.Context, handler http.Handler, d amqp.Delivery) judgeRPCReply {
	var req judgeRPCRequest
	if err := json.Unmarshal(d.Body, &req); err != nil {
		return judgeRPCReply{Status: http.StatusBadRequest, Body: "invalid judge RPC request"}
	}
	if !judgeRPCPaths[req.Path] {
		return judgeRPCReply{Status: http.StatusNotFound, Body: "unknown judge RPC path " + req.Path}
	}
	timeout := defaultJudgeRPCTimeout
	if ms, err := strconv.Atoi(d.Expiration); err == nil && ms > 0 {
		timeout = time.Duration(ms) * time.Millisecond
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	httpReq := httptest.NewRequest(http.MethodPost, req.Path, strings.NewReader(req.Body)).WithContext(runCtx)
	httpReq.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httpReq)
	return judgeRPCReply{Status: rec.Code, Body: rec.Body.String()}
}
