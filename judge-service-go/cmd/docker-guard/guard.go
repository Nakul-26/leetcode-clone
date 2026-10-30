package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"sync"
)

// guard is the only thing that holds the Docker socket. It forwards a request to the daemon
// only when it is one the judge needs, and only for the judge's own sandboxes (JUDGE_FIX_PLAN
// S2). tecnativa/docker-socket-proxy, which it replaces, filters on URL path alone: once
// container creation and exec were allowed, a compromised judge could create a privileged
// container with the host's / mounted, or exec into any container on the host (Mongo, other
// projects), which is root on the host either way.
//
// The rules:
//   - containers can only be created from a judge image (judge-<lang>-env), with the
//     judge's label, and with the sandbox settings (no network, read-only root, every
//     capability dropped but KILL, no-new-privileges, a memory and pids limit) and nothing
//     else on the host side: no mounts, devices, host namespaces or privileged mode;
//   - every other container call (start, inspect, stats, exec, update, remove) and every
//     exec call must name a container that carries the judge's label and runs a judge image;
//   - execs cannot be privileged; resource updates can only change memory and CPU limits;
//   - listing containers only ever lists the judge's own;
//   - images can only be inspected or pulled when they are judge images;
//   - everything else is refused.
type guard struct {
	proxy    *httputil.ReverseProxy
	upstream *http.Client // for the guard's own inspect calls
	base     *url.URL

	imageRE     *regexp.Regexp
	labelKey    string
	labelValue  string
	maxMemoryMb int64

	mu         sync.Mutex
	containers map[string]bool   // container reference -> is a judge sandbox
	execs      map[string]string // exec ID -> container ID
}

const (
	maxBodyBytes  = 1 << 20
	maxCacheItems = 10000
)

func newGuard(base *url.URL, transport http.RoundTripper) *guard {
	g := &guard{
		upstream:    &http.Client{Transport: transport},
		base:        base,
		imageRE:     regexp.MustCompile(`^judge-[a-z0-9]+-env(:[A-Za-z0-9_.-]+)?$`),
		labelKey:    "managed-by",
		labelValue:  "judge-service",
		maxMemoryMb: 4096,
		containers:  map[string]bool{},
		execs:       map[string]string{},
	}
	g.proxy = &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(base)
			r.Out.Host = base.Host
		},
		Transport:     transport,
		FlushInterval: -1, // stream pull progress and similar as it comes
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			slog.Warn("upstream error", "method", r.Method, "path", r.URL.Path, "error", err)
			writeError(w, http.StatusBadGateway, "docker daemon unreachable")
		},
	}
	return g
}

var versionPrefix = regexp.MustCompile(`^/v[0-9]+(\.[0-9]+)?(/.*)$`)

func (g *guard) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if m := versionPrefix.FindStringSubmatch(path); m != nil {
		path = m[2]
	}
	if err := g.check(r, path); err != nil {
		status := http.StatusForbidden
		var bad badRequest
		var missing notFound
		switch {
		case errors.As(err, &bad):
			status = http.StatusBadRequest
		case errors.As(err, &missing):
			status = http.StatusNotFound
		}
		slog.Warn("refused", "method", r.Method, "path", r.URL.Path, "reason", err.Error())
		writeError(w, status, "docker-guard: "+err.Error())
		return
	}
	if r.Method == http.MethodDelete && strings.HasPrefix(path, "/containers/") {
		g.forget(strings.TrimPrefix(path, "/containers/"))
	}
	g.proxy.ServeHTTP(w, r)
}

type badRequest struct{ error }

// notFound is answered with 404, as the daemon would, so the client sees "no such container".
type notFound struct{ error }

