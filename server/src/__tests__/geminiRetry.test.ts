import { describe, it, expect } from "vitest";
import { isRetryableJsonError } from "../services/GeminiService.js";

describe("isRetryableJsonError", () => {
  it("retries transient API errors", () => {
    expect(isRetryableJsonError(new Error('{"error":{"code":503,"status":"UNAVAILABLE"}}'))).toBe(true);
    expect(isRetryableJsonError(new Error("429 Too Many Requests"))).toBe(true);
  });

  it("retries an answer cut short mid-JSON (Lr0U-0HMQgo clips)", () => {
    let err: unknown;
    try {
      JSON.parse('{"clips":[{"title":"Unter');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SyntaxError);
    expect(isRetryableJsonError(err)).toBe(true);
  });

  it("does not retry other errors", () => {
    expect(isRetryableJsonError(new Error("400 INVALID_ARGUMENT"))).toBe(false);
    expect(isRetryableJsonError("string")).toBe(false);
  });
});
