// Cloudflare Access JWT verification. There is exactly one verification path and no bypass:
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
  const email = typeof env.ALLOWED_EMAIL === "string" ? env.ALLOWED_EMAIL.trim().toLowerCase() : "";
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(team) || !aud || !email) return null;
  return { team, aud, email };
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
    });
    if (typeof payload.email !== "string") return { ok: false, reason: "no_email_claim" };
    if (payload.email.trim().toLowerCase() !== cfg.email) return { ok: false, reason: "email_mismatch" };
    return { ok: true, email: cfg.email };
  } catch (e) {
    return { ok: false, reason: `jwt_${e && e.code ? String(e.code).slice(0, 40) : "invalid"}` };
  }
}