func (g *guard) check(r *http.Request, path string) error {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	switch {
	case path == "/_ping" && (r.Method == http.MethodGet || r.Method == http.MethodHead),
		path == "/version" && r.Method == http.MethodGet:
		return nil

	case path == "/containers/json" && r.Method == http.MethodGet:
		return g.restrictListToJudge(r)

	case path == "/containers/create" && r.Method == http.MethodPost:
		body, err := readBody(r)
		if err != nil {
			return err
		}
		return g.checkCreate(body)

	case parts[0] == "containers" && len(parts) >= 2:
		id := parts[1]
		action := strings.Join(parts[2:], "/")
		allowed := map[string]string{
			"":       http.MethodDelete,
			"json":   http.MethodGet,
			"start":  http.MethodPost,
			"stats":  http.MethodGet,
			"exec":   http.MethodPost,
			"update": http.MethodPost,
		}
		if m, ok := allowed[action]; !ok || m != r.Method {
			return fmt.Errorf("%s /containers/{id}/%s is not allowed", r.Method, action)
		}
		if err := g.requireSandbox(r.Context(), id); err != nil {
			return err
		}
		switch action {
		case "exec":
			body, err := readBody(r)
			if err != nil {
				return err
			}
			return checkExecCreate(body)
		case "update":
			body, err := readBody(r)
			if err != nil {
				return err
			}
			return g.checkUpdate(body)
		}
		return nil

	case parts[0] == "exec" && len(parts) == 3 &&
		((parts[2] == "start" && r.Method == http.MethodPost) || (parts[2] == "json" && r.Method == http.MethodGet)):
		return g.requireSandboxExec(r.Context(), parts[1])

	case parts[0] == "images" && r.Method == http.MethodGet && len(parts) >= 3 && parts[len(parts)-1] == "json":
		name := strings.Join(parts[1:len(parts)-1], "/")
		if !g.imageRE.MatchString(name) {
			return fmt.Errorf("image %q is not a judge image", name)
		}
		return nil

	case path == "/images/create" && r.Method == http.MethodPost:
		q := r.URL.Query()
		name := q.Get("fromImage")
		if tag := q.Get("tag"); tag != "" && !strings.Contains(name, ":") {
			name += ":" + tag
		}
		if q.Get("fromSrc") != "" || !g.imageRE.MatchString(name) {
			return fmt.Errorf("pulling %q is not allowed: not a judge image", name)
		}
		return nil
	}
	return fmt.Errorf("%s %s is not allowed", r.Method, path)
}

// restrictListToJudge adds the judge's label to the list filters, so listing containers
// cannot reveal anything else running on the host.
func (g *guard) restrictListToJudge(r *http.Request) error {
	q := r.URL.Query()
	filters := map[string][]string{}
	if raw := q.Get("filters"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &filters); err != nil {
			// The older {"label": {"k=v": true}} form.
			var old map[string]map[string]bool
			if err2 := json.Unmarshal([]byte(raw), &old); err2 != nil {
				return badRequest{fmt.Errorf("unreadable filters: %v", err)}
			}
			filters = map[string][]string{}
			for k, set := range old {
				for v, on := range set {
					if on {
						filters[k] = append(filters[k], v)
					}
				}
			}
		}
	}
	filters["label"] = append(filters["label"], g.labelKey+"="+g.labelValue)
	enc, _ := json.Marshal(filters)
	q.Set("filters", string(enc))
	r.URL.RawQuery = q.Encode()
	return nil
}

// checkCreate validates a container-create body. Image and labels are checked in the
// container config; the host side is an allowlist: any HostConfig field outside it must be
// unset (zero), so a field added to Docker later is refused rather than passed through.
func (g *guard) checkCreate(body map[string]any) error {
	image, _ := body["Image"].(string)
	if !g.imageRE.MatchString(image) {
		return fmt.Errorf("image %q is not a judge image", image)
	}
	labels, _ := body["Labels"].(map[string]any)
	if v, _ := labels[g.labelKey].(string); v != g.labelValue {
		return fmt.Errorf("container must carry label %s=%s", g.labelKey, g.labelValue)
	}
	if v, ok := body["Volumes"]; ok && !isZero(v) {
		return errors.New("Volumes is not allowed")
	}
	if nc, ok := body["NetworkingConfig"]; ok && !isZero(nc) {
		return errors.New("NetworkingConfig is not allowed: sandboxes join no network")
	}
	hc, _ := body["HostConfig"].(map[string]any)
	if hc == nil {
		return errors.New("HostConfig is required")
	}
	return g.checkHostConfig(hc)
}

