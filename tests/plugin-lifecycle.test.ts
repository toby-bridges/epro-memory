import { afterEach, describe, expect, it, vi } from "vitest";

type ServiceRegistration = {
  id: string;
  start: () => void | Promise<void>;
  stop?: () => void | Promise<void>;
};

function makeMockStore(overrides: Record<string, unknown> = {}) {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    store: vi.fn(),
    getById: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(undefined),
    deleteById: vi.fn().mockResolvedValue(false),
    search: vi.fn().mockResolvedValue([]),
    findByCategory: vi.fn().mockResolvedValue([]),
    getAll: vi.fn().mockResolvedValue([]),
    countRows: vi.fn().mockResolvedValue(0),
    incrementActiveCount: vi.fn().mockResolvedValue(undefined),
    maintain: vi.fn().mockResolvedValue({
      deleted: 0,
      reason: "no cleanup needed",
    }),
    optimize: vi.fn().mockResolvedValue(null),
    ensureIndices: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function registerPlugin(opts: {
  backend: "sqlite" | "lancedb";
  sqliteStore?: ReturnType<typeof makeMockStore>;
  lanceStore?: ReturnType<typeof makeMockStore>;
}) {
  vi.resetModules();

  const sqliteStore = opts.sqliteStore ?? makeMockStore();
  const lanceStore = opts.lanceStore ?? makeMockStore();

  vi.doMock("../sqlite-store.js", () => ({
    SQLiteStore: vi.fn(function MockSQLiteStore() {
      return sqliteStore;
    }),
  }));
  vi.doMock("../lancedb-store.js", () => ({
    LanceDBStore: vi.fn(function MockLanceDBStore() {
      return lanceStore;
    }),
  }));

  const { default: plugin } = await import("../index.js");

  let registered: ServiceRegistration | undefined;
  const api = {
    pluginConfig: {
      embedding: { apiKey: "embed-key" },
      llm: { apiKey: "llm-key" },
      backend: opts.backend,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    resolvePath: (input: string) => input,
    on: vi.fn(),
    registerService: vi.fn((service: ServiceRegistration) => {
      registered = service;
    }),
  };

  plugin.register(api as any);

  if (!registered) {
    throw new Error("service was not registered");
  }

  return { service: registered, sqliteStore, lanceStore };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("plugin service lifecycle", () => {
  it("registers service stop hook", async () => {
    const { service } = await registerPlugin({ backend: "sqlite" });
    expect(typeof service.stop).toBe("function");
  });

  it("calls db.close on stop when close is available", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const sqliteStore = makeMockStore({ close });
    const { service } = await registerPlugin({
      backend: "sqlite",
      sqliteStore,
    });

    if (!service.stop) {
      throw new Error("service.stop is missing");
    }

    await service.start();
    await service.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not throw on stop when backend close is undefined", async () => {
    const lanceStore = makeMockStore();
    const { service } = await registerPlugin({
      backend: "lancedb",
      lanceStore,
    });

    if (!service.stop) {
      throw new Error("service.stop is missing");
    }

    await service.start();
    await service.stop();
  });

  it("logs warning and does not throw when db.close rejects", async () => {
    const close = vi.fn().mockRejectedValue(new Error("close failed"));
    const sqliteStore = makeMockStore({ close });
    const { service } = await registerPlugin({
      backend: "sqlite",
      sqliteStore,
    });

    if (!service.stop) {
      throw new Error("service.stop is missing");
    }

    await service.start();
    // Must resolve without throwing
    await expect(service.stop()).resolves.toBeUndefined();
  });
});
