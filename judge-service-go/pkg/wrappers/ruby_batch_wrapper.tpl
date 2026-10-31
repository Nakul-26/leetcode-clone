# wrapper injected by judge (single test execution for central comparator mode)
require 'base64'
require 'json'

class TreeNode
  attr_accessor :val, :left, :right
  def initialize(val = 0, left = nil, right = nil)
    @val = val
    @left = left
    @right = right
  end
end

class ListNode
  attr_accessor :val, :next
  def initialize(val = 0, nxt = nil)
    @val = val
    @next = nxt
  end
end

class GraphNode
  attr_accessor :val, :neighbors
  def initialize(val = 0, neighbors = nil)
    @val = val
    @neighbors = neighbors || []
  end
end

$ORIGINAL_GRAPH_NODES = nil

def build_tree(data)
  return nil if data.nil? || data.empty? || data[0].nil?
  root = TreeNode.new(data[0])
  queue = [root]
  i = 1
  while !queue.empty? && i < data.length
    node = queue.shift
    if i < data.length
      unless data[i].nil?
        node.left = TreeNode.new(data[i])
        queue.push(node.left)
      end
      i += 1
    end
    if i < data.length
      unless data[i].nil?
        node.right = TreeNode.new(data[i])
        queue.push(node.right)
      end
      i += 1
    end
  end
  root
end

def serialize_tree(root)
  return [] if root.nil?
  result = []
  queue = [root]
  until queue.empty?
    node = queue.shift
    if node
      result << node.val
      queue << node.left
      queue << node.right
    else
      result << nil
    end
  end
  result.pop while !result.empty? && result.last.nil?
  result
end

def build_linked_list(data)
  return nil if data.nil? || data.empty?
  dummy = ListNode.new
  curr = dummy
  data.each do |v|
    curr.next = ListNode.new(v)
    curr = curr.next
  end
  dummy.next
end

def serialize_linked_list(head)
  result = []
  curr = head
  while curr
    result << curr.val
    curr = curr.next
  end
  result
end

def build_graph(adj)
  return nil if adj.nil? || adj.empty?
  nodes = (0...adj.length).map { |i| GraphNode.new(i + 1) }
  adj.each_with_index do |neighbors, i|
    neighbors.each do |nb|
      nodes[i].neighbors << nodes[nb - 1]
    end
  end
  $ORIGINAL_GRAPH_NODES = nodes
  nodes[0]
end

def serialize_graph(node)
  return [] if node.nil?
  node_map = {}
  queue = [node]
  node_map[node.val] = node
  until queue.empty?
    curr = queue.shift
    curr.neighbors.each do |nb|
      unless node_map.key?(nb.val)
        node_map[nb.val] = nb
        queue << nb
      end
    end
  end
  (1..node_map.length).map do |i|
    n = node_map[i]
    n ? n.neighbors.map(&:val) : []
  end
end

def node_list_by_val(root)
  return [] if root.nil?
  node_map = {}
  queue = [root]
  node_map[root.val] = root
  until queue.empty?
    curr = queue.shift
    curr.neighbors.each do |nb|
      unless node_map.key?(nb.val)
        node_map[nb.val] = nb
        queue << nb
      end
    end
  end
  (1..node_map.length).map { |i| node_map[i] }
end

def verify_deep_copy(orig_root, ret_root)
  orig_nodes = node_list_by_val(orig_root)
  ret_nodes = node_list_by_val(ret_root)
  if orig_nodes.length != ret_nodes.length
    raise "Deep copy failed: structure size mismatch #{orig_nodes.length} vs #{ret_nodes.length}"
  end
  orig_nodes.each_with_index do |o, idx|
    r = ret_nodes[idx]
    raise "Deep copy failed: node #{idx + 1} is the same object as original" if o.equal?(r)
    raise "Deep copy failed: node #{idx + 1} value mismatch #{o.val} vs #{r.val}" if o.val != r.val
  end
end

def convert_input(val, type_str)
  return build_tree(val) if type_str.start_with?('tree')
  return build_linked_list(val) if type_str.start_with?('linkedlist')
  return build_graph(val) if type_str.start_with?('graph')
  val
end

def convert_output(val, type_str)
  return serialize_tree(val) if val.is_a?(TreeNode) || type_str.start_with?('tree')
  return serialize_linked_list(val) if val.is_a?(ListNode) || type_str.start_with?('linkedlist')
  return serialize_graph(val) if val.is_a?(GraphNode) || type_str.start_with?('graph')
  val
end

# USER_CODE_MARKER

# What a test prints, kept up to just past the judge's output limit (64 KB) so a print loop
# cannot fill memory; the judge fails a test that goes over with Output Limit Exceeded (T5).
require 'stringio'

class JudgeCapturedStdout < StringIO
  CAP = 64 * 1024 + 1

  def write(*args)
    s = args.join
    room = CAP - string.bytesize
    super(s.byteslice(0, room)) if room > 0
    s.bytesize
  end
end

def judge_call(converted_inputs)
  if Object.const_defined?(:Solution)
    instance = Solution.new
    return instance.send(:"{{FUNCTION_NAME}}", *converted_inputs) if instance.respond_to?(:"{{FUNCTION_NAME}}", true)
  end
  return send(:"{{FUNCTION_NAME}}", *converted_inputs) if respond_to?(:"{{FUNCTION_NAME}}", true)
  raise NameError, "Function '{{FUNCTION_NAME}}' not found"
end

# Every test in one process (JUDGE_FIX_PLAN T5): one result line per test on stderr.
def run_all
  if ARGV.length < 1
    STDERR.puts JSON.generate({ fatal: 'missing tests payload' })
    return
  end
  tests = JSON.parse(Base64.decode64(ARGV[0]))
  params = begin
    JSON.parse('{{PARAMS_JSON}}')
  rescue StandardError
    []
  end
  params ||= []
  return_type = "{{RETURN_TYPE}}"
  require_deep = begin
    {{REQUIRE_DEEP_COPY}}
  rescue StandardError
    false
  end
  real_stdout = $stdout

  tests.each_with_index do |test, i|
    captured = JudgeCapturedStdout.new
    $stdout = captured
    begin
      raw_inputs = test['inputs'] || []
      converted_inputs = raw_inputs.each_with_index.map do |val, j|
        type_str = params[j] ? params[j]['type'] : ''
        convert_input(val, type_str)
      end
      out = judge_call(converted_inputs)
      if return_type.start_with?('graph') && require_deep
        orig_root = $ORIGINAL_GRAPH_NODES ? $ORIGINAL_GRAPH_NODES[0] : nil
        verify_deep_copy(orig_root, out) if orig_root && out
      end
      converted_out = if return_type == 'void' && !converted_inputs.empty?
                        convert_output(converted_inputs[0], params[0] ? params[0]['type'] : '')
                      else
                        convert_output(out, return_type)
                      end
      $stdout = real_stdout
      STDERR.puts JSON.generate({ test: i + 1, output: converted_out, stdout: captured.string })
    rescue Exception => e
      $stdout = real_stdout
      STDERR.puts JSON.generate({ test: i + 1, error: e.message, traceback: e.full_message(highlight: false), stdout: captured.string })
    ensure
      $stdout = real_stdout
    end
  end
rescue Exception => e
  STDERR.puts JSON.generate({ fatal: e.message })
end

run_all
