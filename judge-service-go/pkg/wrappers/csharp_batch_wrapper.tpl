using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Collections.Generic;
using System.Reflection;
using System.Linq;

// USER_CODE_MARKER

public class TreeNode {
    public int val;
    public TreeNode left;
    public TreeNode right;
    public TreeNode(int val=0, TreeNode left=null, TreeNode right=null) {
        this.val = val;
        this.left = left;
        this.right = right;
    }
}

public class ListNode {
    public int val;
    public ListNode next;
    public ListNode(int val=0, ListNode next=null) {
        this.val = val;
        this.next = next;
    }
}

public class Node {
    public int val;
    public IList<Node> neighbors;
    public Node() {
        val = 0;
        neighbors = new List<Node>();
    }
    public Node(int _val) {
        val = _val;
        neighbors = new List<Node>();
    }
    public Node(int _val, List<Node> _neighbors) {
        val = _val;
        neighbors = _neighbors;
    }
}

// USER_CODE_MARKER

public static class Harness
{
    static object ConvertInput(JsonElement el, string typeStr)
    {
        if (typeStr == "tree<number>") return BuildTree(el);
        if (typeStr == "linkedlist<number>") return BuildLinkedList(el);
        if (typeStr == "graph<number>") return BuildGraph(el);
        
        return el.ValueKind switch
        {
            JsonValueKind.Number => el.TryGetInt32(out int i) ? i : (object)el.GetDouble(),
            JsonValueKind.String => el.GetString(),
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Array => ConvertArray(el, typeStr),
            _ => null
        };
    }

    static object ConvertArray(JsonElement el, string typeStr)
    {
        var list = new List<object>();
        string innerType = "";
        if (typeStr.StartsWith("array<") && typeStr.EndsWith(">"))
            innerType = typeStr.Substring(6, typeStr.Length - 7);
        else if (typeStr.StartsWith("matrix<") && typeStr.EndsWith(">"))
            innerType = "array<" + typeStr.Substring(7, typeStr.Length - 8) + ">";

        foreach (var item in el.EnumerateArray())
        {
            list.Add(ConvertInput(item, innerType));
        }

        if (innerType == "number") return list.Cast<int>().ToArray();
        if (innerType == "string") return list.Cast<string>().ToArray();
        if (innerType == "boolean") return list.Cast<bool>().ToArray();
        if (innerType.StartsWith("array<number>")) return list.Cast<int[]>().ToArray();
        if (innerType.StartsWith("array<string>")) return list.Cast<string[]>().ToArray();
        if (innerType.StartsWith("array<boolean>")) return list.Cast<bool[]>().ToArray();

        return list.ToArray();
    }

    static TreeNode BuildTree(JsonElement el)
    {
        if (el.ValueKind == JsonValueKind.Null || (el.ValueKind == JsonValueKind.Array && el.GetArrayLength() == 0)) return null;
        if (el.ValueKind != JsonValueKind.Array) return null;
        var vals = el.EnumerateArray().Select(x => x.ValueKind == JsonValueKind.Null ? (int?)null : x.GetInt32()).ToList();
        if (vals[0] == null) return null;

        var root = new TreeNode(vals[0].Value);
        var queue = new Queue<TreeNode>();
        queue.Enqueue(root);
        int i = 1;
        while (queue.Count > 0 && i < vals.Count)
        {
            var curr = queue.Dequeue();
            if (i < vals.Count && vals[i] != null)
            {
                curr.left = new TreeNode(vals[i].Value);
                queue.Enqueue(curr.left);
            }
            i++;
            if (i < vals.Count && vals[i] != null)
            {
                curr.right = new TreeNode(vals[i].Value);
                queue.Enqueue(curr.right);
            }
            i++;
        }
        return root;
    }

    static ListNode BuildLinkedList(JsonElement el)
    {
        if (el.ValueKind != JsonValueKind.Array) return null;
        var dummy = new ListNode();
        var curr = dummy;
        foreach (var item in el.EnumerateArray())
        {
            curr.next = new ListNode(item.GetInt32());
            curr = curr.next;
        }
        return dummy.next;
    }

    static Node BuildGraph(JsonElement el)
    {
        if (el.ValueKind != JsonValueKind.Array) return null;
        var adj = el.EnumerateArray().ToList();
        if (adj.Count == 0) return null;
        
        var nodes = new Node[adj.Count];
        for (int i = 0; i < adj.Count; i++) nodes[i] = new Node(i + 1);
        
        for (int i = 0; i < adj.Count; i++)
        {
            foreach (var neighborIdx in adj[i].EnumerateArray())
            {
                nodes[i].neighbors.Add(nodes[neighborIdx.GetInt32() - 1]);
            }
        }
        return nodes[0];
    }

    static object Serialize(object obj, string typeStr)
    {
        if (obj == null) return null;
        if (obj is TreeNode root) return SerializeTree(root);
        if (obj is ListNode head) return SerializeLinkedList(head);
        if (obj is Node node) return SerializeGraph(node);
        return obj;
    }

