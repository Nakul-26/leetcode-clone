# wrapper injected by judge (batched execution for central comparator mode)
import base64, json, sys, traceback, collections

# --- Security: Restrict dangerous modules and built-ins ---
for module_name in [
    'os', 'subprocess', 'shutil', 'socket', 'urllib', 'requests',
    'pathlib', 'glob', 'tempfile', 'mmap', 'fcntl', 'resource', 'signal',
    'ctypes', 'gc', 'inspect', 'site', 'distutils', 'setuptools', 'pip'
]:
    if module_name in sys.modules:
        del sys.modules[module_name]
    if module_name in globals():
        del globals()[module_name]

restricted_builtins = ['eval', 'exec', 'compile', 'open', 'file', 'input']
for builtin_name in restricted_builtins:
    if hasattr(__builtins__, builtin_name):
        delattr(__builtins__, builtin_name)

class TreeNode:
    def __init__(self, val=0, left=None, right=None):
        self.val = val
        self.left = left
        self.right = right
    
    def __repr__(self):
        return f"TreeNode({self.val})"

class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next
    
    def __repr__(self):
        return f"ListNode({self.val})"

class Node:
    def __init__(self, val=0, neighbors=None):
        self.val = val
        self.neighbors = neighbors if neighbors is not None else []
    
    def __repr__(self):
        return f"Node({self.val})"

def build_tree(data):
    if not data or data[0] is None:
        return None
    root = TreeNode(data[0])
    queue = collections.deque([root])
    i = 1
    while queue and i < len(data):
        node = queue.popleft()
        if i < len(data):
            if data[i] is not None:
                node.left = TreeNode(data[i])
                queue.append(node.left)
            i += 1
        if i < len(data):
            if data[i] is not None:
                node.right = TreeNode(data[i])
                queue.append(node.right)
            i += 1
    return root

def serialize_tree(root):
    if not root:
        return []
    result = []
    queue = collections.deque([root])
    while queue:
        node = queue.popleft()
        if node:
            result.append(node.val)
            queue.append(node.left)
            queue.append(node.right)
        else:
            result.append(None)
    while result and result[-1] is None:
        result.pop()
    return result

def build_linked_list(data):
    if not data:
        return None
    dummy = ListNode()
    curr = dummy
    for v in data:
        curr.next = ListNode(v)
        curr = curr.next
    return dummy.next

def serialize_linked_list(head):
    result = []
    curr = head
    while curr:
        result.append(curr.val)
        curr = curr.next
    return result

def build_graph(adj):
    if not adj:
        return None
    nodes = [Node(i + 1) for i in range(len(adj))]
    for i, neighbors in enumerate(adj):
        for neighbor_idx in neighbors:
            nodes[i].neighbors.append(nodes[neighbor_idx - 1])
    return nodes[0]

def serialize_graph(node):
    if not node:
        return []
    node_map = {}
    queue = collections.deque([node])
    node_map[node.val] = node
    while queue:
        curr = queue.popleft()
        for neighbor in curr.neighbors:
            if neighbor.val not in node_map:
                node_map[neighbor.val] = neighbor
                queue.append(neighbor)
    
    res = []
    for i in range(1, len(node_map) + 1):
        n = node_map.get(i)
        res.append([nb.val for nb in n.neighbors] if n else [])
    return res

def convert_input(val, type_str):
    if type_str.startswith("tree"):
        return build_tree(val)
    if type_str.startswith("linkedlist"):
        return build_linked_list(val)
    if type_str.startswith("graph"):
        return build_graph(val)
    return val

def convert_output(val, type_str):
    if isinstance(val, TreeNode) or type_str.startswith("tree"):
        return serialize_tree(val)
    if isinstance(val, ListNode) or type_str.startswith("linkedlist"):
        return serialize_linked_list(val)
    if isinstance(val, Node) or type_str.startswith("graph"):
        return serialize_graph(val)
    return val

# USER_CODE_MARKER

def emit(payload):
    print(json.dumps(payload), file=sys.stderr)
    sys.stderr.flush()

class CapturedStdout:
    # What a test prints, kept up to just past the judge's output limit (64 KB) so a print
    # loop cannot fill memory; the judge fails a test that goes over with Output Limit Exceeded.
    cap = 64 * 1024 + 1

    def __init__(self):
        self.parts = []
        self.size = 0

    def write(self, s):
        s = str(s)
        if self.size < self.cap:
            self.parts.append(s[: self.cap - self.size])
        self.size += len(s)
        return len(s)

    def flush(self):
        pass

    def value(self):
        return "".join(self.parts)

def run_all():
    if len(sys.argv) < 2:
        emit({"fatal": "missing tests payload"})
        return 2

    decoded = base64.b64decode(sys.argv[1]).decode("utf-8")
    tests = json.loads(decoded)
    
    params = json.loads('''{{PARAMS_JSON}}''') or []
    return_type = '''{{RETURN_TYPE}}'''

    real_stdout = sys.stdout
    for i, test in enumerate(tests):
        captured = CapturedStdout()
        sys.stdout = captured
        try:
            raw_inputs = test.get("inputs", [])
            converted_inputs = []
            for j, val in enumerate(raw_inputs):
                type_str = params[j]["type"] if params and j < len(params) else ""
                converted_inputs.append(convert_input(val, type_str))
            
            if isinstance(converted_inputs, list):
                out = {{FUNCTION_NAME}}(*converted_inputs)
            else:
                out = {{FUNCTION_NAME}}(converted_inputs)

            if return_type == "void" and len(converted_inputs) > 0:
                converted_out = convert_output(converted_inputs[0], params[0]["type"] if params else "")
            else:
                converted_out = convert_output(out, return_type)

            sys.stdout = real_stdout
            emit({ "test": i + 1, "output": converted_out, "stdout": captured.value() })
        except Exception as exc:
            sys.stdout = real_stdout
            emit({
                "test": i + 1,
                "error": str(exc),
                "traceback": traceback.format_exc(),
                "stdout": captured.value(),
            })
        finally:
            sys.stdout = real_stdout

    return 0

if __name__ == "__main__":
    try:
        sys.exit(run_all())
    except Exception as exc:
        emit({
            "fatal": str(exc),
            "traceback": traceback.format_exc(),
        })
        sys.exit(1)
