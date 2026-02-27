import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TempManager } from "../services/TempManager.js";

const TEST_BASE = join(import.meta.dirname, "../../.lusk_temp_test");

describe("TempManager", () => {
  let tm: TempManager;

  beforeEach(async () => {
    await rm(TEST_BASE, { recursive: true, force: true });
    tm = new TempManager(TEST_BASE);
    await tm.init();
  });

  afterAll(async () => {
    await rm(TEST_BASE, { recursive: true, force: true });
  });

  it("init() creates the base directory", async () => {
    const info = await stat(TEST_BASE);
    expect(info.isDirectory()).toBe(true);
  });

  it("ensureSessionDir() creates the session directory", async () => {
    const id = randomUUID();
    const dir = await tm.ensureSessionDir(id);
    const info = await stat(dir);
    expect(info.isDirectory()).toBe(true);
    expect(dir).toBe(join(TEST_BASE, id));
  });

  it("getSessionDir() returns the correct path", () => {
    const id = "test-id";
    expect(tm.getSessionDir(id)).toBe(join(TEST_BASE, id));
  });

  it("sessionExists() returns true for existing session", async () => {
    const id = randomUUID();
    await tm.ensureSessionDir(id);
    expect(await tm.sessionExists(id)).toBe(true);
  });

  it("sessionExists() returns false for missing session", async () => {
    expect(await tm.sessionExists("nonexistent")).toBe(false);
  });

  it("cleanupAll() removes all session directories", async () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    await tm.ensureSessionDir(id1);
    await tm.ensureSessionDir(id2);

    await tm.cleanupAll();

    expect(await tm.sessionExists(id1)).toBe(false);
    expect(await tm.sessionExists(id2)).toBe(false);
    // Base dir should still exist (only children removed)
    const info = await stat(TEST_BASE);
    expect(info.isDirectory()).toBe(true);
  });
});