    static int?[] SerializeTree(TreeNode root)
    {
        if (root == null) return new int?[0];
        var res = new List<int?>();
        var queue = new Queue<TreeNode>();
        queue.Enqueue(root);
        while (queue.Count > 0)
        {
            var curr = queue.Dequeue();
            if (curr == null) res.Add(null);
            else
            {
                res.Add(curr.val);
                queue.Enqueue(curr.left);
                queue.Enqueue(curr.right);
            }
        }
        while (res.Count > 0 && res[res.Count - 1] == null) res.RemoveAt(res.Count - 1);
        return res.ToArray();
    }

    static int[] SerializeLinkedList(ListNode head)
    {
        var res = new List<int>();
        var curr = head;
        while (curr != null)
        {
            res.Add(curr.val);
            curr = curr.next;
        }
        return res.ToArray();
    }

    static List<List<int>> SerializeGraph(Node node)
    {
        if (node == null) return new List<List<int>>();
        var map = new Dictionary<int, Node>();
        var queue = new Queue<Node>();
        queue.Enqueue(node);
        map[node.val] = node;
        
        while (queue.Count > 0)
        {
            var curr = queue.Dequeue();
            foreach (var neighbor in curr.neighbors)
            {
                if (!map.ContainsKey(neighbor.val))
                {
                    map[neighbor.val] = neighbor;
                    queue.Enqueue(neighbor);
                }
            }
        }

        var res = new List<List<int>>();
        for (int i = 1; i <= map.Count; i++)
        {
            if (map.ContainsKey(i))
                res.Add(map[i].neighbors.Select(n => n.val).ToList());
            else
                res.Add(new List<int>());
        }
        return res;
    }

    // What a test prints, kept up to just past the judge's output limit (64 KB) so a print loop
    // cannot fill memory; the judge fails a test that goes over with Output Limit Exceeded (T5).
    class CapturedStdout : System.IO.TextWriter
    {
        const int Cap = 64 * 1024 + 1;
        readonly StringBuilder buf = new StringBuilder();
        public override Encoding Encoding => Encoding.UTF8;
        public override void Write(char value) { if (buf.Length < Cap) buf.Append(value); }
        public override void Write(string value)
        {
            if (value == null || buf.Length >= Cap) return;
            buf.Append(value.Length <= Cap - buf.Length ? value : value.Substring(0, Cap - buf.Length));
        }
        public string Value() => buf.ToString();
    }

    // Every test in one process (JUDGE_FIX_PLAN T5): one result line per test on stderr.
    public static void Main(string[] args)
    {
        if (args.Length == 0) {
            Console.Error.WriteLine("{\"fatal\": \"missing tests payload\"}");
            return;
        }
        JsonDocument doc;
        try {
            doc = JsonDocument.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(args[0])));
        } catch (Exception ex) {
            Console.Error.WriteLine(JsonSerializer.Serialize(new Dictionary<string, object> { {"fatal", "unreadable tests payload: " + ex.Message} }));
            return;
        }

        string funcName = "{{FUNCTION_NAME}}";
        string returnTypeStr = "{{RETURN_TYPE}}";
        var solverType = typeof(Solution);
        var method = solverType.GetMethod(funcName, BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.NonPublic);
        if (method == null) {
            Console.Error.WriteLine("{\"fatal\": \"Method " + funcName + " not found in Solution class\"}");
            return;
        }
        var paramInfos = method.GetParameters();
        var realOut = Console.Out;
        var tests = doc.RootElement;

        for (int t = 0; t < tests.GetArrayLength(); t++) {
            int testNo = t + 1;
            var captured = new CapturedStdout();
            Console.SetOut(captured);
            try {
                var inputsArr = tests[t].GetProperty("inputs");
                var convertedArgs = new object[paramInfos.Length];
                for (int i = 0; i < paramInfos.Length; i++) {
                    convertedArgs[i] = ConvertInput(inputsArr[i], GetTypeStr(i));
                }
                object instance = method.IsStatic ? null : Activator.CreateInstance(solverType);
                object result = method.Invoke(instance, convertedArgs);
                Console.SetOut(realOut);

                var outputMap = new Dictionary<string, object> { {"test", testNo} };
                if (returnTypeStr == "void" && convertedArgs.Length > 0) {
                    outputMap["output"] = Serialize(convertedArgs[0], GetTypeStr(0));
                } else {
                    outputMap["output"] = Serialize(result, returnTypeStr);
                }
                outputMap["stdout"] = captured.Value();
                Console.Error.WriteLine(JsonSerializer.Serialize(outputMap));
            } catch (Exception ex) {
                Console.SetOut(realOut);
                var inner = ex is TargetInvocationException && ex.InnerException != null ? ex.InnerException : ex;
                Console.Error.WriteLine(JsonSerializer.Serialize(new Dictionary<string, object> {
                    {"test", testNo},
                    {"error", "Runtime Error"},
                    {"message", inner.Message},
                    {"traceback", inner.StackTrace},
                    {"stdout", captured.Value()},
                }));
            } finally {
                Console.SetOut(realOut);
            }
        }
    }

    static string GetTypeStr(int index) {
        string paramsJson = @"{{PARAMS_JSON}}";
        using var doc = JsonDocument.Parse(paramsJson);
        return doc.RootElement[index].GetProperty("type").GetString();
    }
}
