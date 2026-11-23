import { HttpError } from "./httpError.js";

// The longest program a student may submit or run against a stored problem. LeetCode allows
// about this much; a real solution is a few KB, and everything past the limit is compiled and
// run on every test. Partner ad-hoc runs (codeAssess) keep their own, larger limit
// (adhocExecution.service.js MAX_SOURCE_BYTES), part of their API contract.
export const MAX_CODE_BYTES = 64 * 1024;

export function assertCodeSize(code) {
  if (typeof code === "string" && Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    throw new HttpError(413, "Code too large", {
      msg: `Your code is longer than the ${MAX_CODE_BYTES / 1024} KB limit.`,
      error: `code exceeds the ${MAX_CODE_BYTES}-byte limit`
    });
  }
}
