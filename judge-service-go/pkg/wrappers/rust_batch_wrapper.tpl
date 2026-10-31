// wrapper injected by judge (single test execution for central comparator mode)

use std::cell::RefCell;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::rc::Rc;

// Data structures, matching LeetCode's own Rust convention: singly-owned Box for
// the linked list, and Rc<RefCell<..>> for tree/graph since those need shared,
// mutable references (a node can be reached via more than one path/parent).
#[derive(Debug)]
pub struct ListNode {
    pub val: i32,
    pub next: Option<Box<ListNode>>,
}

impl ListNode {
    #[inline]
    fn new(val: i32) -> Self {
        ListNode { next: None, val }
    }
}

#[derive(Debug)]
pub struct TreeNode {
    pub val: i32,
    pub left: Option<Rc<RefCell<TreeNode>>>,
    pub right: Option<Rc<RefCell<TreeNode>>>,
}

impl TreeNode {
    #[inline]
    fn new(val: i32) -> Self {
        TreeNode { val, left: None, right: None }
    }
}

#[derive(Debug)]
pub struct Node {
    pub val: i32,
    pub neighbors: Vec<Option<Rc<RefCell<Node>>>>,
}

impl Node {
    #[inline]
    fn new(val: i32) -> Self {
        Node { val, neighbors: vec![] }
    }
}

#[derive(Debug, Clone)]
enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

struct JsonParser<'a> {
    chars: std::iter::Peekable<std::str::Chars<'a>>,
}

impl<'a> JsonParser<'a> {
    fn new(s: &'a str) -> Self {
        JsonParser {
            chars: s.chars().peekable(),
        }
    }

    fn skip_ws(&mut self) {
        while let Some(&c) = self.chars.peek() {
            if c.is_whitespace() {
                self.chars.next();
            } else {
                break;
            }
        }
    }

    fn expect(&mut self, c: char) -> Result<(), String> {
        match self.chars.next() {
            Some(x) if x == c => Ok(()),
            other => Err(format!("expected '{}', got {:?}", c, other)),
        }
    }

    fn parse_value(&mut self) -> Result<Json, String> {
        self.skip_ws();
        match self.chars.peek() {
            Some('{') => self.parse_object(),
            Some('[') => self.parse_array(),
            Some('"') => self.parse_string().map(Json::Str),
            Some('t') | Some('f') => self.parse_bool(),
            Some('n') => self.parse_null(),
            Some(c) if c.is_ascii_digit() || *c == '-' => self.parse_number(),
            other => Err(format!("unexpected token: {:?}", other)),
        }
    }

    fn parse_object(&mut self) -> Result<Json, String> {
        self.expect('{')?;
        let mut entries = Vec::new();
        self.skip_ws();
        if self.chars.peek() == Some(&'}') {
            self.chars.next();
            return Ok(Json::Obj(entries));
        }
        loop {
            self.skip_ws();
            let key = self.parse_string()?;
            self.skip_ws();
            self.expect(':')?;
            let val = self.parse_value()?;
            entries.push((key, val));
            self.skip_ws();
            match self.chars.next() {
                Some(',') => continue,
                Some('}') => break,
                other => return Err(format!("expected ',' or '}}', got {:?}", other)),
            }
        }
        Ok(Json::Obj(entries))
    }

