// Shared by cpp_single_wrapper.tpl and cpp_batch_wrapper.tpl; GenerateWrapper pastes it in
// place of the templates' judge-io marker line.
//
// A small JSON reader and writer for the judge's own types (number, string, boolean, arrays,
// matrices, linked lists, trees, graphs), in place of nlohmann::json (JUDGE_FIX_PLAN T11).
// nlohmann's templates made up nearly all of a function-mode compile; with this code the
// wrapper builds at -O2 with the image's precompiled <bits/stdc++.h> (the templates include
// it first), and the whole compile is about 4.5x faster (5.4 s -> 1.2 s on one core).

// Data structures
struct ListNode {
    int val;
    ListNode *next;
    ListNode() : val(0), next(nullptr) {}
    ListNode(int x) : val(x), next(nullptr) {}
    ListNode(int x, ListNode *next) : val(x), next(next) {}
};

struct TreeNode {
    int val;
    TreeNode *left;
    TreeNode *right;
    TreeNode() : val(0), left(nullptr), right(nullptr) {}
    TreeNode(int x) : val(x), left(nullptr), right(nullptr) {}
    TreeNode(int x, TreeNode *left, TreeNode *right) : val(x), left(left), right(right) {}
};

class Node {
public:
    int val;
    std::vector<Node*> neighbors;
    Node() { val = 0; neighbors = std::vector<Node*>(); }
    Node(int _val) { val = _val; neighbors = std::vector<Node*>(); }
    Node(int _val, std::vector<Node*> _neighbors) { val = _val; neighbors = _neighbors; }
};

// The wrapper's own code is built at -O1 while the student's stays at -O2: it only parses
// arguments that fit on a command line and prints one line per test, and at -O2 it took
// longer to build than a typical solution (measured on one core: 1.76 s -> 1.20 s per
// compile, against 0.62 s for the solution on its own).
#pragma GCC push_options
#pragma GCC optimize("O1")

namespace judge_io {

struct Value {
    enum Kind { Null, Bool, Int, Float, String, Array, Object };
    Kind kind = Null;
    bool b = false;
    long long i = 0;
    double f = 0;
    std::string s;
    std::vector<std::string> keys;  // Object member names, parallel to items
    std::vector<Value> items;       // Array elements or Object member values
};

inline const char* kind_name(const Value& v) {
    switch (v.kind) {
    case Value::Null: return "null";
    case Value::Bool: return "boolean";
    case Value::Int:
    case Value::Float: return "number";
    case Value::String: return "string";
    case Value::Array: return "array";
    default: return "object";
    }
}

inline std::runtime_error type_error(const char* want, const Value& v) {
    return std::runtime_error(std::string("type must be ") + want + ", but is " + kind_name(v));
}

class Parser {
public:
    explicit Parser(const std::string& text) : t(text) {}

    Value parse() {
        Value v = value();
        space();
        if (p != t.size()) fail("unexpected trailing input");
        return v;
    }

private:
    const std::string& t;
    size_t p = 0;

    [[noreturn]] void fail(const char* what) {
        throw std::runtime_error(std::string("JSON parse error at byte ") + std::to_string(p) + ": " + what);
    }
    void space() {
        while (p < t.size() && (t[p] == ' ' || t[p] == '\t' || t[p] == '\n' || t[p] == '\r')) p++;
    }
    bool take(char c) {
        space();
        if (p < t.size() && t[p] == c) { p++; return true; }
        return false;
    }
    void expect(char c) {
        if (!take(c)) fail("unexpected character");
    }
    void literal(const char* word) {
        size_t n = std::strlen(word);
        if (t.compare(p, n, word) != 0) fail("invalid literal");
        p += n;
    }

    Value value() {
        space();
        if (p >= t.size()) fail("unexpected end of input");
        Value v;
        char c = t[p];
        if (c == '{') {
            p++;
            v.kind = Value::Object;
            if (take('}')) return v;
            do {
                space();
                if (p >= t.size() || t[p] != '"') fail("expected a member name");
                v.keys.push_back(str());
                expect(':');
                v.items.push_back(value());
            } while (take(','));
            expect('}');
        } else if (c == '[') {
            p++;
            v.kind = Value::Array;
            if (take(']')) return v;
            do {
                v.items.push_back(value());
            } while (take(','));
            expect(']');
        } else if (c == '"') {
            v.kind = Value::String;
            v.s = str();
        } else if (c == 't') {
            literal("true");
            v.kind = Value::Bool;
            v.b = true;
        } else if (c == 'f') {
            literal("false");
            v.kind = Value::Bool;
        } else if (c == 'n') {
            literal("null");
        } else if (c == '-' || (c >= '0' && c <= '9')) {
            number(v);
        } else {
            fail("unexpected character");
        }
        return v;
    }

