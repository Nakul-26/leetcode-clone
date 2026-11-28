//go:build linux

// judge-agent is the resident process inside each sandbox (JUDGE_AGENT_PLAN Phase 2, Option B).
// The judge starts it once per container, as two long-lived `docker exec`s, and then sends it
// work instead of starting a new `docker exec` for every step of every submission:
//
//	judge-agent runner   as the judge user: runs the commands the judge would otherwise exec
//	                     (upload, compile, run, wipe) and streams their output back
//	judge-agent keeper   as root: kills the judge user's processes between submissions, sparing
//	                     the runner, and runs the judge's few root commands
//	judge-agent spawn    the first step of every command either one starts (see spawn)
//
// The sandbox keeps every restriction it has today, and gets no new capability: no network,
// read-only root filesystem, no-new-privileges, every capability dropped but KILL, memory and
// pids limits, and CPU time read by the root keeper from the sandbox's read-only cgroup counter.
//
// What the agent adds is two processes a submission could try to interfere with:
//
//   - The keeper is root. The judge user cannot signal, trace or read a root process, so a
//     submission cannot touch it at all.
//   - The runner is the judge user, like the submission. It marks itself non-dumpable, so a
//     submission cannot trace it, read its memory or open its file descriptors (the judge's
//     stream). It can still signal it or change its scheduling and limits. Killing or stopping
//     it only fails that submission's own run; the judge then has the keeper kill every judge
//     process and starts a new runner. Changing its nice value, scheduling policy, CPU affinity,
//     I/O priority or resource limits would pass on to later submissions' processes, so the
//     runner checks all of them before every command and on every ping, and refuses to run
//     anything once one has changed; the judge then replaces it the same way.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"judge-service-go/pkg/agentproto"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: judge-agent runner|keeper|spawn -- cmd...|version")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "spawn":
		spawn(os.Args[2:])
	case "version":
		fmt.Println(agentproto.Version)
	case "runner", "keeper":
		// Small and quiet: one thread for Go code, frequent GC. Its memory counts against the
		// sandbox's limit.
		runtime.GOMAXPROCS(1)
		debug.SetGCPercent(25)
		a := newAgent(os.Args[1])
		os.Exit(a.serve(os.Stdin))
	default:
		fmt.Fprintln(os.Stderr, "judge-agent: unknown mode", os.Args[1])
		os.Exit(2)
	}
}

// spawn is the first process of every command the agent runs. It makes itself the first thing
// the kernel's OOM killer picks (oom_score_adj 1000, which needs no privilege to raise), so a
// program over its memory limit is killed rather than the agent, and then becomes the command.
// The command does not inherit the agent's non-dumpable flag: execve resets it.
func spawn(args []string) {
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "judge-agent spawn: no command")
		os.Exit(127)
	}
	_ = os.WriteFile("/proc/self/oom_score_adj", []byte("1000"), 0)
	path := args[0]
	if !strings.Contains(path, "/") {
		p, err := exec.LookPath(path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "exec: %q: executable file not found in $PATH\n", path)
			os.Exit(127)
		}
		path = p
	}
	err := syscall.Exec(path, args, os.Environ())
	fmt.Fprintf(os.Stderr, "exec: %q: %v\n", args[0], err)
	if errors.Is(err, syscall.ENOENT) {
		os.Exit(127)
	}
	os.Exit(126)
}

type agent struct {
	role string
	self string // this binary, for spawn

	wmu sync.Mutex
	out io.Writer

	mu    sync.Mutex
	procs map[uint64]*job

	// runner: its scheduling and limits when it started (see fingerprint)
	initial string

	// keeper: the registered runner and the judge user's uid
	spare      int
	spareStart string
	judgeUID   int
}

type job struct {
	cmd *exec.Cmd
}

func newAgent(role string) *agent {
	self, err := os.Executable()
	if err != nil {
		self = "/usr/local/bin/judge-agent"
	}
	return &agent{role: role, self: self, out: os.Stdout, procs: map[uint64]*job{}, judgeUID: -1}
}

func (a *agent) send(m *agentproto.Msg) {
	a.wmu.Lock()
	defer a.wmu.Unlock()
	if err := agentproto.Write(a.out, m); err != nil {
		// The judge is gone; nothing more can be reported.
		os.Exit(1)
	}
}

