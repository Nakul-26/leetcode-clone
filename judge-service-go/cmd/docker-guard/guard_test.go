package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	docker "github.com/fsouza/go-dockerclient"
)

// fakeDaemon answers like the Docker daemon for a judge sandbox ("sandbox1"), a container that
// is not one ("mongo1"), and execs in each; it records every request the guard forwards.
type fakeDaemon struct {
	mu        sync.Mutex
	forwarded []string
	lastQuery url.Values
}

func (f *fakeDaemon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := versionPrefix.ReplaceAllString(r.URL.Path, "$2")
	w.Header().Set("Content-Type", "application/json")
	switch path {
	case "/version":
		_, _ = io.WriteString(w, `{"ApiVersion":"1.43","Version":"24.0.0"}`)
		return
	case "/containers/sandbox1/json":
		_, _ = io.WriteString(w, `{"Id":"sandbox1","Config":{"Image":"judge-go-env","Labels":{"managed-by":"judge-service"}},
			"HostConfig":{"NetworkMode":"none","CapAdd":["KILL"],"Privileged":false},"Mounts":[]}`)
		return
	case "/containers/mongo1/json":
		_, _ = io.WriteString(w, `{"Id":"mongo1","Config":{"Image":"mongo:6.0","Labels":{}},
			"HostConfig":{"NetworkMode":"bridge"},"Mounts":[{"Type":"volume"}]}`)
		return
	case "/containers/fake1/json":
		// Has the label and image but host access: not a sandbox.
		_, _ = io.WriteString(w, `{"Id":"fake1","Config":{"Image":"judge-go-env","Labels":{"managed-by":"judge-service"}},
			"HostConfig":{"NetworkMode":"none","Privileged":true},"Mounts":[]}`)
		return
	case "/containers/missing/json", "/exec/missing/json":
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"message":"No such container: missing"}`)
		return
	case "/exec/e-sandbox/json":
		_, _ = io.WriteString(w, `{"ID":"e-sandbox","ContainerID":"sandbox1","Running":false,"ExitCode":0}`)
		return
	case "/exec/e-mongo/json":
		_, _ = io.WriteString(w, `{"ID":"e-mongo","ContainerID":"mongo1"}`)
		return
	}
	f.mu.Lock()
	f.forwarded = append(f.forwarded, r.Method+" "+path)
	f.lastQuery = r.URL.Query()
	f.mu.Unlock()
	switch {
	case path == "/containers/create":
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"Id":"new1"}`)
	case strings.HasSuffix(path, "/exec"):
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"Id":"e-sandbox"}`)
	case path == "/containers/json":
		_, _ = io.WriteString(w, `[]`)
	default:
		_, _ = io.WriteString(w, `{}`)
	}
}

func (f *fakeDaemon) took(call string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.forwarded {
		if c == call {
			return true
		}
	}
	return false
}

func setup(t *testing.T) (*docker.Client, *fakeDaemon, *httptest.Server) {
	t.Helper()
	daemon := &fakeDaemon{}
	upstream := httptest.NewServer(daemon)
	t.Cleanup(upstream.Close)
	base, _ := url.Parse(upstream.URL)
	g := newGuard(base, http.DefaultTransport)
	srv := httptest.NewServer(g)
	t.Cleanup(srv.Close)
	cli, err := docker.NewVersionedClient(srv.URL, "1.41")
	if err != nil {
		t.Fatal(err)
	}
	return cli, daemon, srv
}

// sandboxOptions mirrors pool.createContainer's settings.
func sandboxOptions() docker.CreateContainerOptions {
	pids := int64(128)
	return docker.CreateContainerOptions{
		Config: &docker.Config{
			Image: "judge-go-env", Cmd: []string{"tail", "-f", "/dev/null"}, WorkingDir: "/app", User: "root",
			Labels: map[string]string{"app": "code-platform", "service": "judge", "managed-by": "judge-service", "language": "go", "pool": "true"},
		},
		HostConfig: &docker.HostConfig{
			NetworkMode: "none", ReadonlyRootfs: true, SecurityOpt: []string{"no-new-privileges:true"},
			CapDrop: []string{"ALL"}, CapAdd: []string{"KILL"},
			Memory: 1 << 30, MemorySwap: 1 << 30, CPUQuota: 100000, PidsLimit: &pids, Init: true,
			Tmpfs: map[string]string{"/tmp": "rw,noexec,nosuid,nodev,size=512m", "/app": "rw,exec,nosuid,nodev,size=512m,mode=1777"},
		},
	}
}

func isForbidden(err error) bool {
	var e *docker.Error
	if de, ok := err.(*docker.Error); ok {
		e = de
	}
	return e != nil && e.Status == http.StatusForbidden
}

func TestGuardAllowsTheJudgeSandbox(t *testing.T) {
	cli, daemon, _ := setup(t)
	if _, err := cli.CreateContainer(sandboxOptions()); err != nil {
		t.Fatalf("sandbox create refused: %v", err)
	}
	if !daemon.took("POST /containers/create") {
		t.Fatal("create was not forwarded")
	}
	if err := cli.StartContainer("sandbox1", nil); err != nil {
		t.Fatalf("start refused: %v", err)
	}
	exec, err := cli.CreateExec(docker.CreateExecOptions{Container: "sandbox1", User: "root", Cmd: []string{"sh", "-c", "pkill -9 -u judge"}})
	if err != nil {
		t.Fatalf("exec create refused: %v", err)
	}
	if _, err := cli.InspectExec(exec.ID); err != nil {
		t.Fatalf("exec inspect refused: %v", err)
	}
	if err := cli.UpdateContainer("sandbox1", docker.UpdateContainerOptions{Memory: 512 << 20, MemorySwap: 512 << 20}); err != nil {
		t.Fatalf("memory update refused: %v", err)
	}
	// The judge passes timeout contexts, which go-dockerclient serialises into the body.
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	ctx, cancel2 := context.WithTimeout(ctx, 30*time.Second)
	defer cancel2()
	if err := cli.UpdateContainer("sandbox1", docker.UpdateContainerOptions{Memory: 512 << 20, MemorySwap: 512 << 20, Context: ctx}); err != nil {
		t.Fatalf("memory update with a nested timeout context refused: %v", err)
	}
	if err := cli.RemoveContainer(docker.RemoveContainerOptions{ID: "sandbox1", Force: true}); err != nil {
		t.Fatalf("remove refused: %v", err)
	}
	if _, err := cli.InspectImage("judge-go-env"); err != nil {
		t.Fatalf("image inspect refused: %v", err)
	}
	if err := cli.PullImage(docker.PullImageOptions{Repository: "judge-go-env", Tag: "latest"}, docker.AuthConfiguration{}); err != nil {
		t.Fatalf("judge image pull refused: %v", err)
	}
	if err := cli.Ping(); err != nil {
		t.Fatalf("ping refused: %v", err)
	}
}

func TestGuardRefusesHostAccessOnCreate(t *testing.T) {
	cases := map[string]func(*docker.CreateContainerOptions){
		"privileged": func(o *docker.CreateContainerOptions) { o.HostConfig.Privileged = true },
		"bind mount": func(o *docker.CreateContainerOptions) { o.HostConfig.Binds = []string{"/:/host"} },
		"mount": func(o *docker.CreateContainerOptions) {
			o.HostConfig.Mounts = []docker.HostMount{{Type: "bind", Source: "/", Target: "/host"}}
		},
		"docker socket": func(o *docker.CreateContainerOptions) { o.HostConfig.Binds = []string{"/var/run/docker.sock:/s"} },
		"network":       func(o *docker.CreateContainerOptions) { o.HostConfig.NetworkMode = "bridge" },
		"host network":  func(o *docker.CreateContainerOptions) { o.HostConfig.NetworkMode = "host" },
		"host pid":      func(o *docker.CreateContainerOptions) { o.HostConfig.PidMode = "host" },
		"another's pid": func(o *docker.CreateContainerOptions) { o.HostConfig.PidMode = "container:mongo1" },
		"capability":    func(o *docker.CreateContainerOptions) { o.HostConfig.CapAdd = []string{"SYS_ADMIN"} },
		"caps kept":     func(o *docker.CreateContainerOptions) { o.HostConfig.CapDrop = nil },
		"device": func(o *docker.CreateContainerOptions) {
			o.HostConfig.Devices = []docker.Device{{PathOnHost: "/dev/sda"}}
		},
		"seccomp off": func(o *docker.CreateContainerOptions) {
			o.HostConfig.SecurityOpt = []string{"no-new-privileges:true", "seccomp=unconfined"}
		},
		"privileges allowed": func(o *docker.CreateContainerOptions) { o.HostConfig.SecurityOpt = nil },
		"writable root":      func(o *docker.CreateContainerOptions) { o.HostConfig.ReadonlyRootfs = false },
		"no memory limit":    func(o *docker.CreateContainerOptions) { o.HostConfig.Memory = 0 },
		"no pids limit":      func(o *docker.CreateContainerOptions) { o.HostConfig.PidsLimit = nil },
		"sysctl":             func(o *docker.CreateContainerOptions) { o.HostConfig.Sysctls = map[string]string{"kernel.x": "1"} },
		"volumes from":       func(o *docker.CreateContainerOptions) { o.HostConfig.VolumesFrom = []string{"mongo1"} },
		"restart policy":     func(o *docker.CreateContainerOptions) { o.HostConfig.RestartPolicy = docker.AlwaysRestart() },
		"other image":        func(o *docker.CreateContainerOptions) { o.Config.Image = "alpine" },
		"lookalike image":    func(o *docker.CreateContainerOptions) { o.Config.Image = "evil/judge-go-env" },
		"no label":           func(o *docker.CreateContainerOptions) { delete(o.Config.Labels, "managed-by") },
		"joins a network": func(o *docker.CreateContainerOptions) {
			o.NetworkingConfig = &docker.NetworkingConfig{EndpointsConfig: map[string]*docker.EndpointConfig{"assessment-net": {}}}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			cli, daemon, _ := setup(t)
			opts := sandboxOptions()
			mutate(&opts)
			_, err := cli.CreateContainer(opts)
			if !isForbidden(err) {
				t.Fatalf("want 403, got %v", err)
			}
			if daemon.took("POST /containers/create") {
				t.Fatal("refused create still reached the daemon")
			}
		})
	}
}

func TestGuardRefusesOtherContainers(t *testing.T) {
	cli, daemon, _ := setup(t)
	for _, id := range []string{"mongo1", "fake1"} {
		if _, err := cli.CreateExec(docker.CreateExecOptions{Container: id, Cmd: []string{"sh"}}); !isForbidden(err) {
			t.Errorf("exec into %s: want 403, got %v", id, err)
		}
		if err := cli.RemoveContainer(docker.RemoveContainerOptions{ID: id, Force: true}); !isForbidden(err) {
			t.Errorf("remove %s: want 403, got %v", id, err)
		}
		if _, err := cli.InspectContainerWithOptions(docker.InspectContainerOptions{ID: id}); !isForbidden(err) {
			t.Errorf("inspect %s: want 403, got %v", id, err)
		}
	}
	if _, err := cli.InspectExec("e-mongo"); !isForbidden(err) {
		t.Errorf("exec inspect in another container: want 403, got %v", err)
	}
	if err := cli.StartExec("e-mongo", docker.StartExecOptions{Detach: true}); !isForbidden(err) {
		t.Errorf("exec start in another container: want 403, got %v", err)
	}
	if _, err := cli.CreateExec(docker.CreateExecOptions{Container: "sandbox1", Cmd: []string{"sh"}, Privileged: true}); !isForbidden(err) {
		t.Errorf("privileged exec: want 403, got %v", err)
	}
	if err := cli.UpdateContainer("sandbox1", docker.UpdateContainerOptions{Memory: 64 << 30}); !isForbidden(err) {
		t.Errorf("huge memory update: want 403, got %v", err)
	}
	if err := cli.UpdateContainer("sandbox1", docker.UpdateContainerOptions{RestartPolicy: docker.AlwaysRestart()}); !isForbidden(err) {
		t.Errorf("restart policy update: want 403, got %v", err)
	}
	if err := cli.PullImage(docker.PullImageOptions{Repository: "alpine", Tag: "latest"}, docker.AuthConfiguration{}); !isForbidden(err) {
		t.Errorf("pull alpine: want 403, got %v", err)
	}
	if _, err := cli.ListNetworks(); !isForbidden(err) {
		t.Errorf("list networks: want 403, got %v", err)
	}
	if _, err := cli.ListVolumes(docker.ListVolumesOptions{}); !isForbidden(err) {
		t.Errorf("list volumes: want 403, got %v", err)
	}
	if err := cli.KillContainer(docker.KillContainerOptions{ID: "sandbox1"}); !isForbidden(err) {
		t.Errorf("kill (unused by the judge): want 403, got %v", err)
	}
	if len(daemon.forwarded) != 0 {
		t.Fatalf("refused calls reached the daemon: %v", daemon.forwarded)
	}
}

func TestGuardMissingContainerIs404(t *testing.T) {
	cli, _, _ := setup(t)
	err := cli.RemoveContainer(docker.RemoveContainerOptions{ID: "missing", Force: true})
	if _, ok := err.(*docker.NoSuchContainer); !ok {
		t.Fatalf("want NoSuchContainer, got %T %v", err, err)
	}
}

func TestGuardListsOnlyJudgeContainers(t *testing.T) {
	cli, daemon, _ := setup(t)
	if _, err := cli.ListContainers(docker.ListContainersOptions{All: true}); err != nil {
		t.Fatal(err)
	}
	var filters map[string][]string
	if err := json.Unmarshal([]byte(daemon.lastQuery.Get("filters")), &filters); err != nil {
		t.Fatalf("filters not JSON: %v", err)
	}
	if got := filters["label"]; len(got) != 1 || got[0] != "managed-by=judge-service" {
		t.Fatalf("label filter = %v", got)
	}
	if _, err := cli.ListContainers(docker.ListContainersOptions{All: true, Filters: map[string][]string{"status": {"exited"}}}); err != nil {
		t.Fatal(err)
	}
	_ = json.Unmarshal([]byte(daemon.lastQuery.Get("filters")), &filters)
	if len(filters["status"]) != 1 || len(filters["label"]) != 1 {
		t.Fatalf("filters = %v", filters)
	}
}
