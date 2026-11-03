import College from "../../models/College.mjs";
import { HttpError } from "../utils/httpError.js";
import * as authService from "./auth.service.js";

function slugify(name) {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "college";
}

async function uniqueSlug(base) {
  let slug = base;
  let suffix = 1;
  while (await College.findOne({ slug })) {
    suffix += 1;
    slug = `${base}-${suffix}`;
  }
  return slug;
}

// Self-serve signup: creates a brand-new College tenant plus its first user, who is
// always the college's admin — role and collegeId are never client-supplied (that was
// the privilege-escalation shape the old, deleted RegisterPage.jsx had). Reuses
// authService.register rather than duplicating password-hashing/user-creation logic;
// rolls back the College if user creation fails (e.g. duplicate email), mirroring the
// rollback-on-partial-failure idiom already used in authService.bulkRegister.
export async function signup({ collegeName, name, email, password }) {
  if (!collegeName || typeof collegeName !== "string" || !collegeName.trim()) {
    throw new HttpError(400, "College name is required", { message: "College name is required" });
  }
  if (!name || !email || !password) {
    throw new HttpError(400, "Name, email, and password are required", {
      message: "Name, email, and password are required"
    });
  }

  const slug = await uniqueSlug(slugify(collegeName));
  const college = await College.create({ name: collegeName.trim(), slug });

  try {
    return await authService.register({
      name,
      email,
      password,
      role: "admin",
      collegeId: college._id.toString()
    });
  } catch (err) {
    await College.findByIdAndDelete(college._id);
    throw err;
  }
}

// Superadmin-created tenant with no first user: for operator-run colleges (an internal
// "Load test" college to own a load-test API key, a client onboarded by hand). Its admins
// are added afterwards through the normal user management.
export async function createCollege({ name } = {}) {
  if (!name || typeof name !== "string" || !name.trim()) {
    throw new HttpError(400, "College name is required", { message: "College name is required" });
  }
  const slug = await uniqueSlug(slugify(name));
  const college = await College.create({ name: name.trim(), slug });
  return { _id: college._id, name: college.name, slug: college.slug, planId: college.planId };
}
