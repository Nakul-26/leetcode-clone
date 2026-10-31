import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonArray
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.TypeAdapter
import com.google.gson.stream.JsonReader
import com.google.gson.stream.JsonToken
import com.google.gson.stream.JsonWriter
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import java.util.Base64

class TreeNode(var `val`: Int = 0) {
    var left: TreeNode? = null
    var right: TreeNode? = null
}

class ListNode(var `val`: Int = 0) {
    var next: ListNode? = null
}

class Node(var `val`: Int = 0) {
    var neighbors: MutableList<Node> = mutableListOf()
}

private object TreeNodeAdapter : TypeAdapter<TreeNode>() {
    override fun write(out: JsonWriter, root: TreeNode?) {
        if (root == null) {
            out.nullValue()
            return
        }
        val result = mutableListOf<Int?>()
        val queue = ArrayDeque<TreeNode?>()
        queue.add(root)
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            if (node != null) {
                result.add(node.`val`)
                queue.add(node.left)
                queue.add(node.right)
            } else {
                result.add(null)
            }
        }
        while (result.isNotEmpty() && result.last() == null) {
            result.removeAt(result.size - 1)
        }
        out.beginArray()
        for (v in result) {
            if (v == null) out.nullValue() else out.value(v)
        }
        out.endArray()
    }

    override fun read(reader: JsonReader): TreeNode? {
        if (reader.peek() == JsonToken.NULL) {
            reader.nextNull()
            return null
        }
        val data = mutableListOf<Int?>()
        reader.beginArray()
        while (reader.hasNext()) {
            if (reader.peek() == JsonToken.NULL) {
                reader.nextNull()
                data.add(null)
            } else {
                data.add(reader.nextInt())
            }
        }
        reader.endArray()

        if (data.isEmpty() || data[0] == null) return null

        val root = TreeNode(data[0]!!)
        val queue = ArrayDeque<TreeNode>()
        queue.add(root)
        var i = 1
        while (queue.isNotEmpty() && i < data.size) {
            val node = queue.removeFirst()
            if (i < data.size) {
                val leftVal = data[i]
                i++
                if (leftVal != null) {
                    node.left = TreeNode(leftVal)
                    queue.add(node.left!!)
                }
            }
            if (i < data.size) {
                val rightVal = data[i]
                i++
                if (rightVal != null) {
                    node.right = TreeNode(rightVal)
                    queue.add(node.right!!)
                }
            }
        }
        return root
    }
}

private object ListNodeAdapter : TypeAdapter<ListNode>() {
    override fun write(out: JsonWriter, head: ListNode?) {
        if (head == null) {
            out.nullValue()
            return
        }
        out.beginArray()
        var curr: ListNode? = head
        while (curr != null) {
            out.value(curr.`val`)
            curr = curr.next
        }
        out.endArray()
    }

    override fun read(reader: JsonReader): ListNode? {
        if (reader.peek() == JsonToken.NULL) {
            reader.nextNull()
            return null
        }
        val data = mutableListOf<Int>()
        reader.beginArray()
        while (reader.hasNext()) {
            if (reader.peek() == JsonToken.NULL) {
                reader.nextNull()
            } else {
                data.add(reader.nextInt())
            }
        }
        reader.endArray()

        if (data.isEmpty()) return null
        val dummy = ListNode()
        var curr = dummy
        for (v in data) {
            curr.next = ListNode(v)
            curr = curr.next!!
        }
        return dummy.next
    }
}

private object NodeAdapter : TypeAdapter<Node>() {
    override fun write(out: JsonWriter, node: Node?) {
        if (node == null) {
            out.nullValue()
            return
        }
        val map = LinkedHashMap<Int, Node>()
        val queue = ArrayDeque<Node>()
        queue.add(node)
        map[node.`val`] = node
        while (queue.isNotEmpty()) {
            val curr = queue.removeFirst()
            for (neighbor in curr.neighbors) {
                if (!map.containsKey(neighbor.`val`)) {
                    map[neighbor.`val`] = neighbor
                    queue.add(neighbor)
                }
            }
        }
        out.beginArray()
        for (i in 1..map.size) {
            val n = map[i]
            out.beginArray()
            if (n != null) {
                for (neighbor in n.neighbors) {
                    out.value(neighbor.`val`)
                }
            }
            out.endArray()
        }
        out.endArray()
    }

