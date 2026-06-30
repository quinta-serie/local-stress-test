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
};
