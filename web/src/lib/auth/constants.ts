/**
 * Edge-safe constants shared by middleware and server-only modules.
 * Keep this file free of `node:*` imports so it can be evaluated by
 * the Edge runtime that runs `src/middleware.ts`.
 */

export const SESSION_COOKIE_NAME = "mc_session";
