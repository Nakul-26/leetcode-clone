import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.TypeAdapter;
import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import com.google.gson.stream.JsonWriter;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.util.*;

class TreeNode {
    int val;
    TreeNode left;
    TreeNode right;
    TreeNode() {}
    TreeNode(int val) { this.val = val; }
    TreeNode(int val, TreeNode left, TreeNode right) {
        this.val = val;
        this.left = left;
        this.right = right;
    }
}

class ListNode {
    int val;
    ListNode next;
    ListNode() {}
    ListNode(int val) { this.val = val; }
    ListNode(int val, ListNode next) { this.val = val; this.next = next; }
}

class Node {
    public int val;
    public List<Node> neighbors;
    public Node() { val = 0; neighbors = new ArrayList<Node>(); }
    public Node(int _val) { val = _val; neighbors = new ArrayList<Node>(); }
    public Node(int _val, ArrayList<Node> _neighbors) { val = _val; neighbors = _neighbors; }
}

public class Main {
    private static class NodeAdapter extends TypeAdapter<Node> {
        @Override
        public void write(JsonWriter out, Node node) throws IOException {
            if (node == null) {
                out.nullValue();
                return;
            }
            Map<Integer, Node> map = new HashMap<>();
            Queue<Node> queue = new LinkedList<>();
            queue.add(node);
            map.put(node.val, node);
            while (!queue.isEmpty()) {
                Node curr = queue.poll();
                for (Node neighbor : curr.neighbors) {
                    if (!map.containsKey(neighbor.val)) {
                        map.put(neighbor.val, neighbor);
                        queue.add(neighbor);
                    }
                }
            }
            out.beginArray();
            for (int i = 1; i <= map.size(); i++) {
                Node n = map.get(i);
                out.beginArray();
                if (n != null) {
                    for (Node neighbor : n.neighbors) {
                        out.value(neighbor.val);
                    }
                }
                out.endArray();
            }
            out.endArray();
        }

        @Override
        public Node read(JsonReader in) throws IOException {
            if (in.peek() == JsonToken.NULL) {
                in.nextNull();
                return null;
            }
            List<List<Integer>> adj = new ArrayList<>();
            in.beginArray();
            while (in.hasNext()) {
                List<Integer> neighbors = new ArrayList<>();
                in.beginArray();
                while (in.hasNext()) {
                    neighbors.add(in.nextInt());
                }
                in.endArray();
                adj.add(neighbors);
            }
            in.endArray();

            if (adj.isEmpty()) return null;
            Node[] nodes = new Node[adj.size()];
            for (int i = 0; i < adj.size(); i++) nodes[i] = new Node(i + 1);
            for (int i = 0; i < adj.size(); i++) {
                for (Integer neighborIdx : adj.get(i)) {
                    nodes[i].neighbors.add(nodes[neighborIdx - 1]);
                }
            }
            return nodes[0];
        }
    }

    private static class TreeNodeAdapter extends TypeAdapter<TreeNode> {
        @Override
        public void write(JsonWriter out, TreeNode root) throws IOException {
            if (root == null) {
                out.nullValue();
                return;
            }
            List<Integer> result = new ArrayList<>();
            Queue<TreeNode> queue = new LinkedList<>();
            queue.add(root);
            while (!queue.isEmpty()) {
                TreeNode node = queue.poll();
                if (node != null) {
                    result.add(node.val);
                    queue.add(node.left);
                    queue.add(node.right);
                } else {
                    result.add(null);
                }
            }
            while (!result.isEmpty() && result.get(result.size() - 1) == null) {
                result.remove(result.size() - 1);
            }
            out.beginArray();
            for (Integer val : result) {
                if (val == null) out.nullValue();
                else out.value(val);
            }
            out.endArray();
        }

        @Override
        public TreeNode read(JsonReader in) throws IOException {
            if (in.peek() == JsonToken.NULL) {
                in.nextNull();
                return null;
            }
            List<Integer> data = new ArrayList<>();
            in.beginArray();
            while (in.hasNext()) {
                if (in.peek() == JsonToken.NULL) {
                    in.nextNull();
                    data.add(null);
                } else {
                    data.add(in.nextInt());
                }
            }
            in.endArray();

            if (data.isEmpty() || data.get(0) == null) return null;

            TreeNode root = new TreeNode(data.get(0));
            Queue<TreeNode> queue = new LinkedList<>();
            queue.add(root);
            int i = 1;
            while (!queue.isEmpty() && i < data.size()) {
                TreeNode node = queue.poll();
                if (i < data.size()) {
                    Integer leftVal = data.get(i++);
                    if (leftVal != null) {
                        node.left = new TreeNode(leftVal);
                        queue.add(node.left);
                    }
                }
                if (i < data.size()) {
                    Integer rightVal = data.get(i++);
                    if (rightVal != null) {
                        node.right = new TreeNode(rightVal);
                        queue.add(node.right);
                    }
                }
            }
            return root;
        }
    }

    private static class ListNodeAdapter extends TypeAdapter<ListNode> {
        @Override
        public void write(JsonWriter out, ListNode head) throws IOException {
            if (head == null) {
                out.nullValue();
                return;
            }
            out.beginArray();
            ListNode curr = head;
            while (curr != null) {
                out.value(curr.val);
                curr = curr.next;
            }
            out.endArray();
        }