func (g *guard) checkHostConfig(hc map[string]any) error {
	allowed := map[string]bool{
		"Memory": true, "MemorySwap": true, "MemoryReservation": true, "MemorySwappiness": true,
		"NanoCpus": true, "CpuQuota": true, "CpuPeriod": true, "CpuShares": true,
		"PidsLimit": true, "Ulimits": true, "Tmpfs": true, "ShmSize": true,
		"ReadonlyRootfs": true, "SecurityOpt": true, "CapDrop": true, "CapAdd": true,
		"NetworkMode": true, "Init": true, "AutoRemove": true, "OomScoreAdj": true,
		"Runtime": true, "LogConfig": true, "RestartPolicy": true, "CgroupnsMode": true,
		"ConsoleSize": true, // always sent by go-dockerclient; the TTY size
	}
	for k, v := range hc {
		if !allowed[k] && !isZero(v) {
			return fmt.Errorf("HostConfig.%s is not allowed", k)
		}
	}
	if mode, _ := hc["NetworkMode"].(string); mode != "none" {
		return fmt.Errorf("HostConfig.NetworkMode must be none, not %q", mode)
	}
	if ro, _ := hc["ReadonlyRootfs"].(bool); !ro {
		return errors.New("HostConfig.ReadonlyRootfs must be true")
	}
	if !containsFold(stringList(hc["CapDrop"]), "ALL") {
		return errors.New("HostConfig.CapDrop must include ALL")
	}
	for _, c := range stringList(hc["CapAdd"]) {
		if c = strings.TrimPrefix(strings.ToUpper(c), "CAP_"); c != "KILL" {
			return fmt.Errorf("capability %s is not allowed", c)
		}
	}
	nnp := false
	for _, opt := range stringList(hc["SecurityOpt"]) {
		switch strings.ReplaceAll(opt, "=", ":") {
		case "no-new-privileges", "no-new-privileges:true":
			nnp = true
		default:
			return fmt.Errorf("security option %q is not allowed", opt)
		}
	}
	if !nnp {
		return errors.New("HostConfig.SecurityOpt must include no-new-privileges")
	}
	if mem := number(hc["Memory"]); mem <= 0 || mem > g.maxMemoryMb<<20 {
		return fmt.Errorf("HostConfig.Memory must be set and at most %d MB", g.maxMemoryMb)
	}
	if pids := number(hc["PidsLimit"]); pids <= 0 {
		return errors.New("HostConfig.PidsLimit must be set")
	}
	switch rt, _ := hc["Runtime"].(string); rt {
	case "", "runc", "runsc":
	default:
		return fmt.Errorf("runtime %q is not allowed", rt)
	}
	if rp, ok := hc["RestartPolicy"].(map[string]any); ok {
		if name, _ := rp["Name"].(string); name != "" && name != "no" {
			return errors.New("HostConfig.RestartPolicy is not allowed")
		}
	}
	switch mode, _ := hc["CgroupnsMode"].(string); mode {
	case "", "private":
	default:
		return fmt.Errorf("cgroup namespace mode %q is not allowed", mode)
	}
	if lc, ok := hc["LogConfig"].(map[string]any); ok && !isZero(lc["Type"]) {
		return errors.New("HostConfig.LogConfig is not allowed")
	}
	return nil
}

func checkExecCreate(body map[string]any) error {
	if p, _ := body["Privileged"].(bool); p {
		return errors.New("privileged exec is not allowed")
	}
	return nil
}

// checkUpdate allows changing memory and CPU limits only (the judge raises and restores a
// container's memory limit around each run).
func (g *guard) checkUpdate(body map[string]any) error {
	allowed := map[string]bool{
		"Memory": true, "MemorySwap": true, "MemoryReservation": true,
		"CpuQuota": true, "CpuPeriod": true, "CpuShares": true, "NanoCpus": true,
	}
	for k, v := range body {
		// go-dockerclient sends the options struct as-is, including its untagged Go
		// context (a timeout context serialises with nested fields); the daemon ignores it.
		if k == "Context" {
			continue
		}
		if !allowed[k] && !isZero(v) {
			return fmt.Errorf("updating %s is not allowed", k)
		}
	}
	if mem := number(body["Memory"]); mem < 0 || mem > g.maxMemoryMb<<20 {
		return fmt.Errorf("Memory must be at most %d MB", g.maxMemoryMb)
	}
	return nil
}

// requireSandbox checks that ref names a judge sandbox: it carries the judge's label, runs a
// judge image and was not given host access. Containers only get that label and image
// through checkCreate, and their settings cannot be changed afterwards except through
// checkUpdate, so the answer is cached.
func (g *guard) requireSandbox(ctx context.Context, ref string) error {
	g.mu.Lock()
	ok, known := g.containers[ref]
	g.mu.Unlock()
	if !known {
		var err error
		ok, err = g.inspectSandbox(ctx, ref)
		if err != nil {
			return err
		}
		g.mu.Lock()
		if len(g.containers) >= maxCacheItems {
			g.containers = map[string]bool{}
		}
		g.containers[ref] = ok
		g.mu.Unlock()
	}
	if !ok {
		return fmt.Errorf("container %s is not a judge sandbox", ref)
	}
	return nil
}

