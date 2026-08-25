/**
 * custom_functions.js — User-defined placeholder functions for stress_test.js
 *
 * Mount this file over the built-in one to add or replace functions:
 *   -v $(pwd)/custom_functions.js:/app/custom_functions.js
 *
 * Template usage:  "$myFunction(arg1, arg2)"
 *
 * Each function receives:
 *   args : string[]  — arguments from the template (env refs already resolved)
 *   env  : object    — K6 __ENV (all -e variables passed on the CLI)
 *
 * Functions MUST return a JSON-serialisable value: string, number, boolean or null.
 */
import http from 'k6/http';

const tokenCache = {}; // module-level state — persists across iterations within one VU

export const customFunctions = {
  /**
   * $customFunction()
   * Default implementation — returns current Unix timestamp as a string.
   * Replace with your own logic as needed.
   */
  customFunction: (_args, _env) => {
    return String(Date.now());
  },

  /**
   * $paddedNumber(value, width)
   * Pads a value with leading zeros.
   * Example: $paddedNumber(42, 6) → "000042"
   */
  paddedNumber: (args, _env) => {
    const value = args[0] !== null && args[0] !== undefined ? args[0] : '0';
    const width = parseInt(args[1], 10) || 6;
    return String(value).padStart(width, '0');
  },

  /**
   * $randomChoice(option1, option2, ...)
   * Picks one of the provided options at random.
   * Example: $randomChoice(A,B,C) → "B"
   */
  randomChoice: (args, _env) => {
    if (!args.length) return null;
    return args[Math.floor(Math.random() * args.length)];
  },

  /**
   * $jwtAuth(loginUrl, username, password)
   * Logs in once per VU (form-urlencoded username/password) and caches the
   * resulting bearer token until ~5s before it expires, reusing it on
   * subsequent iterations instead of re-authenticating every request.
   * Expects a JSON login response shaped as { access_token, expires_at }.
   * Example: "Authorization": "$jwtAuth(#loginUrl, #jwtUsername, #jwtPassword)"
   */
  jwtAuth: (args, _env) => {
    const [loginUrl, username, password] = args;
    if (!loginUrl || !username || !password) {
      throw new Error('$jwtAuth(loginUrl, username, password): all three arguments are required');
    }
    const cacheKey = `${loginUrl}|${username}`;
    const cached = tokenCache[cacheKey];
    if (cached && cached.expiresAt > Date.now() + 5000) {
      return `Bearer ${cached.token}`;
    }
    const res = http.post(loginUrl, { username, password }, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      tags: { name: 'login' },
    });
    if (res.status !== 200) {
      throw new Error(`$jwtAuth: login failed (${res.status}): ${res.body}`);
    }
    const body = res.json();
    tokenCache[cacheKey] = { token: body.access_token, expiresAt: new Date(body.expires_at).getTime() };
    return `Bearer ${body.access_token}`;
  },
};