        @Override
        public ListNode read(JsonReader in) throws IOException {
            if (in.peek() == JsonToken.NULL) {
                in.nextNull();
                return null;
            }
            List<Integer> data = new ArrayList<>();
            in.beginArray();
            while (in.hasNext()) {
                if (in.peek() == JsonToken.NULL) {
                    in.nextNull();
                } else {
                    data.add(in.nextInt());
                }
            }
            in.endArray();

            if (data.isEmpty()) return null;
            ListNode dummy = new ListNode();
            ListNode curr = dummy;
            for (Integer val : data) {
                curr.next = new ListNode(val == null ? 0 : val);
                curr = curr.next;
            }
            return dummy.next;
        }
    }

    private static final Gson GSON = new GsonBuilder()
        .registerTypeAdapter(TreeNode.class, new TreeNodeAdapter())
        .registerTypeAdapter(ListNode.class, new ListNodeAdapter())
        .registerTypeAdapter(Node.class, new NodeAdapter())
        .create();

    public static void main(String[] args) {
        try {
            JsonArray tests = GSON.fromJson(
                decodePayload(args),
                JsonArray.class
            );
            if (tests == null) {
                throw new IllegalArgumentException("missing batched test payload");
            }

            java.io.PrintStream realOut = System.out;
            for (int i = 0; i < tests.size(); i++) {
                JsonObject payload = tests.get(i).getAsJsonObject();
                JsonArray inputs = payload.getAsJsonArray("inputs");
                CapturedStdout captured = new CapturedStdout();
                System.setOut(new java.io.PrintStream(captured, true, "UTF-8"));

                try {
                    Method method = resolveMethod(inputs == null ? 0 : inputs.size());
                    Object[] argsValues = prepareArgs(method, inputs);
                    Object output = invoke(method, argsValues);

                    JsonObject result = new JsonObject();
                    result.addProperty("test", i + 1);
                    if (method.getReturnType().equals(Void.TYPE) && argsValues.length > 0) {
                        result.add("output", GSON.toJsonTree(argsValues[0]));
                    } else {
                        result.add("output", GSON.toJsonTree(output));
                    }
                    System.setOut(realOut);
                    result.addProperty("stdout", captured.value());
                    System.err.println(GSON.toJson(result));
                } catch (InvocationTargetException err) {
                    System.setOut(realOut);
                    Throwable cause = err.getCause() != null ? err.getCause() : err;
                    System.err.println(errorPayload(i + 1, cause, captured.value()));
                } catch (Throwable err) {
                    System.setOut(realOut);
                    System.err.println(errorPayload(i + 1, err, captured.value()));
                } finally {
                    System.setOut(realOut);
                }
            }
        } catch (Throwable err) {
            JsonObject fatal = new JsonObject();
            fatal.addProperty("fatal", stackTrace(err));
            System.err.println(GSON.toJson(fatal));
        }
    }

    private static String decodePayload(String[] args) {
        if (args.length == 0) {
            throw new IllegalArgumentException("missing input payload");
        }
        byte[] decoded = Base64.getDecoder().decode(args[0]);
        return new String(decoded, StandardCharsets.UTF_8);
    }

    private static Method resolveMethod(int argCount) throws NoSuchMethodException {
        for (Method method : Solution.class.getDeclaredMethods()) {
            if (method.getName().equals("{{FUNCTION_NAME}}") && method.getParameterCount() == argCount) {
                method.setAccessible(true);
                return method;
            }
        }
        throw new NoSuchMethodException("method {{FUNCTION_NAME}} with " + argCount + " arguments not found");
    }

    private static Object[] prepareArgs(Method method, JsonArray inputs) {
        Type[] parameterTypes = method.getGenericParameterTypes();
        Object[] args = new Object[parameterTypes.length];
        for (int i = 0; i < parameterTypes.length; i++) {
            JsonElement input = inputs != null && i < inputs.size() ? inputs.get(i) : JsonNull.INSTANCE;
            args[i] = GSON.fromJson(input, parameterTypes[i]);
        }
        return args;
    }

    private static Object invoke(Method method, Object[] args) throws InvocationTargetException, IllegalAccessException {
        Solution solution = new Solution();
        return method.invoke(solution, args);
    }

    private static String errorPayload(int test, Throwable err, String stdout) {
        JsonObject result = new JsonObject();
        result.addProperty("test", test);
        result.addProperty("error", err.getClass().getSimpleName());
        result.addProperty("traceback", stackTrace(err));
        result.addProperty("stdout", stdout);
        return GSON.toJson(result);
    }

    // What a test prints, kept up to just past the judge's output limit (64 KB) so a print
    // loop cannot fill memory; the judge fails a test that goes over with Output Limit Exceeded.
    static class CapturedStdout extends java.io.OutputStream {
        private static final int CAP = 64 * 1024 + 1;
        private final java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();

        @Override
        public void write(int b) {
            if (buf.size() < CAP) buf.write(b);
        }

        @Override
        public void write(byte[] b, int off, int len) {
            int room = CAP - buf.size();
            if (room > 0) buf.write(b, off, Math.min(len, room));
        }

        String value() {
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static String stackTrace(Throwable err) {
        StringWriter sw = new StringWriter();
        PrintWriter pw = new PrintWriter(sw);
        err.printStackTrace(pw);
        pw.flush();
        return sw.toString();
    }
}
