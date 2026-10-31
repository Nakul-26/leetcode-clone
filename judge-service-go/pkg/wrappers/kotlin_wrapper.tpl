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

fun main(args: Array<String>) {
    try {
        if (args.isEmpty()) {
            System.err.println("{\"error\": \"missing input payload\"}")
            return
        }

        val decoded = String(Base64.getDecoder().decode(args[0]), Charsets.UTF_8)
        val payload = GSON.fromJson(decoded, JsonObject::class.java)
        val inputs: JsonArray? = if (payload != null && payload.has("inputs")) payload.getAsJsonArray("inputs") else null

        val funcName = judgeFunctionName()
        val argCount = inputs?.size() ?: 0

        val solutionClass = Class.forName("Solution")
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

        val instance: Any? = if (Modifier.isStatic(method.modifiers)) {
            null
        } else {
            solutionClass.getDeclaredConstructor().newInstance()
        }

        val output: Any?
        try {
            output = method.invoke(instance, *argsValues)
        } catch (e: InvocationTargetException) {
            System.err.println(errorPayload(e.cause ?: e))
            return
        }

        val result = JsonObject()
        if (method.returnType == java.lang.Void.TYPE && argsValues.isNotEmpty()) {
            result.add("output", GSON.toJsonTree(argsValues[0]))
        } else {
            result.add("output", GSON.toJsonTree(output))
        }
        System.err.println(GSON.toJson(result))
    } catch (e: Throwable) {
        System.err.println(errorPayload(e))
    }
}

private fun errorPayload(err: Throwable): String {
    val result = JsonObject()
    result.addProperty("error", err.javaClass.simpleName)
    result.addProperty("traceback", err.stackTraceToString())
    return GSON.toJson(result)
}

// The function to call, from the file judge-function the judge writes next to the source. Not
// pasted into this file: the harness is compiled once, into the image (JUDGE_FIX_PLAN T9), so
// a submission compiles only its own Solution.kt.
private fun judgeFunctionName(): String {
    val f = java.io.File("judge-function")
    if (!f.exists()) throw IllegalStateException("judge-function file missing")
    return f.readText().trim()
}
