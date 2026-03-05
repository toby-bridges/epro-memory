import { describe, expect, it } from "vitest";
import { CheckpointManager } from "../checkpoint.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("CheckpointManager.updateProgress", () => {
  it("advances progress when processedIndex increases", () => {
    const mgr = new CheckpointManager("/tmp/epro-checkpoint-tests", silentLogger);
    const cp0 = mgr.createInitial("s1", [], "u1");
    const cp1 = mgr.updateProgress(cp0, 0, "storing");
    const cp2 = mgr.updateProgress(cp1, 1, "storing");

    expect(cp1.processedIndex).toBe(0);
    expect(cp2.processedIndex).toBe(1);
  });

  it("rejects non-monotonic processedIndex updates", () => {
    const mgr = new CheckpointManager("/tmp/epro-checkpoint-tests", silentLogger);
    const cp0 = mgr.createInitial("s1", [], "u1");
    const cp1 = mgr.updateProgress(cp0, 2, "storing");

    expect(() => mgr.updateProgress(cp1, 2, "storing")).toThrow();
    expect(() => mgr.updateProgress(cp1, 1, "storing")).toThrow();
  });
});
