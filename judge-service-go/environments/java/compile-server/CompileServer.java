import com.google.gson.Gson;
import com.google.gson.JsonObject;

import javax.tools.JavaCompiler;
import javax.tools.ToolProvider;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * The resident Java compiler (pkg/compilesvc). A fresh javac process costs ~340 ms on one core,
 * almost all of it starting the JVM; in a JVM that keeps running, a compile takes ~60 ms. The
 * judge starts this once in a locked-down container of its own (no network, read-only root
 * filesystem, not root, no capabilities) and sends it source files; it answers with javac's
 * output and the class files, which the judge puts into the submission's sandbox. Submitted
 * code never runs here: annotation processing is always off, so javac only reads it.
 *
 * Frames on stdin/stdout: a 4-byte big-endian length, then UTF-8 JSON.
 *   hello (from us):   {"hello":"judge-compile-server","version":1}
 *   request:           {"id":N,"files":{"Main.java":"<base64>"},"args":["-cp","..."]}
 *   reply:             {"id":N,"exit":0,"output":"<javac's messages>","files":{"Main.class":"<base64>"}}
 *                      exit -1 with "output" set when the request itself was refused.
 *
 * After maxCompiles compiles it marks its replies "retire": the judge then sends new compiles
 * to a fresh server and closes this one's stdin once its last answer is back, so no request is
 * lost at a recycle. It exits when stdin closes, and at once if a compile runs longer than the
 * time limit, since a compiler thread cannot be stopped safely.
 */
public final class CompileServer {
    private static final int VERSION = 1;
    private static final int MAX_FRAME = 16 << 20;
    private static final int MAX_SOURCE_BYTES = 1 << 20;
    private static final long MAX_OUTPUT_BYTES = 32L << 20;
    private static final Pattern SOURCE_NAME = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*\\.java");
    private static final Gson GSON = new Gson();

    private static final Object OUT_LOCK = new Object();
    private static DataOutputStream out;