func (a *agent) serve(in io.Reader) int {
	if a.role == "runner" {
		// PR_SET_DUMPABLE 0: another judge-user process can no longer ptrace this one, read its
		// memory or open /proc/<pid>/fd, where the judge's stream is.
		if _, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_SET_DUMPABLE, 0, 0); errno != 0 {
			fmt.Fprintln(os.Stderr, "judge-agent: PR_SET_DUMPABLE failed:", errno)
			return 1
		}
		a.initial = fingerprint()
	}
	a.send(&agentproto.Msg{Op: agentproto.OpHello, Version: agentproto.Version, Pid: os.Getpid(), Role: a.role})

	r := bufio.NewReaderSize(in, 64<<10)
	for {
		m, err := agentproto.Read(r)
		if err != nil {
			// The judge closed the stream (or sent garbage): stop everything this agent started.
			a.killAll()
			return 0
		}
		switch m.Op {
		case agentproto.OpExec:
			a.exec(m)
		case agentproto.OpCancel:
			a.cancel(m.ID)
		case agentproto.OpPing:
			a.send(&agentproto.Msg{Op: agentproto.OpPong, Seq: m.Seq, Err: a.tampered()})
		case agentproto.OpRegister:
			a.send(a.register(m))
		case agentproto.OpKillJudge:
			a.send(a.killJudge(m))
		case agentproto.OpCPUTime:
			reply := &agentproto.Msg{Op: agentproto.OpDone, Seq: m.Seq}
			if a.role != "keeper" {
				reply.Code, reply.Err = 1, "CPU time is keeper-only"
			} else if nanos, err := cgroupCPUTimeNanos(); err != nil {
				reply.Code, reply.Err = 1, err.Error()
			} else {
				reply.CPUTimeNanos = nanos
			}
			a.send(reply)
		default:
			a.send(&agentproto.Msg{Op: agentproto.OpDone, Seq: m.Seq, Code: 1, Err: "unknown op " + m.Op})
		}
	}
}

// tampered is "" while the runner's scheduling and limits are as they were at start. Its
// children inherit them, so a change by one submission would follow into the next.
func (a *agent) tampered() string {
	if a.role != "runner" {
		return ""
	}
	if now := fingerprint(); now != a.initial {
		return "tainted: runner state changed (" + now + " vs " + a.initial + ")"
	}
	return ""
}

// fingerprint is everything about this process that another process of the same user can change
// without privilege and that its children inherit: nice value, scheduling policy and priority,
// CPU affinity, I/O priority and every resource limit.
func fingerprint() string {
	var b strings.Builder
	prio, err := syscall.Getpriority(syscall.PRIO_PROCESS, 0)
	fmt.Fprintf(&b, "nice=%d/%v;", prio, err)
	pol, _, e1 := syscall.RawSyscall(syscall.SYS_SCHED_GETSCHEDULER, 0, 0, 0)
	fmt.Fprintf(&b, "sched=%d/%d;", pol, e1)
	var mask [128]byte
	n, _, e3 := syscall.RawSyscall(syscall.SYS_SCHED_GETAFFINITY, 0, uintptr(len(mask)), uintptr(unsafe.Pointer(&mask[0])))
	if e3 == 0 {
		fmt.Fprintf(&b, "cpus=%x;", mask[:n])
	}
	iop, _, e4 := syscall.RawSyscall(syscall.SYS_IOPRIO_GET, 1 /* IOPRIO_WHO_PROCESS */, 0, 0)
	fmt.Fprintf(&b, "io=%d/%d;", iop, e4)
	for res := 0; res < 16; res++ {
		var rl syscall.Rlimit
		if err := syscall.Getrlimit(res, &rl); err == nil {
			fmt.Fprintf(&b, "r%d=%d/%d;", res, rl.Cur, rl.Max)
		}
	}
	return b.String()
}

