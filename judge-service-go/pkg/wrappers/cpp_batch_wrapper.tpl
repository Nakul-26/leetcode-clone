// <bits/stdc++.h> comes first so g++ uses the image's precompiled copy (built at -O2, the
// flags CppAdapter compiles with; JUDGE_FIX_PLAN T7/T11).
#include <bits/stdc++.h>

// JUDGE_IO_MARKER

#include "solution.cpp"

int main(int argc, char** argv) {
    if (argc < 2) return 1;
    try {
        judge_io::Value tests = judge_io::parse(judge_io::base64_decode(argv[1]));
        if (tests.kind != judge_io::Value::Array) return 2;

        Solution sol;
        for (size_t i = 0; i < tests.items.size(); ++i) {
            const int test_no = static_cast<int>(i) + 1;
            const judge_io::Value& inputs = judge_io::field(tests.items[i], "inputs");
            try {
                // GENERATED_CALL_MARKER
            } catch (const std::exception& e) {
                judge_io::print_error(test_no, e.what());
            }
        }
    } catch (const std::exception& e) {
        judge_io::print_fatal(e.what());
    }
    return 0;
}
