// wrapper injected by judge (batched execution for central comparator mode)
const fs = require("fs");

class TreeNode {
  constructor(val, left, right) {
    this.val = (val === undefined ? 0 : val);
    this.left = (left === undefined ? null : left);
    this.right = (right === undefined ? null : right);
  }
}

class ListNode {
  constructor(val, next) {
    this.val = (val === undefined ? 0 : val);
    this.next = (next === undefined ? null : next);
  }
}

class Node {
  constructor(val, neighbors) {
    this.val = (val === undefined ? 0 : val);
    this.neighbors = (neighbors === undefined ? [] : neighbors);
  }
}

global.TreeNode = TreeNode;
global.ListNode = ListNode;
global.Node = Node;

function buildTree(data) {
  if (!data || data.length === 0 || data[0] === null) {
    return null;
  }

  const root = new TreeNode(data[0]);
  const queue = [root];
  let i = 1;

  while (queue.length > 0 && i < data.length) {
    const node = queue.shift();

    if (i < data.length) {
      if (data[i] !== null) {
        node.left = new TreeNode(data[i]);
        queue.push(node.left);
      }
      i++;
    }

    if (i < data.length) {
      if (data[i] !== null) {
        node.right = new TreeNode(data[i]);
        queue.push(node.right);
      }
      i++;
    }
  }

  return root;
}

function serializeTree(root) {
  if (!root) {
    return [];
  }

  const result = [];
  const queue = [root];

  while (queue.length > 0) {
    const node = queue.shift();

    if (node) {
      result.push(node.val);
      queue.push(node.left);
      queue.push(node.right);
    } else {
      result.push(null);
    }
  }

  // Trim trailing nulls
  while (result.length > 0 && result[result.length - 1] === null) {
    result.pop();
  }

  return result;
}

function buildLinkedList(data) {
  if (!data || data.length === 0) {
    return null;
  }

  const dummy = new ListNode();
  let curr = dummy;
  for (const v of data) {
    curr.next = new ListNode(v);
    curr = curr.next;
  }

  return dummy.next;
}

function serializeLinkedList(head) {
  const result = [];
  let curr = head;
  while (curr) {
    result.push(curr.val);
    curr = curr.next;
  }
  return result;
}

function buildGraph(adj) {
  if (!adj || adj.length === 0) return null;
  const nodes = adj.map((_, i) => new Node(i + 1));
  adj.forEach((neighbors, i) => {
    neighbors.forEach(neighborIdx => {
      nodes[i].neighbors.push(nodes[neighborIdx - 1]);
    });
  });
  return nodes[0];
}

function serializeGraph(node) {
  if (!node) return [];
  const map = new Map();
  const queue = [node];
  map.set(node.val, node);
  while (queue.length > 0) {
    const curr = queue.shift();
    for (const neighbor of curr.neighbors) {
      if (!map.has(neighbor.val)) {
        map.set(neighbor.val, neighbor);
        queue.push(neighbor);
      }
    }
  }
  const res = [];
  for (let i = 1; i <= map.size; i++) {
    const n = map.get(i);
    res.push(n ? n.neighbors.map(nb => nb.val) : []);
  }
  return res;
}

function convertInput(val, typeStr) {
  if (typeStr && typeStr.startsWith("tree")) {
    return buildTree(val);
  }
  if (typeStr && typeStr.startsWith("linkedlist")) {
    return buildLinkedList(val);
  }
  if (typeStr && typeStr.startsWith("graph")) {
    return buildGraph(val);
  }
  return val;
}

function convertOutput(val, typeStr) {
  if (val instanceof TreeNode || (typeStr && typeStr.startsWith("tree"))) {
    return serializeTree(val);
  }
  if (val instanceof ListNode || (typeStr && typeStr.startsWith("linkedlist"))) {
    return serializeLinkedList(val);
  }
  if (val instanceof Node || (typeStr && typeStr.startsWith("graph"))) {
    return serializeGraph(val);
  }
  return val;
}

// USER_CODE_MARKER

function emit(payload) {
  process.stderr.write(JSON.stringify(payload) + "\n");
}

// What a test prints (console.log goes through process.stdout.write), kept up to just past the
// judge's output limit (64 KB) so a print loop cannot fill memory; the judge fails a test that
// goes over with Output Limit Exceeded.
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const STDOUT_CAP = 64 * 1024 + 1;
function captureStdout() {
  const parts = [];
  let size = 0;
  process.stdout.write = (chunk, encoding, cb) => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (size < STDOUT_CAP) parts.push(s.slice(0, STDOUT_CAP - size));
    size += s.length;
    const done = typeof encoding === "function" ? encoding : cb;
    if (typeof done === "function") done();
    return true;
  };
  return () => {
    process.stdout.write = realStdoutWrite;
    return parts.join("");
  };
}

async function runAll() {
  try {
    let tests;
    if (process.argv.length >= 3) {
      const decoded = Buffer.from(process.argv[2], "base64").toString("utf8");
      tests = JSON.parse(decoded);
    } else {
      tests = JSON.parse(fs.readFileSync(0, "utf8"));
    }
    
    const params = {{PARAMS_JSON}} || [];
    const returnType = "{{RETURN_TYPE}}";

    for (let i = 0; i < tests.length; i++) {
      const test = tests[i];
      const endCapture = captureStdout();
      try {
        const testInput = test.inputs;
        const rawInputs = Array.isArray(testInput) ? testInput : [testInput];
        const convertedInputs = rawInputs.map((val, j) => {
          const typeStr = params[j] ? params[j].type : "";
          return convertInput(val, typeStr);
        });

        let out = await {{FUNCTION_NAME}}(...convertedInputs);
        let convertedOut;
        if (returnType === "void" && convertedInputs.length > 0) {
          convertedOut = convertOutput(convertedInputs[0], params[0] ? params[0].type : "");
        } else {
          convertedOut = convertOutput(out, returnType);
        }
        emit({ test: i + 1, output: convertedOut, stdout: endCapture() });
      } catch (exc) {
        emit({
          test: i + 1,
          error: String(exc.message || exc),
          traceback: String(exc.stack || ""),
          stdout: endCapture(),
        });
      }
    }
  } catch (fatal) {
    emit({
      fatal: String(fatal.message || fatal),
      traceback: String(fatal.stack || ""),
    });
    process.exit(1);
  }
}

runAll();
