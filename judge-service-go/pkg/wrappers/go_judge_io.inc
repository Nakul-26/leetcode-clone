// Shared by go_wrapper.tpl and go_batch_wrapper.tpl (the generator pastes it at JUDGE_IO_MARKER).
// ListNode defines a node in a linked list.
type ListNode struct {
	Val  int
	Next *ListNode
}

// MarshalJSON for ListNode to convert it back to an array for JSON output.
func (l *ListNode) MarshalJSON() ([]byte, error) {
	if l == nil {
		return []byte("null"), nil
	}
	var vals []int
	curr := l
	for curr != nil {
		vals = append(vals, curr.Val)
		curr = curr.Next
	}
	return json.Marshal(vals)
}

// listFromJSON converts a JSON array of integers to a ListNode linked list.
func listFromJSON(data json.RawMessage) *ListNode {
	var vals []int
	if err := json.Unmarshal(data, &vals); err != nil {
		return nil
	}
	if len(vals) == 0 {
		return nil
	}
	dummy := &ListNode{}
	curr := dummy
	for _, v := range vals {
		curr.Next = &ListNode{Val: v}
		curr = curr.Next
	}
	return dummy.Next
}

// TreeNode defines a node in a binary tree.
type TreeNode struct {
	Val   int
	Left  *TreeNode
	Right *TreeNode
}

// MarshalJSON for TreeNode to convert it back to a level-order array for JSON output.
func (t *TreeNode) MarshalJSON() ([]byte, error) {
	if t == nil {
		return []byte("null"), nil
	}
	var res []*int
	queue := []*TreeNode{t}
	for len(queue) > 0 {
		node := queue[0]
		queue = queue[1:]
		if node != nil {
			v := node.Val
			res = append(res, &v)
			queue = append(queue, node.Left)
			queue = append(queue, node.Right)
		} else {
			res = append(res, nil)
		}
	}
	// Trim trailing nils
	for len(res) > 0 && res[len(res)-1] == nil {
		res = res[:len(res)-1]
	}
	return json.Marshal(res)
}

// treeFromJSON converts a JSON level-order array to a TreeNode binary tree.
func treeFromJSON(data json.RawMessage) *TreeNode {
	var vals []*int
	if err := json.Unmarshal(data, &vals); err != nil {
		return nil
	}
	if len(vals) == 0 || vals[0] == nil {
		return nil
	}
	root := &TreeNode{Val: *vals[0]}
	queue := []*TreeNode{root}
	i := 1
	for len(queue) > 0 && i < len(vals) {
		node := queue[0]
		queue = queue[1:]
		if i < len(vals) && vals[i] != nil {
			node.Left = &TreeNode{Val: *vals[i]}
			queue = append(queue, node.Left)
		}
		i++
		if i < len(vals) && vals[i] != nil {
			node.Right = &TreeNode{Val: *vals[i]}
			queue = append(queue, node.Right)
		}
		i++
	}
	return root
}

// Node defines a node in a graph.
type Node struct {
	Val       int
	Neighbors []*Node
}

// MarshalJSON for Node to convert it back to an adjacency list for JSON output.
func (n *Node) MarshalJSON() ([]byte, error) {
	if n == nil {
		return []byte("null"), nil
	}
	nodeMap := make(map[int]*Node)
	queue := []*Node{n}
	nodeMap[n.Val] = n
	for len(queue) > 0 {
		curr := queue[0]
		queue = queue[1:]
		for _, neighbor := range curr.Neighbors {
			if _, ok := nodeMap[neighbor.Val]; !ok {
				nodeMap[neighbor.Val] = neighbor
				queue = append(queue, neighbor)
			}
		}
	}
	res := make([][]int, len(nodeMap))
	for i := 1; i <= len(nodeMap); i++ {
		if node, ok := nodeMap[i]; ok {
			neighbors := make([]int, len(node.Neighbors))
			for j, nb := range node.Neighbors {
				neighbors[j] = nb.Val
			}
			res[i-1] = neighbors
		} else {
			res[i-1] = []int{}
		}
	}
	return json.Marshal(res)
}

// graphFromJSON converts a JSON adjacency list to a Node graph.
func graphFromJSON(data json.RawMessage) *Node {
	var adj [][]int
	if err := json.Unmarshal(data, &adj); err != nil {
		return nil
	}
	if len(adj) == 0 {
		return nil
	}
	nodes := make([]*Node, len(adj))
	for i := range nodes {
		nodes[i] = &Node{Val: i + 1}
	}
	for i, neighbors := range adj {
		for _, nbIdx := range neighbors {
			nodes[i].Neighbors = append(nodes[i].Neighbors, nodes[nbIdx-1])
		}
	}
	return nodes[0]
}

// USER_CODE_MARKER
