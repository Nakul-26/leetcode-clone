// <bits/stdc++.h> comes first so g++ uses the image's precompiled copy (built at -O2, the
// flags CppAdapter compiles with; JUDGE_FIX_PLAN T7/T11).
#include <bits/stdc++.h>

// JUDGE_IO_MARKER

// User's solution inclusion
#include "solution.cpp"

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "Missing input payload" << std::endl;
        return 1;
    }

    try {
        judge_io::Value payload = judge_io::parse(judge_io::base64_decode(argv[1]));
        const judge_io::Value& inputs = judge_io::field(payload, "inputs");
        const int test_no = 0;

        Solution sol;

        // GENERATED_CALL_MARKER

    } catch (const std::exception& e) {
        judge_io::print_error(0, e.what());
    }

    return 0;
}
