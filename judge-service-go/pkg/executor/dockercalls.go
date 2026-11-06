package executor

import (
	"time"

	docker "github.com/fsouza/go-dockerclient"

	"judge-service-go/pkg/metrics"
)

// Timed wrappers for the Docker calls a run makes, so the judge can report how many it makes
// per submission and how long they take (JUDGE_AGENT_PLAN Phase 0). exec_start times the
// start handshake only; the program's own run time is not in it.

func (e *Executor) createExec(opts docker.CreateExecOptions) (*docker.Exec, error) {
	defer recordSince("exec_create", time.Now())
	return e.cli.CreateExec(opts)
}

func (e *Executor) startExec(id string, opts docker.StartExecOptions) (docker.CloseWaiter, error) {
	defer recordSince("exec_start", time.Now())
	return e.cli.StartExecNonBlocking(id, opts)
}

func (e *Executor) inspectExec(id string) (*docker.ExecInspect, error) {
	defer recordSince("exec_inspect", time.Now())
	return e.cli.InspectExec(id)
}

func (e *Executor) updateContainer(id string, opts docker.UpdateContainerOptions) error {
	defer recordSince("update", time.Now())
	return e.cli.UpdateContainer(id, opts)
}

func recordSince(op string, start time.Time) {
	metrics.RecordDockerCall(op, time.Since(start))
}