func (a *agent) exec(m *agentproto.Msg) {
	if t := a.tampered(); t != "" {
		a.send(&agentproto.Msg{Op: agentproto.OpStarted, ID: m.ID, Code: -1, Err: t})
		return
	}
	if len(m.Cmd) == 0 {
		a.send(&agentproto.Msg{Op: agentproto.OpStarted, ID: m.ID, Code: -1, Err: "empty command"})
		return
	}
	cmd := exec.Command(a.self, append([]string{"spawn", "--"}, m.Cmd...)...)
	cmd.Dir = m.Dir
	// Its own process group, so cancel can kill it and whatever it started (unless that left
	// the group; the keeper's kill between tests and submissions covers those).
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	var stdinW *os.File
	if m.HasStdin {
		r, w, err := os.Pipe()
		if err != nil {
			a.send(&agentproto.Msg{Op: agentproto.OpStarted, ID: m.ID, Code: -1, Err: err.Error()})
			return
		}
		cmd.Stdin, stdinW = r, w
		defer r.Close()
	}
	outR, outW, err1 := os.Pipe()
	errR, errW, err2 := os.Pipe()
	if err1 != nil || err2 != nil {
		a.send(&agentproto.Msg{Op: agentproto.OpStarted, ID: m.ID, Code: -1, Err: fmt.Sprint(err1, err2)})
		return
	}
	cmd.Stdout, cmd.Stderr = outW, errW

	if err := cmd.Start(); err != nil {
		outR.Close()
		outW.Close()
		errR.Close()
		errW.Close()
		if stdinW != nil {
			stdinW.Close()
		}
		a.send(&agentproto.Msg{Op: agentproto.OpStarted, ID: m.ID, Code: -1, Err: err.Error()})
		return
	}
	outW.Close()
	errW.Close()

	a.mu.Lock()
	a.procs[m.ID] = &job{cmd: cmd}
	a.mu.Unlock()
	a.send(&agentproto.Msg{Op: agentproto.OpStarted, ID: m.ID})

	if stdinW != nil {
		data := m.Stdin
		go func() {
			// A program that never reads its input gets EPIPE here once it exits; that is fine.
			_, _ = stdinW.Write(data)
			stdinW.Close()
		}()
	}

	go a.finish(m.ID, cmd, outR, errR)
}

// finish streams a command's output, waits for it and reports how it ended. Output written by
// processes it left behind after it exited is read for a short while only: they could hold the
// pipes open forever. (They are killed by the next kill between tests or submissions.)
func (a *agent) finish(id uint64, cmd *exec.Cmd, outR, errR *os.File) {
	var wg sync.WaitGroup
	pump := func(r *os.File, op string) {
		defer wg.Done()
		buf := make([]byte, agentproto.ChunkSize)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				a.send(&agentproto.Msg{Op: op, ID: id, Data: append([]byte(nil), buf[:n]...)})
			}
			if err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go pump(outR, agentproto.OpOut)
	go pump(errR, agentproto.OpErr)

	_ = cmd.Wait()
	drained := make(chan struct{})
	go func() { wg.Wait(); close(drained) }()
	select {
	case <-drained:
	case <-time.After(250 * time.Millisecond):
		outR.Close()
		errR.Close()
		<-drained
	}
	outR.Close()
	errR.Close()

	a.mu.Lock()
	delete(a.procs, id)
	a.mu.Unlock()
	a.send(&agentproto.Msg{Op: agentproto.OpExit, ID: id, Code: exitCode(cmd.ProcessState)})
}

// exitCode reports a process's end the way `docker exec` does: its exit status, or 128 plus the
// signal that killed it.
func exitCode(ps *os.ProcessState) int {
	if ps == nil {
		return -1
	}
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
		return 128 + int(ws.Signal())
	}
	return ps.ExitCode()
}

func (a *agent) cancel(id uint64) {
	a.mu.Lock()
	j := a.procs[id]
	a.mu.Unlock()
	if j != nil && j.cmd.Process != nil {
		_ = syscall.Kill(-j.cmd.Process.Pid, syscall.SIGKILL)
		_ = j.cmd.Process.Kill()
	}
}

func (a *agent) killAll() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, j := range a.procs {
		if j.cmd.Process != nil {
			_ = syscall.Kill(-j.cmd.Process.Pid, syscall.SIGKILL)
			_ = j.cmd.Process.Kill()
		}
	}
}

