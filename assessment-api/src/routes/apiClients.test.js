import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";

import app from "../app.js";
import * as authService from "../services/auth.service.js";
import User from "../../models/User.mjs";
import College from "../../models/College.mjs";
import ApiClient from "../../models/ApiClient.mjs";

describe("Admin API client management", () => {
  let collegeA, collegeB;
  let adminAToken, adminBToken, facultyToken, superadminToken;

  beforeEach(async () => {
    await User.deleteMany({});
    await College.deleteMany({});
    await ApiClient.deleteMany({});

    collegeA = await College.create({ name: "College A", slug: "college-a" });
    collegeB = await College.create({ name: "College B", slug: "college-b" });

    // register() takes collegeId directly, so the token it returns already carries
    // the claim the endpoints scope by - no second login needed.
    adminAToken = (await authService.register({
      name: "Admin A", email: "admin-a@test.com", password: "password123",
      role: "admin", collegeId: collegeA._id
    })).token;

    adminBToken = (await authService.register({
      name: "Admin B", email: "admin-b@test.com", password: "password123",
      role: "admin", collegeId: collegeB._id
    })).token;

    facultyToken = (await authService.register({
      name: "Faculty", email: "faculty@test.com", password: "password123",
      role: "faculty", collegeId: collegeA._id
    })).token;

    const superadmin = await authService.register({
      name: "Super", email: "super@test.com", password: "password123", role: "superadmin"
    });
    superadminToken = superadmin.token;
  });

  const create = (token, body) =>
    request(app).post("/api/admin/api-clients").set("Authorization", `Bearer ${token}`).send(body);

  it("issues a key once and never exposes the hash", async () => {
    const res = await create(adminAToken, { name: "Partner X", scopes: ["codeassess"] });

    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^ak_[0-9a-f]{8}_/);
    expect(res.body.client.keyPrefix).toHaveLength(8);
    expect(res.body.client.keyHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("keyHash");

    // The key is not recoverable afterwards: listing never returns it again.
    const list = await request(app).get("/api/admin/api-clients").set("Authorization", `Bearer ${adminAToken}`);
    expect(list.body[0].key).toBeUndefined();
  });

  it("attributes the key to the caller's own college and ignores a body-supplied collegeId", async () => {
    // The injection bug already fixed twice in this codebase (bulk-import-students,
    // questions): a non-superadmin must not be able to name another tenant.
    const res = await create(adminAToken, {
      name: "Sneaky", scopes: ["codeassess"], collegeId: String(collegeB._id)
    });

    expect(res.status).toBe(201);
    expect(String(res.body.client.collegeId)).toBe(String(collegeA._id));
    expect(String(res.body.client.collegeId)).not.toBe(String(collegeB._id));
  });

  it("provisions a service user so submissions have an owner", async () => {
    const res = await create(adminAToken, { name: "Partner X", scopes: ["arventiq"] });
    const client = await ApiClient.findById(res.body.client._id);

    expect(client.serviceUserId).toBeTruthy();
    const svc = await User.findById(client.serviceUserId);
    expect(svc).toBeTruthy();
    expect(String(svc.collegeId)).toBe(String(collegeA._id));
  });

  it("rejects an unknown scope and an empty scope list", async () => {
    expect((await create(adminAToken, { name: "X", scopes: ["root"] })).status).toBe(400);
    expect((await create(adminAToken, { name: "X", scopes: [] })).status).toBe(400);
    expect((await create(adminAToken, { scopes: ["codeassess"] })).status).toBe(400);
  });

  it("lists only the caller's own college's keys", async () => {
    await create(adminAToken, { name: "A key", scopes: ["codeassess"] });
    await create(adminBToken, { name: "B key", scopes: ["codeassess"] });

    const listA = await request(app).get("/api/admin/api-clients").set("Authorization", `Bearer ${adminAToken}`);
    expect(listA.status).toBe(200);
    expect(listA.body).toHaveLength(1);
    expect(listA.body[0].name).toBe("A key");
  });

  it("returns 404, not 403, when revoking another college's key", async () => {
    // 403 would confirm the id exists, which is itself a cross-tenant leak.
    const created = await create(adminBToken, { name: "B key", scopes: ["codeassess"] });
    const res = await request(app)
      .delete(`/api/admin/api-clients/${created.body.client._id}`)
      .set("Authorization", `Bearer ${adminAToken}`);

    expect(res.status).toBe(404);
    const still = await ApiClient.findById(created.body.client._id);
    expect(still.active).toBe(true);
  });

  it("revokes by deactivating, so historical usage stays attributable", async () => {
    const created = await create(adminAToken, { name: "A key", scopes: ["codeassess"] });
    const res = await request(app)
      .delete(`/api/admin/api-clients/${created.body.client._id}`)
      .set("Authorization", `Bearer ${adminAToken}`);

    expect(res.status).toBe(200);
    const doc = await ApiClient.findById(created.body.client._id);
    expect(doc).toBeTruthy(); // not deleted
    expect(doc.active).toBe(false);
    expect(doc.revokedAt).toBeInstanceOf(Date);
  });

  it("stops authenticating a revoked key on the live shim surface", async () => {
    const created = await create(adminAToken, { name: "A key", scopes: ["codeassess"] });
    const key = created.body.key;

    // Works before revocation: a 401 would mean the key was rejected. Any other
    // status means it authenticated and the request reached the handler.
    const before = await request(app).post("/api/codeAssess/submissions").set("x-rapidapi-key", key).send({});
    expect(before.status).not.toBe(401);

    await request(app)
      .delete(`/api/admin/api-clients/${created.body.client._id}`)
      .set("Authorization", `Bearer ${adminAToken}`);

    const after = await request(app).post("/api/codeAssess/submissions").set("x-rapidapi-key", key).send({});
    expect(after.status).toBe(401);
    expect(after.body).toEqual({ error: "Unauthorized" }); // Judge0-shaped body preserved
  });

  it("refuses a key scoped to a different surface", async () => {
    const created = await create(adminAToken, { name: "Integration only", scopes: ["integration"] });
    const res = await request(app)
      .post("/api/codeAssess/submissions")
      .set("x-rapidapi-key", created.body.key)
      .send({});

    expect(res.status).toBe(401);
  });

  it("denies faculty, who have no reason to mint machine credentials", async () => {
    expect((await create(facultyToken, { name: "X", scopes: ["codeassess"] })).status).toBe(403);
    expect(
      (await request(app).get("/api/admin/api-clients").set("Authorization", `Bearer ${facultyToken}`)).status
    ).toBe(403);
  });

  it("requires a superadmin to name the college explicitly", async () => {
    const missing = await create(superadminToken, { name: "X", scopes: ["codeassess"] });
    expect(missing.status).toBe(400);

    const ok = await create(superadminToken, {
      name: "X", scopes: ["codeassess"], collegeId: String(collegeB._id)
    });
    expect(ok.status).toBe(201);
    expect(String(ok.body.client.collegeId)).toBe(String(collegeB._id));
  });

  it("404s on a malformed client id rather than throwing", async () => {
    const res = await request(app)
      .delete(`/api/admin/api-clients/not-an-object-id`)
      .set("Authorization", `Bearer ${adminAToken}`);
    expect(res.status).toBe(404);
    expect(mongoose.Types.ObjectId.isValid("not-an-object-id")).toBe(false);
  });
});
