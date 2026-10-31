<?php
// wrapper injected by judge (single test execution for central comparator mode)

class TreeNode {
    public $val;
    public $left;
    public $right;
    public function __construct($val = 0, $left = null, $right = null) {
        $this->val = $val;
        $this->left = $left;
        $this->right = $right;
    }
}

class ListNode {
    public $val;
    public $next;
    public function __construct($val = 0, $next = null) {
        $this->val = $val;
        $this->next = $next;
    }
}

class GraphNode {
    public $val;
    public $neighbors;
    public function __construct($val = 0, $neighbors = null) {
        $this->val = $val;
        $this->neighbors = $neighbors === null ? [] : $neighbors;
    }
}

$GLOBALS['__ORIGINAL_GRAPH_NODES'] = null;

function build_tree($data) {
    if (empty($data) || $data[0] === null) return null;
    $root = new TreeNode($data[0]);
    $queue = [$root];
    $i = 1;
    $n = count($data);
    while (count($queue) > 0 && $i < $n) {
        $node = array_shift($queue);
        if ($i < $n) {
            if ($data[$i] !== null) {
                $node->left = new TreeNode($data[$i]);
                $queue[] = $node->left;
            }
            $i++;
        }
        if ($i < $n) {
            if ($data[$i] !== null) {
                $node->right = new TreeNode($data[$i]);
                $queue[] = $node->right;
            }
            $i++;
        }
    }
    return $root;
}

function serialize_tree($root) {
    if ($root === null) return [];
    $result = [];
    $queue = [$root];
    while (count($queue) > 0) {
        $node = array_shift($queue);
        if ($node !== null) {
            $result[] = $node->val;
            $queue[] = $node->left;
            $queue[] = $node->right;
        } else {
            $result[] = null;
        }
    }
    while (count($result) > 0 && end($result) === null) {
        array_pop($result);
    }
    return $result;
}

function build_linked_list($data) {
    if (empty($data)) return null;
    $dummy = new ListNode();
    $curr = $dummy;
    foreach ($data as $v) {
        $curr->next = new ListNode($v);
        $curr = $curr->next;
    }
    return $dummy->next;
}

function serialize_linked_list($head) {
    $result = [];
    $curr = $head;
    while ($curr !== null) {
        $result[] = $curr->val;
        $curr = $curr->next;
    }
    return $result;
}

function build_graph($adj) {
    if (empty($adj)) return null;
    $n = count($adj);
    $nodes = [];
    for ($i = 0; $i < $n; $i++) {
        $nodes[$i] = new GraphNode($i + 1);
    }
    for ($i = 0; $i < $n; $i++) {
        foreach ($adj[$i] as $nb) {
            $nodes[$i]->neighbors[] = $nodes[$nb - 1];
        }
    }
    $GLOBALS['__ORIGINAL_GRAPH_NODES'] = $nodes;
    return $nodes[0];
}

function serialize_graph($node) {
    if ($node === null) return [];
    $map = [];
    $queue = [$node];
    $map[$node->val] = $node;
    while (count($queue) > 0) {
        $curr = array_shift($queue);
        foreach ($curr->neighbors as $nb) {
            if (!isset($map[$nb->val])) {
                $map[$nb->val] = $nb;
                $queue[] = $nb;
            }
        }
    }
    $res = [];
    $count = count($map);
    for ($i = 1; $i <= $count; $i++) {
        if (isset($map[$i])) {
            $res[] = array_map(function ($nb) { return $nb->val; }, $map[$i]->neighbors);
        } else {
            $res[] = [];
        }
    }
    return $res;
}

function node_list_by_val($root) {
    if ($root === null) return [];
    $map = [];
    $queue = [$root];
    $map[$root->val] = $root;
    while (count($queue) > 0) {
        $curr = array_shift($queue);
        foreach ($curr->neighbors as $nb) {
            if (!isset($map[$nb->val])) {
                $map[$nb->val] = $nb;
                $queue[] = $nb;
            }
        }
    }
    $out = [];
    $count = count($map);
    for ($i = 1; $i <= $count; $i++) {
        $out[] = $map[$i];
    }
    return $out;
}

function verify_deep_copy($orig_root, $ret_root) {
    $orig_nodes = node_list_by_val($orig_root);
    $ret_nodes = node_list_by_val($ret_root);
    if (count($orig_nodes) !== count($ret_nodes)) {
        throw new Exception('Deep copy failed: structure size mismatch ' . count($orig_nodes) . ' vs ' . count($ret_nodes));
    }
    foreach ($orig_nodes as $idx => $o) {
        $r = $ret_nodes[$idx];
        if ($o === $r) {
            throw new Exception('Deep copy failed: node ' . ($idx + 1) . ' is the same object as original');
        }
        if ($o->val !== $r->val) {
            throw new Exception('Deep copy failed: node ' . ($idx + 1) . ' value mismatch ' . $o->val . ' vs ' . $r->val);
        }
    }
}