    public static void main(String[] args) throws Exception {
        int threads = args.length > 0 ? Integer.parseInt(args[0]) : 2;
        int maxCompiles = args.length > 1 ? Integer.parseInt(args[1]) : 500;
        long timeoutMs = args.length > 2 ? Long.parseLong(args[2]) : 30000;

        // Our own stdout carries frames only; anything else (javac never prints here, but a
        // library might) goes to stderr.
        out = new DataOutputStream(new java.io.BufferedOutputStream(new java.io.FileOutputStream(java.io.FileDescriptor.out)));
        System.setOut(new PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.err), true));

        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            System.err.println("judge-compile-server: no system Java compiler");
            System.exit(2);
        }
        JsonObject hello = new JsonObject();
        hello.addProperty("hello", "judge-compile-server");
        hello.addProperty("version", VERSION);
        send(hello);

        ExecutorService workers = Executors.newFixedThreadPool(threads, r -> {
            Thread t = new Thread(r, "compile");
            t.setDaemon(true);
            return t;
        });
        ExecutorService watchers = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "watch");
            t.setDaemon(true);
            return t;
        });
        AtomicInteger started = new AtomicInteger();
        AtomicInteger finished = new AtomicInteger();
        DataInputStream in = new DataInputStream(new java.io.BufferedInputStream(System.in));

        while (true) {
            byte[] frame;
            try {
                int n = in.readInt();
                if (n < 0 || n > MAX_FRAME) {
                    System.err.println("judge-compile-server: frame of " + n + " bytes");
                    System.exit(3);
                }
                frame = new byte[n];
                in.readFully(frame);
            } catch (EOFException e) {
                System.exit(0); // the judge closed the stream
                return;
            }
            Request req;
            try {
                req = GSON.fromJson(new String(frame, StandardCharsets.UTF_8), Request.class);
            } catch (RuntimeException e) {
                System.err.println("judge-compile-server: bad request: " + e);
                System.exit(3);
                return;
            }
            final Request r = req;
            started.incrementAndGet();
            long queuedAt = System.nanoTime();
            Future<Reply> f = workers.submit(() -> {
                long began = System.nanoTime();
                Reply result = compile(compiler, r);
                result.queueNanos = began - queuedAt;
                result.compileNanos = System.nanoTime() - began;
                return result;
            });
            watchers.submit(() -> {
                Reply reply;
                try {
                    reply = f.get(timeoutMs, TimeUnit.MILLISECONDS);
                } catch (TimeoutException e) {
                    System.err.println("judge-compile-server: compile " + r.id + " ran over " + timeoutMs + " ms; exiting");
                    System.exit(4);
                    return;
                } catch (Exception e) {
                    reply = refused(r.id, "compile failed: " + e);
                }
                JsonObject o = reply.toJson();
                if (finished.incrementAndGet() >= maxCompiles) {
                    o.addProperty("retire", true);
                }
                send(o);
            });
        }
    }

    private static final class Request {
        long id;
        Map<String, String> files;
        List<String> args;
    }

    private static final class Reply {
        long id;
        int exit;
        long queueNanos;
        long compileNanos;
        String output;
        Map<String, String> files = new HashMap<>();

        JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("id", id);
            o.addProperty("exit", exit);
            o.addProperty("queueNanos", queueNanos);
            o.addProperty("compileNanos", compileNanos);
            o.addProperty("output", output == null ? "" : output);
            JsonObject fs = new JsonObject();
            for (Map.Entry<String, String> e : files.entrySet()) {
                fs.addProperty(e.getKey(), e.getValue());
            }
            o.add("files", fs);
            return o;
        }
    }

    private static Reply refused(long id, String why) {
        Reply r = new Reply();
        r.id = id;
        r.exit = -1;
        r.output = why;
        return r;
    }

    private static Reply compile(JavaCompiler compiler, Request req) throws IOException {
        if (req.files == null || req.files.isEmpty()) {
            return refused(req.id, "no source files");
        }
        Path dir = Files.createTempDirectory("cs");
        try {
            List<String> argv = new ArrayList<>();
            if (req.args != null) {
                for (String a : req.args) {
                    // Annotation processors are the one way javac runs code it is given;
                    // processor options are refused and processing is forced off below.
                    if (a.startsWith("-proc") || a.startsWith("-processor") || a.startsWith("-Xplugin") || a.startsWith("-J") || a.equals("-d") || a.startsWith("@")) {
                        return refused(req.id, "option not allowed: " + a);
                    }
                    argv.add(a);
                }
            }
            argv.add("-proc:none");
            argv.add("-d");
            argv.add(dir.toString());
            long total = 0;
            for (Map.Entry<String, String> e : req.files.entrySet()) {
                String name = e.getKey();
                if (!SOURCE_NAME.matcher(name).matches()) {
                    return refused(req.id, "bad source name: " + name);
                }
                byte[] src = Base64.getDecoder().decode(e.getValue());
                total += src.length;
                if (total > MAX_SOURCE_BYTES) {
                    return refused(req.id, "sources over " + MAX_SOURCE_BYTES + " bytes");
                }
                Path p = dir.resolve(name);
                Files.write(p, src);
                argv.add(p.toString());
            }

            ByteArrayOutputStream messages = new ByteArrayOutputStream();
            PrintStream ps = new PrintStream(messages, true, "UTF-8");
            int exit = compiler.run(null, ps, ps, argv.toArray(new String[0]));
            ps.flush();

            Reply reply = new Reply();
            reply.id = req.id;
            reply.exit = exit;
            // Paths as javac prints them for a file in the submission's own directory.
            reply.output = messages.toString("UTF-8").replace(dir.toString() + "/", "");
            if (exit == 0) {
                long size = 0;
                try (Stream<Path> walk = Files.walk(dir)) {
                    for (Path p : (Iterable<Path>) walk::iterator) {
                        if (!Files.isRegularFile(p) || !p.getFileName().toString().endsWith(".class")) {
                            continue;
                        }
                        byte[] b = Files.readAllBytes(p);
                        size += b.length;
                        if (size > MAX_OUTPUT_BYTES) {
                            return refused(req.id, "class files over " + MAX_OUTPUT_BYTES + " bytes");
                        }
                        reply.files.put(dir.relativize(p).toString(), Base64.getEncoder().encodeToString(b));
                    }
                }
            }
            return reply;
        } finally {
            try (Stream<Path> walk = Files.walk(dir)) {
                walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
            } catch (IOException ignored) {
            }
        }
    }

    private static void send(JsonObject o) {
        byte[] b = GSON.toJson(o).getBytes(StandardCharsets.UTF_8);
        synchronized (OUT_LOCK) {
            try {
                out.writeInt(b.length);
                out.write(b);
                out.flush();
            } catch (IOException e) {
                System.exit(0); // the judge is gone
            }
        }
    }
}
