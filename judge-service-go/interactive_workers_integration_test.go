//go:build integration

package main

import (
	"context"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// The interactive worker set (interactive_workers.go) against a real RabbitMQ: TEST_RABBITMQ_URL.
func rabbitForTest(t *testing.T) (*amqp.Connection, string) {
	t.Helper()
	url := os.Getenv("TEST_RABBITMQ_URL")
	if url == "" {
		t.Skip("TEST_RABBITMQ_URL not set")
	}
	conn, err := amqp.Dial(url)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	ch, err := conn.Channel()
	if err != nil {
		t.Fatal(err)
	}
	q := fmt.Sprintf("iw-test-%d", time.Now().UnixNano())
	if _, err := ch.QueueDeclare(q, false, true, false, false, nil); err != nil {
		t.Fatal(err)
	}
	ch.Close()
	return conn, q
}

func publishN(t *testing.T, conn *amqp.Connection, q string, n int) {
	t.Helper()
	ch, err := conn.Channel()
	if err != nil {
		t.Fatal(err)
	}
	defer ch.Close()
	for i := 0; i < n; i++ {
		if err := ch.PublishWithContext(context.Background(), "", q, false, false, amqp.Publishing{Body: []byte(fmt.Sprint(i))}); err != nil {
			t.Fatal(err)
		}
	}
}

// Every message is handled exactly once while the worker count goes up and down, and no more
// messages are in progress at once than there are workers.
func TestInteractiveWorkersScale(t *testing.T) {
	conn, q := rabbitForTest(t)
	var wg sync.WaitGroup
	var mu sync.Mutex
	seen := map[string]int{}
	var running, peak atomic.Int64
	var limit atomic.Int64
	overLimit := atomic.Bool{}

	iw := newInteractiveWorkers(conn, q, &wg, func(d amqp.Delivery, ch *amqp.Channel) {
		r := running.Add(1)
		if r > peak.Load() {
			peak.Store(r)
		}
		if r > limit.Load() {
			overLimit.Store(true)
		}
		time.Sleep(20 * time.Millisecond)
		mu.Lock()
		seen[string(d.Body)]++
		mu.Unlock()
		running.Add(-1)
		_ = d.Ack(false)
	})

	limit.Store(2)
	if err := iw.ScaleTo(2); err != nil {
		t.Fatal(err)
	}
	const n = 300
	publishN(t, conn, q, n)
	time.Sleep(300 * time.Millisecond)

	limit.Store(8)
	if err := iw.ScaleTo(8); err != nil {
		t.Fatal(err)
	}
	if iw.Count() != 8 {
		t.Fatalf("count %d, want 8", iw.Count())
	}
	time.Sleep(300 * time.Millisecond)
	if err := iw.ScaleTo(3); err != nil { // the stopped ones finish what they hold
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond) // let the stopped workers finish their message
	limit.Store(3)

	deadline := time.Now().Add(30 * time.Second)
	for {
		mu.Lock()
		got := len(seen)
		mu.Unlock()
		if got == n {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("handled %d of %d messages", got, n)
		}
		time.Sleep(50 * time.Millisecond)
	}
	mu.Lock()
	for k, c := range seen {
		if c != 1 {
			t.Errorf("message %s handled %d times", k, c)
		}
	}
	mu.Unlock()
	if peak.Load() < 6 {
		t.Errorf("peak concurrency %d: scaling up to 8 had no effect", peak.Load())
	}
	if overLimit.Load() {
		t.Error("more messages in progress than workers")
	}
	if !iw.Demand() {
		t.Error("Demand was false although every worker was busy")
	}

	iw.StopAll()
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("workers did not stop")
	}
	select {
	case err := <-iw.lost:
		t.Fatalf("a deliberate stop was reported as lost: %v", err)
	default:
	}
}

// A worker whose channel goes away on its own (the broker closed it) is reported as lost.
func TestInteractiveWorkersReportLostChannel(t *testing.T) {
	conn, q := rabbitForTest(t)
	var wg sync.WaitGroup
	iw := newInteractiveWorkers(conn, q, &wg, func(d amqp.Delivery, ch *amqp.Channel) { _ = d.Ack(false) })
	if err := iw.ScaleTo(1); err != nil {
		t.Fatal(err)
	}
	iw.mu.Lock()
	ch := iw.active[0].ch
	iw.mu.Unlock()
	_ = ch.Close()
	select {
	case <-iw.lost:
	case <-time.After(10 * time.Second):
		t.Fatal("a closed channel was not reported")
	}
}
