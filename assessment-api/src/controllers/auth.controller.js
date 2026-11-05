import * as authService from "../services/auth.service.js";
import * as collegeService from "../services/college.service.js";
import { AUTH_COOKIE_NAME, getAuthCookieOptions, getAuthCookieSetOptions } from "../utils/authCookie.js";

export async function signup(req, res, next) {
  const { collegeName, name, email, password } = req.body || {};
  try {
    const result = await collegeService.signup({ collegeName, name, email, password });
    res.cookie(AUTH_COOKIE_NAME, result.token, getAuthCookieSetOptions());
    return res.status(201).json(result);
  } catch (err) {
    if (err.status && err.body) {
      return res.status(err.status).json(err.body);
    }
    next(err);
  }
}

export async function register(req, res, next) {
  // Note: unlike login/signup, this route is superadmin-only (auth.routes.js) and creates
  // an account for *someone else* - it must not set an auth cookie on the calling
  // superadmin's own browser, which would silently swap their session to the new user.
  const { name, email, password, role, collegeId } = req.body || {};
  try {
    const result = await authService.register({ name, email, password, role, collegeId });
    return res.status(201).json(result);
  } catch (err) {
    if (err.status && err.body) {
      return res.status(err.status).json(err.body);
    }
    next(err);
  }
}

export async function login(req, res, next) {
  const { email, password } = req.body || {};
  const auditInfo = {
    ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    userAgent: req.headers['user-agent']
  };

  try {
    const result = await authService.login({ email, password }, auditInfo);
    res.cookie(AUTH_COOKIE_NAME, result.token, getAuthCookieSetOptions());
    return res.json(result);
  } catch (err) {
    if (err.status && err.body) {
      return res.status(err.status).json(err.body);
    }
    next(err);
  }
}

export async function me(req, res, next) {
  try {
    return res.json({ user: await authService.getMe(req.user.id) });
  } catch (err) {
    if (err.status && err.body) {
      return res.status(err.status).json(err.body);
    }
    next(err);
  }
}

export function logout(req, res) {
  res.clearCookie(AUTH_COOKIE_NAME, getAuthCookieOptions());
  res.json({ message: "Logged out" });
}