func (g *guard) inspectSandbox(ctx context.Context, ref string) (bool, error) {
	var c struct {
		Config struct {
			Image  string
			Labels map[string]string
		}
		HostConfig struct {
			Privileged  bool
			NetworkMode string
			PidMode     string
			IpcMode     string
			UTSMode     string
			UsernsMode  string
			CapAdd      []string
			Binds       []string
		}
		Mounts []json.RawMessage
	}
	status, err := g.get(ctx, "/containers/"+url.PathEscape(ref)+"/json", &c)
	if err != nil {
		return false, err
	}
	if status == http.StatusNotFound {
		return false, notFound{fmt.Errorf("no such container: %s", ref)}
	}
	if status != http.StatusOK {
		return false, fmt.Errorf("inspecting container %s: HTTP %d", ref, status)
	}
	h := c.HostConfig
	sandbox := c.Config.Labels[g.labelKey] == g.labelValue &&
		g.imageRE.MatchString(c.Config.Image) &&
		!h.Privileged && h.NetworkMode == "none" && len(h.Binds) == 0 && len(c.Mounts) == 0 &&
		!strings.Contains(h.PidMode+h.IpcMode+h.UTSMode+h.UsernsMode, "host") &&
		!strings.Contains(h.PidMode+h.IpcMode, "container:")
	for _, cp := range h.CapAdd {
		if strings.TrimPrefix(strings.ToUpper(cp), "CAP_") != "KILL" {
			sandbox = false
		}
	}
	return sandbox, nil
}

func (g *guard) requireSandboxExec(ctx context.Context, execID string) error {
	g.mu.Lock()
	containerID, known := g.execs[execID]
	g.mu.Unlock()
	if !known {
		var e struct{ ContainerID string }
		status, err := g.get(ctx, "/exec/"+url.PathEscape(execID)+"/json", &e)
		if err != nil {
			return err
		}
		if status == http.StatusNotFound {
			return notFound{fmt.Errorf("no such exec instance: %s", execID)}
		}
		if status != http.StatusOK || e.ContainerID == "" {
			return fmt.Errorf("inspecting exec %s: HTTP %d", execID, status)
		}
		containerID = e.ContainerID
		g.mu.Lock()
		if len(g.execs) >= maxCacheItems {
			g.execs = map[string]string{}
		}
		g.execs[execID] = containerID
		g.mu.Unlock()
	}
	return g.requireSandbox(ctx, containerID)
}

func (g *guard) forget(ref string) {
	ref = strings.Trim(ref, "/")
	g.mu.Lock()
	delete(g.containers, ref)
	g.mu.Unlock()
}

func (g *guard) get(ctx context.Context, path string, into any) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.base.String()+path, nil)
	if err != nil {
		return 0, err
	}
	resp, err := g.upstream.Do(req)
	if err != nil {
		return 0, fmt.Errorf("docker daemon unreachable: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, resp.Body)
		return resp.StatusCode, nil
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBodyBytes)).Decode(into); err != nil {
		return 0, fmt.Errorf("reading %s: %w", path, err)
	}
	return resp.StatusCode, nil
}

// readBody reads and parses a JSON request body and puts it back for forwarding.
func readBody(r *http.Request) (map[string]any, error) {
	data, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		return nil, badRequest{err}
	}
	if len(data) > maxBodyBytes {
		return nil, badRequest{errors.New("request body too large")}
	}
	r.Body = io.NopCloser(bytes.NewReader(data))
	r.ContentLength = int64(len(data))
	body := map[string]any{}
	if len(bytes.TrimSpace(data)) == 0 {
		return body, nil
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if err := dec.Decode(&body); err != nil {
		return nil, badRequest{fmt.Errorf("unreadable JSON body: %v", err)}
	}
	return body, nil
}

func isZero(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case bool:
		return !t
	case string:
		return t == ""
	case json.Number:
		f, err := t.Float64()
		return err == nil && f == 0
	case float64:
		return t == 0
	case []any:
		return len(t) == 0
	case map[string]any:
		// An object is unset when all its fields are (go-dockerclient sends empty structs
		// such as RestartPolicy{} in full). An object inside it must have no keys at all:
		// in a map keyed by names, such as {"assessment-net": {}}, the key is the setting.
		for _, x := range t {
			if inner, ok := x.(map[string]any); ok {
				if len(inner) > 0 {
					return false
				}
			} else if !isZero(x) {
				return false
			}
		}
		return true
	}
	return false
}

func number(v any) int64 {
	switch t := v.(type) {
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return i
		}
		if f, err := t.Float64(); err == nil {
			return int64(f)
		}
	case float64:
		return int64(t)
	}
	return 0
}

func stringList(v any) []string {
	list, _ := v.([]any)
	out := make([]string, 0, len(list))
	for _, x := range list {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func containsFold(list []string, s string) bool {
	for _, x := range list {
		if strings.EqualFold(x, s) {
			return true
		}
	}
	return false
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"message": msg})
}