    fn parse_array(&mut self) -> Result<Json, String> {
        self.expect('[')?;
        let mut items = Vec::new();
        self.skip_ws();
        if self.chars.peek() == Some(&']') {
            self.chars.next();
            return Ok(Json::Arr(items));
        }
        loop {
            let val = self.parse_value()?;
            items.push(val);
            self.skip_ws();
            match self.chars.next() {
                Some(',') => continue,
                Some(']') => break,
                other => return Err(format!("expected ',' or ']', got {:?}", other)),
            }
        }
        Ok(Json::Arr(items))
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect('"')?;
        let mut s = String::new();
        loop {
            match self.chars.next() {
                Some('"') => break,
                Some('\\') => match self.chars.next() {
                    Some('"') => s.push('"'),
                    Some('\\') => s.push('\\'),
                    Some('/') => s.push('/'),
                    Some('n') => s.push('\n'),
                    Some('t') => s.push('\t'),
                    Some('r') => s.push('\r'),
                    Some('b') => s.push('\u{0008}'),
                    Some('f') => s.push('\u{000C}'),
                    Some('u') => {
                        let mut hex = String::new();
                        for _ in 0..4 {
                            if let Some(c) = self.chars.next() {
                                hex.push(c);
                            }
                        }
                        if let Ok(code) = u32::from_str_radix(&hex, 16) {
                            if let Some(ch) = char::from_u32(code) {
                                s.push(ch);
                            }
                        }
                    }
                    other => return Err(format!("invalid escape: {:?}", other)),
                },
                Some(c) => s.push(c),
                None => return Err("unterminated string".to_string()),
            }
        }
        Ok(s)
    }

    fn parse_bool(&mut self) -> Result<Json, String> {
        let lookahead: String = self.chars.clone().take(5).collect();
        if lookahead.starts_with("true") {
            for _ in 0..4 {
                self.chars.next();
            }
            Ok(Json::Bool(true))
        } else if lookahead.starts_with("false") {
            for _ in 0..5 {
                self.chars.next();
            }
            Ok(Json::Bool(false))
        } else {
            Err("invalid literal".to_string())
        }
    }

    fn parse_null(&mut self) -> Result<Json, String> {
        let lookahead: String = self.chars.clone().take(4).collect();
        if lookahead.starts_with("null") {
            for _ in 0..4 {
                self.chars.next();
            }
            Ok(Json::Null)
        } else {
            Err("invalid literal".to_string())
        }
    }

    fn parse_number(&mut self) -> Result<Json, String> {
        let mut s = String::new();
        if self.chars.peek() == Some(&'-') {
            s.push('-');
            self.chars.next();
        }
        while let Some(&c) = self.chars.peek() {
            if c.is_ascii_digit() || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-' {
                s.push(c);
                self.chars.next();
            } else {
                break;
            }
        }
        s.parse::<f64>().map(Json::Num).map_err(|e| e.to_string())
    }
}

fn parse_json(s: &str) -> Result<Json, String> {
    let mut p = JsonParser::new(s);
    p.parse_value()
}

fn get_inputs(payload: &Json) -> Vec<Json> {
    if let Json::Obj(entries) = payload {
        for (k, v) in entries {
            if k == "inputs" {
                if let Json::Arr(a) = v {
                    return a.clone();
                }
            }
        }
    }
    Vec::new()
}

fn json_to_i32(v: &Json) -> i32 {
    match v {
        Json::Num(n) => *n as i32,
        _ => 0,
    }
}

fn json_to_string(v: &Json) -> String {
    match v {
        Json::Str(s) => s.clone(),
        _ => String::new(),
    }
}

fn json_to_bool(v: &Json) -> bool {
    match v {
        Json::Bool(b) => *b,
        _ => false,
    }
}

fn json_to_vec_i32(v: &Json) -> Vec<i32> {
    match v {
        Json::Arr(a) => a.iter().map(json_to_i32).collect(),
        _ => Vec::new(),
    }
}

fn json_to_vec_string(v: &Json) -> Vec<String> {
    match v {
        Json::Arr(a) => a.iter().map(json_to_string).collect(),
        _ => Vec::new(),
    }
}

fn json_to_vec_bool(v: &Json) -> Vec<bool> {
    match v {
        Json::Arr(a) => a.iter().map(json_to_bool).collect(),
        _ => Vec::new(),
    }
}

fn json_to_matrix_i32(v: &Json) -> Vec<Vec<i32>> {
    match v {
        Json::Arr(a) => a.iter().map(json_to_vec_i32).collect(),
        _ => Vec::new(),
    }
}

fn json_to_matrix_string(v: &Json) -> Vec<Vec<String>> {
    match v {
        Json::Arr(a) => a.iter().map(json_to_vec_string).collect(),
        _ => Vec::new(),
    }
}

