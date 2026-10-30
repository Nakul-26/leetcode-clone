// JUDGE_IO_MARKER

// The generated call hands its result here just before printing it; the batch wrapper adds
// the test number and what the test printed.
static void judge_before_print(struct json_object* result) { (void)result; }

// User's solution inclusion
#include "solution.c"

int main(int argc, char** argv) {
    if (argc < 2) {
        fprintf(stderr, "{\"error\": \"Runtime Error\", \"message\": \"Missing input payload\"}\n");
        return 1;
    }

    size_t decoded_len;
    char* decoded = base64_decode(argv[1], &decoded_len);
    if (!decoded) {
        fprintf(stderr, "{\"error\": \"Runtime Error\", \"message\": \"Failed to decode base64 payload\"}\n");
        return 1;
    }

    struct json_object* payload = json_tokener_parse(decoded);
    if (!payload) {
        fprintf(stderr, "{\"error\": \"Runtime Error\", \"message\": \"Failed to parse JSON payload\"}\n");
        free(decoded);
        return 1;
    }

    struct json_object* inputs;
    if (!json_object_object_get_ex(payload, "inputs", &inputs)) {
        fprintf(stderr, "{\"error\": \"Runtime Error\", \"message\": \"Missing 'inputs' in payload\"}\n");
        json_object_put(payload);
        free(decoded);
        return 1;
    }

    struct json_object* result = json_object_new_object();

    // GENERATED_CALL_MARKER

    json_object_put(result);
    json_object_put(payload);
    free(decoded);

    return 0;
}
