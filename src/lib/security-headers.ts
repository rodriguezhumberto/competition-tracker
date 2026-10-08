export function withSecurityHeaders(response: Response): Response {
  // Restrict framing and navigation without blocking Alpine's expression evaluator
  // or existing inline scripts/styles. A full script CSP needs a separate migration.
  response.headers.set(
    'Content-Security-Policy',
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  );
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}
