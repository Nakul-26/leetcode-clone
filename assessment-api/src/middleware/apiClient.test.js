import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";

import ApiClient from "../../models/ApiClient.mjs";
import { apiClientAuth, __resetLastUsedThrottle } from "./apiClient.mjs";
import { generateApiKey, hashApiKey, looksLikeApiKey, extractKeyPrefix } from "../utils/apiKey.js";

// Builds a throwaway app around the middleware so these assertions are about the
// auth decision itself, not about any particular route's behaviour.
function appWith(opts) {
  const app = express();
  app.get("/probe", apiClientAuth(opts), (req, res) =>
    res.json({
      ok: true,
      clientId: req.apiClient ? String(req.apiClient._id) : null,
      collegeId: req.collegeId ? String(req.collegeId) : null,
      legacy: !!req.legacyApiAuth
    })
  );
  return app;
}

const fromHeader = (name) => (req) => req.headers[name];

async function makeClient(overrides = {}) {
  const { key, keyPrefix, keyHash } = generateApiKey();
  const doc = await ApiClient.create({
    name: "Test Client",
    keyPrefix,
    keyHash,
    collegeId: new mongoose.Types.ObjectId(),
    scopes: ["codeassess"],
    ...overrides
  });
  return { key, doc };
}

describe("apiKey utils", () => {
  it("generates a key whose hash matches and whose prefix is recoverable", () => {
    const { key, keyPrefix, keyHash } = generateApiKey();
    expect(key.startsWith(`ak_${keyPrefix}_`)).toBe(true);
    expect(hashApiKey(key)).toBe(keyHash);
    expect(extractKeyPrefix(key)).toBe(keyPrefix);
    expect(looksLikeApiKey(key)).toBe(true);
  });

  it("generates distinct keys", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(a.keyHash).not.toBe(b.keyHash);
  });

  it("does not mistake a legacy shared secret for an API key", () => {
    expect(looksLikeApiKey("codeassess_shim_secret")).toBe(false);
    expect(looksLikeApiKey("")).toBe(false);
    expect(looksLikeApiKey(undefined)).toBe(false);
    expect(extractKeyPrefix("codeassess_shim_secret")).toBeNull();
  });
});

describe("apiClientAuth", () => {
  beforeEach(() => __resetLastUsedThrottle());

  it("accepts a valid key and attaches the client and its tenant", async () => {
    const { key, doc } = await makeClient();
    const res = await request(appWith({ scope: "codeassess", extractKey: fromHeader("x-rapidapi-key") }))
      .get("/probe")
      .set("x-rapidapi-key", key);

    expect(res.status).toBe(200);
    expect(res.body.clientId).toBe(String(doc._id));
    expect(res.body.collegeId).toBe(String(doc.collegeId));
    expect(res.body.legacy).toBe(false);
  });

  it("rejects a key whose scope does not cover the surface", async () => {
    // Scoped to codeassess only, but presented to an integration-scoped route.
    const { key } = await makeClient({ scopes: ["codeassess"] });
    const res = await request(appWith({ scope: "integration", extractKey: fromHeader("x-rapidapi-key") }))
      .get("/probe")
      .set("x-rapidapi-key", key);

    expect(res.status).toBe(401);
  });

  it("rejects a revoked (inactive) key", async () => {
    const { key } = await makeClient({ active: false });
    const res = await request(appWith({ scope: "codeassess", extractKey: fromHeader("x-rapidapi-key") }))
      .get("/probe")
      .set("x-rapidapi-key", key);

    expect(res.status).toBe(401);
  });

  it("rejects an unknown key", async () => {
    const { key } = generateApiKey(); // never persisted
    const res = await request(appWith({ scope: "codeassess", extractKey: fromHeader("x-rapidapi-key") }))
      .get("/probe")
      .set("x-rapidapi-key", key);

    expect(res.status).toBe(401);
  });

  it("rejects a missing key", async () => {
    const res = await request(appWith({ scope: "codeassess", extractKey: fromHeader("x-rapidapi-key") })).get("/probe");
    expect(res.status).toBe(401);
  });

  it("gives the same response for unknown, revoked and wrong-scope keys", async () => {
    // Distinguishing them would let a caller probing keys learn which exist.
    const unknown = generateApiKey().key;
    const revoked = (await makeClient({ active: false })).key;
    const wrongScope = (await makeClient({ scopes: ["arventiq"] })).key;
    const app = appWith({ scope: "codeassess", extractKey: fromHeader("x-rapidapi-key") });

    const bodies = [];
    for (const k of [unknown, revoked, wrongScope]) {
      const res = await request(app).get("/probe").set("x-rapidapi-key", k);
      expect(res.status).toBe(401);
      bodies.push(JSON.stringify(res.body));
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it("still accepts the legacy env secret, and flags it as unattributable", async () => {
    const res = await request(
      appWith({
        scope: "codeassess",
        extractKey: fromHeader("x-rapidapi-key"),
        legacySecret: "legacy_shared_secret",
        legacyLabel: "CODEASSESS_SHIM_KEY"
      })
    )
      .get("/probe")
      .set("x-rapidapi-key", "legacy_shared_secret");

    expect(res.status).toBe(200);
    expect(res.body.legacy).toBe(true);
    expect(res.body.clientId).toBeNull();
  });

  it("rejects a wrong legacy secret", async () => {
    const res = await request(
      appWith({ scope: "codeassess", extractKey: fromHeader("x-rapidapi-key"), legacySecret: "legacy_shared_secret" })
    )
      .get("/probe")
      .set("x-rapidapi-key", "not_the_secret");

    expect(res.status).toBe(401);
  });

  it("supports a bearer-style surface via extractKey", async () => {
    const { key, doc } = await makeClient({ scopes: ["arventiq"] });
    const app = appWith({
      scope: "arventiq",
      extractKey: (req) => {
        const h = req.headers["authorization"] || "";
        return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
      }
    });
    const res = await request(app).get("/probe").set("Authorization", `Bearer ${key}`);

    expect(res.status).toBe(200);
    expect(res.body.clientId).toBe(String(doc._id));
  });

  it("records lastUsedAt on first use", async () => {
    const { key, doc } = await makeClient();
    expect(doc.lastUsedAt).toBeUndefined();

    await request(appWith({ scope: "codeassess", extractKey: fromHeader("x-rapidapi-key") }))
      .get("/probe")
      .set("x-rapidapi-key", key);

    // The write is intentionally not awaited by the middleware, so give the
    // event loop a turn before reading it back.
    await new Promise((r) => setTimeout(r, 50));
    const reloaded = await ApiClient.findById(doc._id);
    expect(reloaded.lastUsedAt).toBeInstanceOf(Date);
  });
});
