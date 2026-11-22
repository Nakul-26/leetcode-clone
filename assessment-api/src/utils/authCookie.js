// Shared between auth.controller.js (set on login/register/signup) and the logout route
// (clearCookie needs matching attributes to actually clear it) - see H8 in
// docs/plans/PLATFORM_AUDIT_AND_SAAS_ROADMAP.md.
export const AUTH_COOKIE_NAME = "token";

export function getAuthCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/"
  };
}

export function getAuthCookieSetOptions() {
  return {
    ...getAuthCookieOptions(),
    maxAge: 7 * 24 * 60 * 60 * 1000 // matches jwt.sign's expiresIn: "7d"
  };
}