fn json_to_matrix_bool(v: &Json) -> Vec<Vec<bool>> {
    match v {
        Json::Arr(a) => a.iter().map(json_to_vec_bool).collect(),
        _ => Vec::new(),
    }
}

fn json_to_list(v: &Json) -> Option<Box<ListNode>> {
    let items = match v {
        Json::Arr(a) => a,
        _ => return None,
    };
    let mut dummy = Box::new(ListNode::new(0));
    let mut curr = &mut dummy;
    for item in items {
        curr.next = Some(Box::new(ListNode::new(json_to_i32(item))));
        curr = curr.next.as_mut().unwrap();
    }
    dummy.next
}

fn list_to_json(head: &Option<Box<ListNode>>) -> String {
    let mut parts = Vec::new();
    let mut curr = head;
    while let Some(node) = curr {
        parts.push(node.val.to_string());
        curr = &node.next;
    }
    format!("[{}]", parts.join(","))
}

fn json_to_tree(v: &Json) -> Option<Rc<RefCell<TreeNode>>> {
    let data = match v {
        Json::Arr(a) => a,
        _ => return None,
    };
    if data.is_empty() || matches!(data[0], Json::Null) {
        return None;
    }
    let root = Rc::new(RefCell::new(TreeNode::new(json_to_i32(&data[0]))));
    let mut queue: VecDeque<Rc<RefCell<TreeNode>>> = VecDeque::new();
    queue.push_back(Rc::clone(&root));
    let mut i = 1;
    while let Some(node) = queue.pop_front() {
        if i < data.len() {
            if !matches!(data[i], Json::Null) {
                let left = Rc::new(RefCell::new(TreeNode::new(json_to_i32(&data[i]))));
                node.borrow_mut().left = Some(Rc::clone(&left));
                queue.push_back(left);
            }
            i += 1;
        }
        if i < data.len() {
            if !matches!(data[i], Json::Null) {
                let right = Rc::new(RefCell::new(TreeNode::new(json_to_i32(&data[i]))));
                node.borrow_mut().right = Some(Rc::clone(&right));
                queue.push_back(right);
            }
            i += 1;
        }
    }
    Some(root)
}

fn tree_to_json(root: &Option<Rc<RefCell<TreeNode>>>) -> String {
    if root.is_none() {
        return "[]".to_string();
    }
    let mut result: Vec<Option<i32>> = Vec::new();
    let mut queue: VecDeque<Option<Rc<RefCell<TreeNode>>>> = VecDeque::new();
    queue.push_back(root.clone());
    while let Some(item) = queue.pop_front() {
        match item {
            Some(node) => {
                let n = node.borrow();
                result.push(Some(n.val));
                queue.push_back(n.left.clone());
                queue.push_back(n.right.clone());
            }
            None => result.push(None),
        }
    }
    while let Some(None) = result.last() {
        result.pop();
    }
    let parts: Vec<String> = result
        .iter()
        .map(|v| match v {
            Some(x) => x.to_string(),
            None => "null".to_string(),
        })
        .collect();
    format!("[{}]", parts.join(","))
}

fn json_to_graph(v: &Json) -> Option<Rc<RefCell<Node>>> {
    let adj = match v {
        Json::Arr(a) => a,
        _ => return None,
    };
    if adj.is_empty() {
        return None;
    }
    let nodes: Vec<Rc<RefCell<Node>>> = (0..adj.len())
        .map(|i| Rc::new(RefCell::new(Node::new((i + 1) as i32))))
        .collect();
    for (i, neighbors) in adj.iter().enumerate() {
        if let Json::Arr(ns) = neighbors {
            for nb in ns {
                let idx = (json_to_i32(nb) - 1) as usize;
                nodes[i].borrow_mut().neighbors.push(Some(Rc::clone(&nodes[idx])));
            }
        }
    }
    Some(Rc::clone(&nodes[0]))
}