    void number(Value& v) {
        size_t start = p;
        bool integral = true;
        if (t[p] == '-') p++;
        if (p >= t.size() || !std::isdigit(static_cast<unsigned char>(t[p]))) fail("invalid number");
        while (p < t.size() && std::isdigit(static_cast<unsigned char>(t[p]))) p++;
        if (p < t.size() && t[p] == '.') {
            integral = false;
            p++;
            if (p >= t.size() || !std::isdigit(static_cast<unsigned char>(t[p]))) fail("invalid number");
            while (p < t.size() && std::isdigit(static_cast<unsigned char>(t[p]))) p++;
        }
        if (p < t.size() && (t[p] == 'e' || t[p] == 'E')) {
            integral = false;
            p++;
            if (p < t.size() && (t[p] == '+' || t[p] == '-')) p++;
            if (p >= t.size() || !std::isdigit(static_cast<unsigned char>(t[p]))) fail("invalid number");
            while (p < t.size() && std::isdigit(static_cast<unsigned char>(t[p]))) p++;
        }
        std::string digits = t.substr(start, p - start);
        if (integral) {
            errno = 0;
            long long n = std::strtoll(digits.c_str(), nullptr, 10);
            if (errno != ERANGE) {
                v.kind = Value::Int;
                v.i = n;
                return;
            }
        }
        v.kind = Value::Float;
        v.f = std::strtod(digits.c_str(), nullptr);
    }

    unsigned hex4() {
        if (p + 4 > t.size()) fail("invalid \\u escape");
        unsigned u = 0;
        for (int k = 0; k < 4; k++) {
            char h = t[p++];
            u <<= 4;
            if (h >= '0' && h <= '9') u |= h - '0';
            else if (h >= 'a' && h <= 'f') u |= h - 'a' + 10;
            else if (h >= 'A' && h <= 'F') u |= h - 'A' + 10;
            else fail("invalid \\u escape");
        }
        return u;
    }

    static void utf8(std::string& out, unsigned cp) {
        if (cp < 0x80) {
            out += static_cast<char>(cp);
        } else if (cp < 0x800) {
            out += static_cast<char>(0xC0 | (cp >> 6));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            out += static_cast<char>(0xE0 | (cp >> 12));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        } else {
            out += static_cast<char>(0xF0 | (cp >> 18));
            out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
            out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
            out += static_cast<char>(0x80 | (cp & 0x3F));
        }
    }

