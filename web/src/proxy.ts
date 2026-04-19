import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE_NAME } from "@/lib/auth/constants";

/**
 * Lightweight gate that redirects unauthenticated visitors to /login.
 *
 * We only check for the *presence* of the session cookie here (Edge
 * runtime can't easily read the on-disk dummy key for a constant-time
 * compare). The API routes still perform the full check via
 * `isSessionAuthenticated()`, so a forged cookie cannot reach
 * authenticated endpoints.
 */
export function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE_NAME)?.value);

  if (pathname === "/login") {
    if (hasSession) {
      const url = req.nextUrl.clone();
      url.pathname = "/";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Run on every page request EXCEPT API routes, Next internals, and
  // static assets. The /login page is matched but handled above.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
