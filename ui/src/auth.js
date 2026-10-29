// Cloudflare Access JWT verification. There is exactly one verification path and no escape hatch:
// every request, including static files, is verified. Missing configuration fails closed.
import { createRemoteJWKSet, jwtVerify } from "jose";

// Created once per isolate and TEAM_DOMAIN, at module scope, so jose's key cache and its
// refetch-on-unknown-kid cooldown apply (the docs example builds it inside fetch, which
// would pay a JWKS round trip on every request).
const jwksByTeam = new Map();

function jwksFor(teamDomain) {
  let jwks = jwksByTeam.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeam.set(teamDomain, jwks);
  }
  return jwks;
}

export const CLOCK_TOLERANCE_S = 30;

/** Returns the normalised auth config, or null when anything is missing or malformed. */
export function authConfig(env) {
  const team = typeof env.TEAM_DOMAIN === "string" ? env.TEAM_DOMAIN.trim().replace(/\/+$/, "") : "";
  const aud = typeof env.POLICY_AUD === "string" ? env.POLICY_AUD.trim() : "";
  // ALLOWED_EMAILS: comma-separated, any number, trimmed, compared case-insensitively.
  const emails =
    typeof env.ALLOWED_EMAILS === "string"
      ? env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@"))
      : [];
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(team) || !aud || emails.length === 0) return null;
  return { team, aud, emails: new Set(emails) };
}

/** Short, non-reversible-in-practice tag of an email for the shared lock record (never the address). */
export async function emailTag(email) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  return [...new Uint8Array(d)].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @returns {Promise<{ok: true, email: string} | {ok: false, reason: string}>}
 * The reason is for the log only; callers answer 403 with an empty body.
 */
export async function verifyAccess(request, cfg) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, reason: "no_token" };
  try {
    const { payload } = await jwtVerify(token, jwksFor(cfg.team), {
      algorithms: ["RS256"],
      issuer: cfg.team,
      audience: cfg.aud,
      clockTolerance: CLOCK_TOLERANCE_S,
      requiredClaims: ["exp"], // a token that never expires is refused
    });
    if (typeof payload.email !== "string") return { ok: false, reason: "no_email_claim" };
    const email = payload.email.trim().toLowerCase();
    if (!cfg.emails.has(email)) return { ok: false, reason: "email_not_allowed" };
    return { ok: true, email };
  } catch (e) {
    return { ok: false, reason: `jwt_${e && e.code ? String(e.code).slice(0, 40) : "invalid"}` };
  }
}