    std::string str() {
        p++;  // opening quote
        std::string out;
        while (true) {
            if (p >= t.size()) fail("unterminated string");
            char c = t[p++];
            if (c == '"') return out;
            if (c != '\\') {
                out += c;
                continue;
            }
            if (p >= t.size()) fail("unterminated string");
            char e = t[p++];
            switch (e) {
            case '"': out += '"'; break;
            case '\\': out += '\\'; break;
            case '/': out += '/'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'n': out += '\n'; break;
            case 'r': out += '\r'; break;
            case 't': out += '\t'; break;
            case 'u': {
                unsigned cp = hex4();
                if (cp >= 0xD800 && cp <= 0xDBFF && p + 1 < t.size() && t[p] == '\\' && t[p + 1] == 'u') {
                    size_t back = p;
                    p += 2;
                    unsigned lo = hex4();
                    if (lo >= 0xDC00 && lo <= 0xDFFF) cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    else p = back;
                }
                utf8(out, cp);
                break;
            }
            default: fail("invalid escape");
            }
        }
    }
};

inline Value parse(const std::string& text) { return Parser(text).parse(); }

// The member named key, or a null value when v is not an object or has no such member.
inline const Value& field(const Value& v, const std::string& key) {
    static const Value missing;
    if (v.kind == Value::Object) {
        for (size_t k = 0; k < v.keys.size(); k++) {
            if (v.keys[k] == key) return v.items[k];
        }
    }
    return missing;
}

// The idx-th input argument.
inline const Value& at(const Value& inputs, size_t idx) {
    if (inputs.kind != Value::Array) throw type_error("array", inputs);
    if (idx >= inputs.items.size()) throw std::out_of_range("missing input argument " + std::to_string(idx + 1));
    return inputs.items[idx];
}

// Reading: one from() per judge type. A number read into an int truncates, as the
// judge's other languages do.
inline void from(const Value& v, int& out) {
    if (v.kind == Value::Int) out = static_cast<int>(v.i);
    else if (v.kind == Value::Float) out = static_cast<int>(v.f);
    else if (v.kind == Value::Bool) out = v.b;
    else throw type_error("number", v);
}

inline void from(const Value& v, bool& out) {
    if (v.kind != Value::Bool) throw type_error("boolean", v);
    out = v.b;
}

inline void from(const Value& v, std::string& out) {
    if (v.kind != Value::String) throw type_error("string", v);
    out = v.s;
}

inline void from(const Value& v, ListNode*& out) {
    out = nullptr;
    if (v.kind != Value::Array) return;
    ListNode dummy;
    ListNode* curr = &dummy;
    for (const Value& el : v.items) {
        int x;
        from(el, x);
        curr->next = new ListNode(x);
        curr = curr->next;
    }
    out = dummy.next;
}

inline void from(const Value& v, TreeNode*& out) {
    out = nullptr;
    const std::vector<Value>& a = v.items;
    if (v.kind != Value::Array || a.empty() || a[0].kind == Value::Null) return;
    int x;
    from(a[0], x);
    TreeNode* root = new TreeNode(x);
    std::queue<TreeNode*> q;
    q.push(root);
    size_t i = 1;
    while (!q.empty() && i < a.size()) {
        TreeNode* node = q.front();
        q.pop();
        if (i < a.size() && a[i].kind != Value::Null) {
            from(a[i], x);
            node->left = new TreeNode(x);
            q.push(node->left);
        }
        i++;
        if (i < a.size() && a[i].kind != Value::Null) {
            from(a[i], x);
            node->right = new TreeNode(x);
            q.push(node->right);
        }
        i++;
    }
    out = root;
}

// A graph is an adjacency list of 1-based node numbers; the first node is returned.
inline void from(const Value& v, Node*& out) {
    out = nullptr;
    if (v.kind != Value::Array || v.items.empty()) return;
    size_t n = v.items.size();
    std::vector<Node*> nodes(n);
    for (size_t i = 0; i < n; i++) nodes[i] = new Node(static_cast<int>(i) + 1);
    for (size_t i = 0; i < n; i++) {
        if (v.items[i].kind != Value::Array) throw type_error("array", v.items[i]);
        for (const Value& nb : v.items[i].items) {
            int idx;
            from(nb, idx);
            if (idx < 1 || static_cast<size_t>(idx) > n) throw std::out_of_range("graph neighbour " + std::to_string(idx) + " out of range");
            nodes[i]->neighbors.push_back(nodes[idx - 1]);
        }
    }
    out = nodes[0];
}

template <class T>
void from(const Value& v, std::vector<T>& out) {
    if (v.kind != Value::Array) throw type_error("array", v);
    out.clear();
    out.reserve(v.items.size());
    for (const Value& el : v.items) {
        T x{};
        from(el, x);
        out.push_back(std::move(x));
    }
}

template <class T>
T get(const Value& v) {
    T out{};
    from(v, out);
    return out;
}

// Writing.
inline void write(std::string& o, std::nullptr_t) { o += "null"; }
inline void write(std::string& o, bool b) { o += b ? "true" : "false"; }
inline void write(std::string& o, int x) { o += std::to_string(x); }

inline void write(std::string& o, const std::string& s) {
    static const char* hex = "0123456789abcdef";
    o += '"';
    for (unsigned char c : s) {
        switch (c) {
        case '"': o += "\\\""; break;
        case '\\': o += "\\\\"; break;
        case '\b': o += "\\b"; break;
        case '\f': o += "\\f"; break;
        case '\n': o += "\\n"; break;
        case '\r': o += "\\r"; break;
        case '\t': o += "\\t"; break;
        default:
            if (c < 0x20) {
                o += "\\u00";
                o += hex[c >> 4];
                o += hex[c & 0xF];
            } else {
                o += static_cast<char>(c);
            }
        }
    }
    o += '"';
}

inline void write(std::string& o, const ListNode* p) {
    if (!p) { o += "null"; return; }
    o += '[';
    for (bool first = true; p; p = p->next, first = false) {
        if (!first) o += ',';
        write(o, p->val);
    }
    o += ']';
}

// Level order, with null for missing children and trailing nulls dropped.
inline void write(std::string& o, const TreeNode* root) {
    if (!root) { o += "null"; return; }
    std::vector<const TreeNode*> order;
    std::queue<const TreeNode*> q;
    q.push(root);
    while (!q.empty()) {
        const TreeNode* node = q.front();
        q.pop();
        order.push_back(node);
        if (node) {
            q.push(node->left);
            q.push(node->right);
        }
    }
    while (!order.empty() && !order.back()) order.pop_back();
    o += '[';
    for (size_t i = 0; i < order.size(); i++) {
        if (i) o += ',';
        if (order[i]) write(o, order[i]->val);
        else o += "null";
    }
    o += ']';
}

// The adjacency list of the nodes reachable from node, by node number 1..n.
inline void write(std::string& o, const Node* node) {
    if (!node) { o += "null"; return; }
    std::unordered_map<int, const Node*> seen;
    std::queue<const Node*> q;
    q.push(node);
    seen[node->val] = node;
    while (!q.empty()) {
        const Node* curr = q.front();
        q.pop();
        for (const Node* nb : curr->neighbors) {
            if (seen.find(nb->val) == seen.end()) {
                seen[nb->val] = nb;
                q.push(nb);
            }
        }
    }
    o += '[';
    for (int i = 1; i <= static_cast<int>(seen.size()); i++) {
        if (i > 1) o += ',';
        o += '[';
        auto it = seen.find(i);
        if (it != seen.end()) {
            bool first = true;
            for (const Node* nb : it->second->neighbors) {
                if (!first) o += ',';
                write(o, nb->val);
                first = false;
            }
        }
        o += ']';
    }
    o += ']';
}

template <class T>
void write(std::string& o, const std::vector<T>& v) {
    o += '[';
    bool first = true;
    for (auto&& el : v) {
        if (!first) o += ',';
        write(o, el);
        first = false;
    }
    o += ']';
}

// The batch wrapper points std::cout at this while a test runs, so each test's result line
// carries what that test printed, kept up to just past the judge's output limit (64 KB) so a
// print loop cannot fill memory; the judge fails a test that goes over with Output Limit
// Exceeded. printf bypasses it and still goes to the process's stdout.
struct CapturedStdout : std::streambuf {
    static constexpr size_t cap = 64 * 1024 + 1;
    std::string data;
    int_type overflow(int_type c) override {
        if (c == traits_type::eof()) return 0;
        if (data.size() < cap) data.push_back(static_cast<char>(c));
        return c;
    }
    std::streamsize xsputn(const char* s, std::streamsize n) override {
        if (data.size() < cap) data.append(s, std::min<size_t>(static_cast<size_t>(n), cap - data.size()));
        return n;
    }
};

inline CapturedStdout*& captured_stdout() {
    static CapturedStdout* current = nullptr;
    return current;
}

inline void add_captured_stdout(std::string& line) {
    if (CapturedStdout* c = captured_stdout()) {
        line += ",\"stdout\":";
        write(line, c->data);
    }
}

// One judge result line on stderr: {"test":N,"output":...}, or {"output":...} when test is 0
// (the single-test wrapper).
template <class T>
void print_output(int test, const T& value) {
    std::string line = "{";
    if (test > 0) line += "\"test\":" + std::to_string(test) + ",";
    line += "\"output\":";
    write(line, value);
    add_captured_stdout(line);
    line += "}";
    std::cerr << line << std::endl;
}

inline void print_error(int test, const std::string& message) {
    std::string line = "{";
    if (test > 0) line += "\"test\":" + std::to_string(test) + ",";
    line += "\"error\":\"Runtime Error\",\"message\":";
    write(line, message);
    add_captured_stdout(line);
    line += "}";
    std::cerr << line << std::endl;
}

inline void print_fatal(const std::string& message) {
    std::string line = "{\"fatal\":";
    write(line, message);
    line += "}";
    std::cerr << line << std::endl;
}

inline std::string base64_decode(const std::string& in) {
    std::string out;
    std::vector<int> T(256, -1);
    for (int i = 0; i < 64; i++) T["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[i]] = i;
    int val = 0, valb = -8;
    for (unsigned char c : in) {
        if (T[c] == -1) break;
        val = (val << 6) + T[c];
        valb += 6;
        if (valb >= 0) {
            out.push_back(char((val >> valb) & 0xFF));
            valb -= 8;
        }
    }
    return out;
}

}  // namespace judge_io

#pragma GCC pop_options