fn graph_to_json(node: &Option<Rc<RefCell<Node>>>) -> String {
    let start = match node {
        Some(n) => Rc::clone(n),
        None => return "[]".to_string(),
    };
    let mut map: HashMap<i32, Rc<RefCell<Node>>> = HashMap::new();
    let mut queue: VecDeque<Rc<RefCell<Node>>> = VecDeque::new();
    queue.push_back(Rc::clone(&start));
    map.insert(start.borrow().val, Rc::clone(&start));
    while let Some(curr) = queue.pop_front() {
        let neighbors = curr.borrow().neighbors.clone();
        for nb_opt in neighbors {
            if let Some(nb) = nb_opt {
                let v = nb.borrow().val;
                if !map.contains_key(&v) {
                    map.insert(v, Rc::clone(&nb));
                    queue.push_back(nb);
                }
            }
        }
    }
    let n = map.len();
    let mut res: Vec<String> = Vec::new();
    for i in 1..=n {
        match map.get(&(i as i32)) {
            Some(node) => {
                let neighbors = &node.borrow().neighbors;
                let parts: Vec<String> = neighbors
                    .iter()
                    .filter_map(|nb| nb.as_ref().map(|x| x.borrow().val.to_string()))
                    .collect();
                res.push(format!("[{}]", parts.join(",")));
            }
            None => res.push("[]".to_string()),
        }
    }
    format!("[{}]", res.join(","))
}

fn i32_to_json(v: &i32) -> String {
    v.to_string()
}

fn bool_to_json(v: &bool) -> String {
    v.to_string()
}

fn string_to_json(v: &str) -> String {
    let mut s = String::with_capacity(v.len() + 2);
    s.push('"');
    for c in v.chars() {
        match c {
            '"' => s.push_str("\\\""),
            '\\' => s.push_str("\\\\"),
            '\n' => s.push_str("\\n"),
            '\r' => s.push_str("\\r"),
            '\t' => s.push_str("\\t"),
            c if (c as u32) < 0x20 => s.push_str(&format!("\\u{:04x}", c as u32)),
            c => s.push(c),
        }
    }
    s.push('"');
    s
}

fn vec_i32_to_json(v: &[i32]) -> String {
    let parts: Vec<String> = v.iter().map(|x| x.to_string()).collect();
    format!("[{}]", parts.join(","))
}

fn vec_string_to_json(v: &[String]) -> String {
    let parts: Vec<String> = v.iter().map(|x| string_to_json(x)).collect();
    format!("[{}]", parts.join(","))
}

fn vec_bool_to_json(v: &[bool]) -> String {
    let parts: Vec<String> = v.iter().map(|x| x.to_string()).collect();
    format!("[{}]", parts.join(","))
}

fn matrix_i32_to_json(v: &[Vec<i32>]) -> String {
    let parts: Vec<String> = v.iter().map(|x| vec_i32_to_json(x)).collect();
    format!("[{}]", parts.join(","))
}

fn matrix_string_to_json(v: &[Vec<String>]) -> String {
    let parts: Vec<String> = v.iter().map(|x| vec_string_to_json(x)).collect();
    format!("[{}]", parts.join(","))
}

