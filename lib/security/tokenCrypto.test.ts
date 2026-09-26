import { beforeAll, describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "./tokenCrypto";

describe("tokenCrypto", () => {
  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  it("round-trips a token", () => {
    const plaintext = "sq0atp-example-access-token";
    const encrypted = encryptToken(plaintext);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptToken(encrypted)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptToken("same-token");
    const b = encryptToken("same-token");
    expect(a).not.toBe(b);
  });

  it("throws on a tampered ciphertext instead of silently returning garbage", () => {
    const encrypted = encryptToken("secret");
    const [iv, tag, ciphertext] = encrypted.split(":");
    const tampered = [iv, tag, ciphertext.slice(0, -2) + "AA"].join(":");
    expect(() => decryptToken(tampered)).toThrow();
  });
});
