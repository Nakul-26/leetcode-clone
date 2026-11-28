package compilesvc

import (
	"context"
	"testing"
)

func TestJavacArgs(t *testing.T) {
	// The judge's own stdin-mode javac command (adapters.javacCommand).
	cmd := []string{"javac", "-J-XX:TieredStopAtLevel=1", "-J-XX:+UseSerialGC", "-J-Xshare:auto",
		"-J-XX:SharedArchiveFile=/opt/cds/javac.jsa", "-cp", "/usr/share/java/gson.jar:.", "/app/Main.java"}
	args, sources, ok := javacArgs(cmd)
	if !ok || len(args) != 2 || args[0] != "-cp" || args[1] != "/usr/share/java/gson.jar:." || len(sources) != 1 || sources[0] != "/app/Main.java" {
		t.Fatalf("got args %v sources %v ok %v", args, sources, ok)
	}
	for _, bad := range [][]string{
		{"javac", "-processor", "x.Y", "/app/Main.java"}, // annotation processing
		{"javac", "-proc:full", "/app/Main.java"},
		{"javac", "-d", "/tmp", "/app/Main.java"},
		{"javac", "@argfile"},
		{"javac", "-cp"},                // option without its value
		{"javac", "-J-Xmx1g"},           // no source
		{"sh", "-c", "javac Main.java"}, // function mode's script: not plain javac
	} {
		if _, _, ok := javacArgs(bad); ok && bad[0] == "javac" {
			t.Errorf("accepted %v", bad)
		}
	}
}

func TestSafeClassPath(t *testing.T) {
	for _, ok := range []string{"Main.class", "Main$1.class", "pkg/Main.class", "a/b/C$D.class"} {
		if !safeClassPath(ok) {
			t.Errorf("refused %q", ok)
		}
	}
	for _, bad := range []string{"", "/etc/x.class", "../x.class", "a/../../x.class", "a//b.class", "./x.class", "Main.java", "x.class/..", "a\\b.class"} {
		if safeClassPath(bad) {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestEnabled(t *testing.T) {
	t.Setenv("JUDGE_COMPILE_SERVICE", "")
	if Enabled("java") {
		t.Fatal("on without the variable")
	}
	t.Setenv("JUDGE_COMPILE_SERVICE", " Java , kotlin")
	if !Enabled("java") || !Enabled("kotlin") || Enabled("cpp") {
		t.Fatal("wrong languages")
	}
}

// Compile leaves everything it does not take to the sandbox.
func TestCompileDeclines(t *testing.T) {
	s := &Service{}
	t.Setenv("JUDGE_COMPILE_SERVICE", "")
	if handled, _, _, _ := s.Compile(context.Background(), []string{"javac", "/app/Main.java"}, t.TempDir(), []string{"Main.java"}); handled {
		t.Fatal("handled while off")
	}
	t.Setenv("JUDGE_COMPILE_SERVICE", "java")
	for _, cmd := range [][]string{
		{"g++", "-O2", "main.cpp"},
		{"sh", "-c", "javac x"},
		{"javac", "/app/Other.java"}, // not one of the uploaded files
	} {
		if handled, _, _, _ := s.Compile(context.Background(), cmd, t.TempDir(), []string{"Main.java"}); handled {
			t.Errorf("handled %v", cmd)
		}
	}
}
