# wrapper injected by judge (single test execution for central comparator mode)
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

# Not exec, compile or eval: Python's import system calls exec and compile to load any module
# that has no compiled .pyc (the image has none), and collections.namedtuple calls eval, so
# removing them broke `from typing import List`, heapq, bisect, decimal and most of the
# standard library. The container is the sandbox.
restricted_builtins = ['open', 'file', 'input']
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
    # preserve original node list for deep-copy checks
    global ORIGINAL_NODES
    ORIGINAL_NODES = nodes
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


def node_list_by_val(root):
    if not root:
        return []
    node_map = {}
    queue = collections.deque([root])
    node_map[root.val] = root
    while queue:
        curr = queue.popleft()
        for neighbor in curr.neighbors:
            if neighbor.val not in node_map:
                node_map[neighbor.val] = neighbor
                queue.append(neighbor)
    out = []
    for i in range(1, len(node_map) + 1):
        out.append(node_map.get(i))
    return out


def verify_deep_copy(orig_root, ret_root):
    orig_nodes = node_list_by_val(orig_root)
    ret_nodes = node_list_by_val(ret_root)
    if len(orig_nodes) != len(ret_nodes):
        raise ValueError(f"Deep copy failed: structure size mismatch {len(orig_nodes)} vs {len(ret_nodes)}")
    for idx, (o, r) in enumerate(zip(orig_nodes, ret_nodes), start=1):
        if o is r:
            raise ValueError(f"Deep copy failed: node {idx} is the same object as original")
        if o.val != r.val:
            raise ValueError(f"Deep copy failed: node {idx} value mismatch {o.val} vs {r.val}")
    return True

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

# REQUIRE_DEEP_COPY: {{REQUIRE_DEEP_COPY}}

def run_one():
    try:
        if len(sys.argv) < 2:
            print(json.dumps({"error": "missing input payload"}))
            sys.stdout.flush()
            return

        decoded = base64.b64decode(sys.argv[1]).decode("utf-8")
        payload = json.loads(decoded)
        
        params = json.loads('''{{PARAMS_JSON}}''') or []
        return_type = '''{{RETURN_TYPE}}'''

        raw_inputs = payload.get("inputs", [])
        converted_inputs = []
        for j, val in enumerate(raw_inputs):
            type_str = params[j]["type"] if params and j < len(params) else ""
            converted_inputs.append(convert_input(val, type_str))

        target_func = globals().get("{{FUNCTION_NAME}}")
        if not target_func and "Solution" in globals():
            sol_instance = globals()["Solution"]()
            target_func = getattr(sol_instance, "{{FUNCTION_NAME}}", None)
        
        if not target_func:
            raise NameError("Function '{{FUNCTION_NAME}}' not found")

        if isinstance(converted_inputs, list):
            out = target_func(*converted_inputs)
        else:
            out = target_func(converted_inputs)

        # If deep-copy is required for graph types, verify before serialization
        try:
            require_deep = {{REQUIRE_DEEP_COPY}}
        except Exception:
            require_deep = False

        if return_type.startswith("graph") and require_deep:
            # original nodes preserved in ORIGINAL_NODES by build_graph
            try:
                orig_root = ORIGINAL_NODES[0] if 'ORIGINAL_NODES' in globals() and ORIGINAL_NODES else None
            except Exception:
                orig_root = None
            try:
                ret_root = out
                if orig_root is not None and ret_root is not None:
                    verify_deep_copy(orig_root, ret_root)
            except Exception as e:
                # Raise to surface a meaningful failure to the user
                raise

        if return_type == "void" and len(converted_inputs) > 0:
            # For void functions, we assume the first argument is modified in-place
            converted_out = convert_output(converted_inputs[0], params[0]["type"] if params else "")
        else:
            converted_out = convert_output(out, return_type)

        print(json.dumps({"output": converted_out}), file=sys.stderr)
        sys.stderr.flush()
    except Exception as e:
        tb = traceback.format_exc()
        print(json.dumps({"error": str(e), "traceback": tb}), file=sys.stderr)
        sys.stderr.flush()

if __name__ == "__main__":
    run_one()
