package pool

import (
	"os"
	"strings"
)

// InstanceLabelKey marks which judge stack created a sandbox. Two stacks can share a Docker
// host (on deploy2 the GO Judge and the Exam Sandbox stacks do), and each judge removes its
// leftover sandboxes at startup: without this label it removed the other stack's too,
// including ones judging a submission at that moment.
const InstanceLabelKey = "judge-instance"

// Instance is this judge's stack name, from JUDGE_INSTANCE. The compose files default it to
// the Compose project name, which is different for every stack and the same across
// redeploys. Empty means a single-stack host: sandboxes carry no instance label.
func Instance() string {
	return strings.TrimSpace(os.Getenv("JUDGE_INSTANCE"))
}

// OwnedByThisInstance reports whether a sandbox with these labels is this judge's to clean
// up: it carries this instance's label, or no instance label at all (created by a judge from
// before the label existed; removing those is what every judge did until now).
func OwnedByThisInstance(labels map[string]string) bool {
	owner, labelled := labels[InstanceLabelKey]
	return !labelled || owner == Instance()
}