    override fun read(reader: JsonReader): Node? {
        if (reader.peek() == JsonToken.NULL) {
            reader.nextNull()
            return null
        }
        val adj = mutableListOf<List<Int>>()
        reader.beginArray()
        while (reader.hasNext()) {
            val neighbors = mutableListOf<Int>()
            reader.beginArray()
            while (reader.hasNext()) {
                neighbors.add(reader.nextInt())
            }
            reader.endArray()
            adj.add(neighbors)
        }
        reader.endArray()

        if (adj.isEmpty()) return null
        val nodes = Array(adj.size) { Node(it + 1) }
        for (i in adj.indices) {
            for (neighborIdx in adj[i]) {
                nodes[i].neighbors.add(nodes[neighborIdx - 1])
            }
        }
        return nodes[0]
    }
}

private val GSON: Gson = GsonBuilder()
    .registerTypeAdapter(TreeNode::class.java, TreeNodeAdapter)
    .registerTypeAdapter(ListNode::class.java, ListNodeAdapter)
    .registerTypeAdapter(Node::class.java, NodeAdapter)
    .create()

// What a test prints, kept up to just past the judge's output limit (64 KB) so a print loop
// cannot fill memory; the judge fails a test that goes over with Output Limit Exceeded (T5).
class CapturedStdout : java.io.OutputStream() {
    private val cap = 64 * 1024 + 1
    private val buf = java.io.ByteArrayOutputStream()
    override fun write(b: Int) { if (buf.size() < cap) buf.write(b) }
    override fun write(b: ByteArray, off: Int, len: Int) {
        val room = cap - buf.size()
        if (room > 0) buf.write(b, off, minOf(len, room))
    }
    fun value(): String = String(buf.toByteArray(), Charsets.UTF_8)
}

// Every test in one process (JUDGE_FIX_PLAN T5): one result line per test on stderr.
fun main(args: Array<String>) {
    try {
        if (args.isEmpty()) {
            System.err.println("{\"fatal\": \"missing tests payload\"}")
            return
        }
        val decoded = String(Base64.getDecoder().decode(args[0]), Charsets.UTF_8)
        val tests = GSON.fromJson(decoded, JsonArray::class.java)
            ?: throw IllegalArgumentException("missing batched test payload")
        val funcName = "{{FUNCTION_NAME}}"
        val solutionClass = Class.forName("Solution")
        val realOut = System.out

        for (t in 0 until tests.size()) {
            val testNo = t + 1
            val payload = tests.get(t).asJsonObject
            val inputs: JsonArray? = if (payload.has("inputs")) payload.getAsJsonArray("inputs") else null
            val captured = CapturedStdout()
            System.setOut(java.io.PrintStream(captured, true, "UTF-8"))
            try {
                val argCount = inputs?.size() ?: 0
                val method: Method = solutionClass.declaredMethods.firstOrNull {
                    it.name == funcName && it.parameterCount == argCount
                } ?: throw NoSuchMethodException("method $funcName with $argCount arguments not found")
                method.isAccessible = true

                val paramTypes = method.genericParameterTypes
                val argsValues = arrayOfNulls<Any>(paramTypes.size)
                for (i in paramTypes.indices) {
                    val el = if (inputs != null && i < inputs.size()) inputs.get(i) else JsonNull.INSTANCE
                    argsValues[i] = GSON.fromJson(el, paramTypes[i])
                }
                val instance: Any? = if (Modifier.isStatic(method.modifiers)) null
                    else solutionClass.getDeclaredConstructor().newInstance()

                val output = method.invoke(instance, *argsValues)
                System.setOut(realOut)
                val result = JsonObject()
                result.addProperty("test", testNo)
                if (method.returnType == java.lang.Void.TYPE && argsValues.isNotEmpty()) {
                    result.add("output", GSON.toJsonTree(argsValues[0]))
                } else {
                    result.add("output", GSON.toJsonTree(output))
                }
                result.addProperty("stdout", captured.value())
                System.err.println(GSON.toJson(result))
            } catch (e: Throwable) {
                System.setOut(realOut)
                val cause = if (e is InvocationTargetException) (e.cause ?: e) else e
                System.err.println(errorPayload(testNo, cause, captured.value()))
            } finally {
                System.setOut(realOut)
            }
        }
    } catch (e: Throwable) {
        val fatal = JsonObject()
        fatal.addProperty("fatal", e.stackTraceToString())
        System.err.println(GSON.toJson(fatal))
    }
}

private fun errorPayload(test: Int, err: Throwable, stdout: String): String {
    val result = JsonObject()
    result.addProperty("test", test)
    result.addProperty("error", err.javaClass.simpleName)
    result.addProperty("traceback", err.stackTraceToString())
    result.addProperty("stdout", stdout)
    return GSON.toJson(result)
}