function convert_input($val, $type_str) {
    if (strpos($type_str, 'tree') === 0) return build_tree($val);
    if (strpos($type_str, 'linkedlist') === 0) return build_linked_list($val);
    if (strpos($type_str, 'graph') === 0) return build_graph($val);
    return $val;
}

function convert_output($val, $type_str) {
    if ($val instanceof TreeNode || strpos($type_str, 'tree') === 0) return serialize_tree($val);
    if ($val instanceof ListNode || strpos($type_str, 'linkedlist') === 0) return serialize_linked_list($val);
    if ($val instanceof GraphNode || strpos($type_str, 'graph') === 0) return serialize_graph($val);
    return $val;
}

// USER_CODE_MARKER

// What a test prints, kept up to just past the judge's output limit (64 KB) so a print loop
// cannot fill memory; the judge fails a test that goes over with Output Limit Exceeded (T5).
$GLOBALS['__JUDGE_STDOUT'] = '';
function judge_capture_chunk($chunk) {
    $cap = 64 * 1024 + 1;
    $room = $cap - strlen($GLOBALS['__JUDGE_STDOUT']);
    if ($room > 0) {
        $GLOBALS['__JUDGE_STDOUT'] .= substr($chunk, 0, $room);
    }
    return '';
}

function judge_emit($payload) {
    fwrite(STDERR, json_encode($payload, JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR) . "\n");
}

function judge_call($converted_inputs) {
    if (class_exists('Solution')) {
        $instance = new Solution();
        return call_user_func_array([$instance, "{{FUNCTION_NAME}}"], $converted_inputs);
    }
    if (function_exists("{{FUNCTION_NAME}}")) {
        return call_user_func_array("{{FUNCTION_NAME}}", $converted_inputs);
    }
    throw new Exception("Function '{{FUNCTION_NAME}}' not found");
}

// Every test in one process (JUDGE_FIX_PLAN T5): one result line per test on stderr.
function judge_run_all() {
    global $argv;
    if (count($argv) < 2) {
        judge_emit(['fatal' => 'missing tests payload']);
        return;
    }
    $tests = json_decode(base64_decode($argv[1]), true);
    if (!is_array($tests)) {
        judge_emit(['fatal' => 'unreadable tests payload']);
        return;
    }
    $params = json_decode('{{PARAMS_JSON}}', true);
    if ($params === null) {
        $params = [];
    }
    $return_type = "{{RETURN_TYPE}}";
    $require_deep = "{{REQUIRE_DEEP_COPY}}" === "true";

    foreach ($tests as $i => $test) {
        $GLOBALS['__JUDGE_STDOUT'] = '';
        ob_start('judge_capture_chunk', 4096);
        try {
            $raw_inputs = isset($test['inputs']) ? $test['inputs'] : [];
            $converted_inputs = [];
            foreach ($raw_inputs as $j => $val) {
                $type_str = isset($params[$j]['type']) ? $params[$j]['type'] : '';
                $converted_inputs[] = convert_input($val, $type_str);
            }
            $out = judge_call($converted_inputs);
            if (strpos($return_type, 'graph') === 0 && $require_deep) {
                $orig_nodes = $GLOBALS['__ORIGINAL_GRAPH_NODES'];
                $orig_root = ($orig_nodes && count($orig_nodes) > 0) ? $orig_nodes[0] : null;
                if ($orig_root !== null && $out !== null) {
                    verify_deep_copy($orig_root, $out);
                }
            }
            if ($return_type === 'void' && count($converted_inputs) > 0) {
                $converted_out = convert_output($converted_inputs[0], isset($params[0]['type']) ? $params[0]['type'] : '');
            } else {
                $converted_out = convert_output($out, $return_type);
            }
            ob_end_clean();
            judge_emit(['test' => $i + 1, 'output' => $converted_out, 'stdout' => $GLOBALS['__JUDGE_STDOUT']]);
        } catch (Throwable $e) {
            while (ob_get_level() > 0) {
                ob_end_clean();
            }
            judge_emit(['test' => $i + 1, 'error' => $e->getMessage(), 'traceback' => $e->getTraceAsString(), 'stdout' => $GLOBALS['__JUDGE_STDOUT']]);
        }
    }
}

try {
    judge_run_all();
} catch (Throwable $e) {
    judge_emit(['fatal' => $e->getMessage()]);
}