// register records the runner, once, right after the judge started it and before any
// submission ran in the container: its pid and start time (a pid alone could be reused by a
// submission's process once the runner died) and its uid, which is the judge user's.
func (a *agent) register(m *agentproto.Msg) *agentproto.Msg {
	reply := &agentproto.Msg{Op: agentproto.OpDone, Seq: m.Seq}
	if a.role != "keeper" {
		reply.Code, reply.Err = 1, "register: not the keeper"
		return reply
	}
	start, uid, _, err := procInfo(m.Pid)
	if err != nil {
		reply.Code, reply.Err = 1, "register: "+err.Error()
		return reply
	}
	if uid == 0 {
		reply.Code, reply.Err = 1, "register: the runner must not be root"
		return reply
	}
	if a.judgeUID >= 0 && uid != a.judgeUID {
		reply.Code, reply.Err = 1, "register: runner uid changed"
		return reply
	}
	a.judgeUID, a.spare, a.spareStart = uid, m.Pid, start
	return reply
}

// killJudge kills every process of the judge user, sparing the registered runner if asked to
// (and only if it is still that very process), and waits until none is left. Zombies count as
// left, as with the pgrep check this replaces: nothing in the container reaps them, so a
// container that has them is discarded rather than reused. Done in-process, without forking:
// it must work while a fork bomb holds every pid the container may have.
func (a *agent) killJudge(m *agentproto.Msg) *agentproto.Msg {
	reply := &agentproto.Msg{Op: agentproto.OpDone, Seq: m.Seq}
	if a.role != "keeper" {
		reply.Code, reply.Err = 1, "killjudge: not the keeper"
		return reply
	}
	if a.judgeUID < 0 {
		// No runner registered yet: find the user by name.
		uid, err := lookupUID(m.User)
		if err != nil || uid == 0 {
			reply.Code, reply.Err = 1, fmt.Sprintf("killjudge: user %q: %v", m.User, err)
			return reply
		}
		a.judgeUID = uid
	}
	spare := 0
	if m.Spare {
		if start, uid, _, err := procInfo(a.spare); err == nil && start == a.spareStart && uid == a.judgeUID {
			spare = a.spare
		}
	}
	var left []int
	for i := 0; i < 40; i++ {
		left = left[:0]
		for _, pid := range judgePids(a.judgeUID) {
			if pid == spare {
				continue
			}
			_ = syscall.Kill(pid, syscall.SIGKILL)
			left = append(left, pid)
		}
		if len(left) == 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if spare != 0 {
		// A submission may have stopped it; a stopped runner would hang the next one.
		_ = syscall.Kill(spare, syscall.SIGCONT)
	}
	if len(left) > 0 {
		sort.Ints(left)
		reply.Code, reply.Err = 1, fmt.Sprintf("judge processes survived the reset: %v", left)
	}
	if m.Spare && spare == 0 && reply.Code == 0 {
		reply.Code, reply.Err = 2, "runner gone" // everything killed, the runner included
	}
	return reply
}

// lookupUID finds a user's uid in /etc/passwd (the image's, read-only).
func lookupUID(name string) (int, error) {
	if name == "" {
		return -1, errors.New("no user name")
	}
	data, err := os.ReadFile("/etc/passwd")
	if err != nil {
		return -1, err
	}
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Split(line, ":")
		if len(f) >= 3 && f[0] == name {
			return strconv.Atoi(f[2])
		}
	}
	return -1, errors.New("not in /etc/passwd")
}

// judgePids lists the processes whose real uid is uid, zombies included.
func judgePids(uid int) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var pids []int
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == os.Getpid() {
			continue
		}
		if _, u, _, err := procInfo(pid); err == nil && u == uid {
			pids = append(pids, pid)
		}
	}
	return pids
}

// procInfo reads a process's start time (field 22 of /proc/<pid>/stat, in clock ticks since
// boot), real uid and state. Both files are readable for any process, non-dumpable ones too.
func procInfo(pid int) (start string, uid int, state string, err error) {
	stat, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return "", -1, "", err
	}
	// The command name (field 2) can contain spaces and parentheses; the fields after it start
	// after the last ')'.
	s := string(stat)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return "", -1, "", errors.New("bad stat")
	}
	f := strings.Fields(s[i+1:])
	if len(f) < 20 {
		return "", -1, "", errors.New("short stat")
	}
	state, start = f[0], f[19] // fields 3 and 22
	status, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "status"))
	if err != nil {
		return "", -1, "", err
	}
	for _, line := range strings.Split(string(status), "\n") {
		if strings.HasPrefix(line, "Uid:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				uid, err = strconv.Atoi(fields[1])
				return start, uid, state, err
			}
		}
	}
	return "", -1, "", errors.New("no Uid line")
}
