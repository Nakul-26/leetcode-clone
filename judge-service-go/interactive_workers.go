package main

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"

	amqp "github.com/rabbitmq/amqp091-go"
)

// interactiveWorkers runs the interactive queue's workers, each on its own channel with a
// prefetch of one. A judge therefore holds exactly as many interactive messages as it has
// workers, as before (one consumer with prefetch = workers), and the number of workers can
// change while it runs: the adaptive concurrency controller (pkg/capacity) grows it while the
// host has CPU to spare and shrinks it when the host is full.
//
// A worker that is stopped finishes the message it holds, then its channel closes. A channel
// that closes on its own means the broker is gone; lost then fires and the judge exits, as it
// does for the bulk consumer.
type interactiveWorkers struct {
	conn  *amqp.Connection
	queue string
	run   func(d amqp.Delivery, ch *amqp.Channel)
	wg    *sync.WaitGroup

	mu      sync.Mutex
	active  []*interactiveWorker
	seq     int
	stopped bool

	busy   atomic.Int64
	n      atomic.Int64 // len(active), readable without the lock
	waited atomic.Bool  // every worker was busy at some point since the last Demand call
	lost   chan error
}

type interactiveWorker struct {
	ch       *amqp.Channel
	tag      string
	stopping atomic.Bool
}

func newInteractiveWorkers(conn *amqp.Connection, queue string, wg *sync.WaitGroup, run func(amqp.Delivery, *amqp.Channel)) *interactiveWorkers {
	return &interactiveWorkers{conn: conn, queue: queue, run: run, wg: wg, lost: make(chan error, 1)}
}

// ScaleTo starts or stops workers until n are running.
func (w *interactiveWorkers) ScaleTo(n int) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stopped {
		return nil
	}
	for len(w.active) < n {
		wk, err := w.startLocked()
		if err != nil {
			return err
		}
		w.active = append(w.active, wk)
		w.n.Store(int64(len(w.active)))
	}
	for len(w.active) > n {
		wk := w.active[len(w.active)-1]
		w.active = w.active[:len(w.active)-1]
		w.n.Store(int64(len(w.active)))
		w.stopWorker(wk)
	}
	return nil
}

// Count is how many workers are running.
func (w *interactiveWorkers) Count() int { return int(w.n.Load()) }

// Demand reports whether every worker was busy at some point since the last call: interactive
// work was (or could have been) waiting for one.
func (w *interactiveWorkers) Demand() bool {
	return w.waited.Swap(false)
}

// StopAll cancels every consumer for shutdown; the loops end once their messages are done.
func (w *interactiveWorkers) StopAll() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.stopped = true
	for _, wk := range w.active {
		w.stopWorker(wk)
	}
	w.active = nil
	w.n.Store(0)
}

func (w *interactiveWorkers) stopWorker(wk *interactiveWorker) {
	wk.stopping.Store(true)
	if err := wk.ch.Cancel(wk.tag, false); err != nil {
		slog.Error("Error cancelling interactive consumer", "consumer", wk.tag, "error", err)
	}
}

func (w *interactiveWorkers) startLocked() (*interactiveWorker, error) {
	ch, err := w.conn.Channel()
	if err != nil {
		return nil, fmt.Errorf("interactive worker channel: %w", err)
	}
	if err := ch.Qos(1, 0, false); err != nil {
		_ = ch.Close()
		return nil, fmt.Errorf("interactive worker QoS: %w", err)
	}
	w.seq++
	wk := &interactiveWorker{ch: ch, tag: fmt.Sprintf("%s-%d", interactiveConsumerTag, w.seq)}
	deliveries, err := ch.Consume(w.queue, wk.tag, false, false, false, false, nil)
	if err != nil {
		_ = ch.Close()
		return nil, fmt.Errorf("interactive consumer: %w", err)
	}
	w.wg.Add(1)
	go func() {
		defer w.wg.Done()
		for d := range deliveries {
			if returnIfShuttingDown(d) {
				continue
			}
			if int(w.busy.Add(1)) >= w.Count() {
				w.waited.Store(true)
			}
			w.run(d, ch)
			w.busy.Add(-1)
		}
		if wk.stopping.Load() {
			_ = ch.Close()
			return
		}
		select {
		case w.lost <- errors.New("interactive consumer " + wk.tag + " stopped"):
		default:
		}
	}()
	return wk, nil
}
