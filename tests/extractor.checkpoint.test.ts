import { describe, it } from "vitest";

describe("MemoryExtractor checkpoint idempotency contracts", () => {
  it.todo(
    "extractWithCheckpoint should not replay a candidate after processCandidate succeeds but checkpoint.save fails",
  );

  it.todo(
    "resumeFromCheckpoint should not replay a candidate that already produced side effects before a checkpoint persistence failure",
  );
});