fn matrix_bool_to_json(v: &[Vec<bool>]) -> String {
    let parts: Vec<String> = v.iter().map(|x| vec_bool_to_json(x)).collect();
    format!("[{}]", parts.join(","))
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [255u8; 256];
    for (i, &b) in TABLE.iter().enumerate() {
        lookup[b as usize] = i as u8;
    }

    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits = 0;
    for &b in input.as_bytes() {
        if b == b'=' || b == b'\n' || b == b'\r' {
            continue;
        }
        let val = lookup[b as usize];
        if val == 255 {
            return Err(format!("invalid base64 character: {}", b as char));
        }
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Ok(out)
}

// User's solution is written to solution.rs alongside this file and included
// verbatim here (not as a separate module) so its items don't need `pub`.
include!("solution.rs");

// What a test prints (JUDGE_FIX_PLAN T5): stdout (fd 1) is pointed at a temporary file while
// the test runs, and the result line carries up to just past the judge's output limit (64 KB);
// the judge fails a test that goes over with Output Limit Exceeded. A file-size limit stops a
// print loop from filling memory-backed /tmp (writes past it fail instead). Plain libc calls:
// the judge compiles with rustc alone, without crates.
#[repr(C)]
struct JudgeRlimit {
    cur: u64,
    max: u64,
}
extern "C" {
    fn dup(fd: i32) -> i32;
    fn dup2(from: i32, to: i32) -> i32;
    fn setrlimit(resource: i32, rlim: *const JudgeRlimit) -> i32;
    fn signal(sig: i32, handler: usize) -> usize;
}
const JUDGE_STDOUT_CAP: u64 = 64 * 1024 + 1;

static mut JUDGE_TEST: usize = 0;
static mut JUDGE_REAL_STDOUT: i32 = -1;
static mut JUDGE_CAPTURE: Option<(std::fs::File, String)> = None;

fn judge_begin_capture(test: usize) {
    use std::io::Write;
    use std::os::unix::io::AsRawFd;
    let _ = std::io::stdout().flush();
    let path = format!("/tmp/.judge-stdout-{}-{}", std::process::id(), test);
    unsafe {
        JUDGE_TEST = test;
        if let Ok(f) = std::fs::OpenOptions::new().create(true).truncate(true).read(true).write(true).open(&path) {
            if JUDGE_REAL_STDOUT < 0 {
                JUDGE_REAL_STDOUT = dup(1);
            }
            dup2(f.as_raw_fd(), 1);
            JUDGE_CAPTURE = Some((f, path));
        }
    }
}

// Ends the capture and returns what the test printed, as JSON ("" when nothing was captured).
fn judge_end_capture() -> String {
    use std::io::{Read, Seek, SeekFrom, Write};
    let _ = std::io::stdout().flush();
    unsafe {
        let taken = (*std::ptr::addr_of_mut!(JUDGE_CAPTURE)).take();
        if let Some((mut f, path)) = taken {
            dup2(JUDGE_REAL_STDOUT, 1);
            let mut buf = Vec::new();
            let _ = f.seek(SeekFrom::Start(0));
            let _ = (&mut f).take(JUDGE_STDOUT_CAP).read_to_end(&mut buf);
            let _ = std::fs::remove_file(path);
            return string_to_json(&String::from_utf8_lossy(&buf));
        }
    }
    string_to_json("")
}

// The generated call hands its result (already JSON) here.
fn judge_result(output_json: String) {
    let stdout = judge_end_capture();
    let test = unsafe { JUDGE_TEST };
    eprintln!("{{\"test\": {}, \"output\": {}, \"stdout\": {}}}", test, output_json, stdout);
}

// Every test in one process (JUDGE_FIX_PLAN T5): one result line per test on stderr.
fn main() {
    std::panic::set_hook(Box::new(|_| {}));

    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("{{\"fatal\": \"missing tests payload\"}}");
        return;
    }
    let tests = match base64_decode(&args[1])
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .and_then(|s| parse_json(&s).ok())
    {
        Some(Json::Arr(a)) => a,
        _ => {
            eprintln!("{{\"fatal\": \"unreadable tests payload\"}}");
            return;
        }
    };
    unsafe {
        let limit = JudgeRlimit { cur: JUDGE_STDOUT_CAP, max: JUDGE_STDOUT_CAP };
        setrlimit(1, &limit); // RLIMIT_FSIZE
        signal(25, 1); // SIGXFSZ: SIG_IGN, so a write past the limit fails instead of killing
    }

    for (t, test) in tests.iter().enumerate() {
        let test_no = t + 1;
        let inputs = get_inputs(test);
        judge_begin_capture(test_no);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // GENERATED_CALL_MARKER
        }));
        if let Err(panic_payload) = outcome {
            let msg = if let Some(s) = panic_payload.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown panic".to_string()
            };
            let stdout = judge_end_capture();
            eprintln!(
                "{{\"test\": {}, \"error\": \"Runtime Error\", \"message\": {}, \"stdout\": {}}}",
                test_no,
                string_to_json(&msg),
                stdout
            );
        }
    }
}
