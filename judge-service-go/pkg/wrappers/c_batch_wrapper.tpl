// JUDGE_IO_MARKER

#include <signal.h>
#include <sys/resource.h>
#include <unistd.h>

// What a test prints (JUDGE_FIX_PLAN T5): stdout is pointed at a temporary file while the
// test runs, and the result line carries up to just past the judge's output limit (64 KB);
// the judge fails a test that goes over with Output Limit Exceeded. A file-size limit stops a
// print loop from filling memory-backed /tmp (writes past it fail instead).
#define JUDGE_STDOUT_CAP (64 * 1024 + 1)
static int judge_real_stdout = -1;
static FILE* judge_capture = NULL;

static void judge_begin_capture(void) {
    fflush(stdout);
    judge_capture = tmpfile();
    if (!judge_capture) return;
    if (judge_real_stdout < 0) judge_real_stdout = dup(1);
    dup2(fileno(judge_capture), 1);
}

static void judge_end_capture(struct json_object* result) {
    if (!judge_capture) return;
    fflush(stdout);
    dup2(judge_real_stdout, 1);
    char* buf = safe_malloc(JUDGE_STDOUT_CAP + 1);
    rewind(judge_capture);
    size_t n = fread(buf, 1, JUDGE_STDOUT_CAP, judge_capture);
    buf[n] = '\0';
    json_object_object_add(result, "stdout", json_object_new_string_len(buf, (int)n));
    free(buf);
    fclose(judge_capture);
    judge_capture = NULL;
}

static void judge_before_print(struct json_object* result) { judge_end_capture(result); }

// User's solution inclusion
#include "solution.c"

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "{\"fatal\": \"missing tests payload\"}\n");
        return 1;
    }
    size_t decoded_len;
    char* decoded = base64_decode(argv[1], &decoded_len);
    struct json_object* tests = decoded ? json_tokener_parse(decoded) : NULL;
    if (!tests || json_object_get_type(tests) != json_type_array) {
        fprintf(stderr, "{\"fatal\": \"unreadable tests payload\"}\n");
        return 1;
    }

    struct rlimit fsize = { JUDGE_STDOUT_CAP, JUDGE_STDOUT_CAP };
    setrlimit(RLIMIT_FSIZE, &fsize);
    signal(SIGXFSZ, SIG_IGN);

    int count = json_object_array_length(tests);
    for (int t = 0; t < count; t++) {
        struct json_object* inputs = NULL;
        json_object_object_get_ex(json_object_array_get_idx(tests, t), "inputs", &inputs);
        struct json_object* result = json_object_new_object();
        json_object_object_add(result, "test", json_object_new_int(t + 1));
        judge_begin_capture();
        {
        // GENERATED_CALL_MARKER
        }
        json_object_put(result);
    }
    json_object_put(tests);
    free(decoded);
    return 0;
}
