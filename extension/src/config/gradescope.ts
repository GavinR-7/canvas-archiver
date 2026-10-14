/**
 * Gradescope hosts. Same idea as `canvas.ts`: one array feeds both the
 * manifest's `host_permissions` and the runtime URL guard.
 *
 * Gradescope has no public student API, so the extension reads the same HTML
 * pages the signed-in user sees. Cornell signs in through Gradescope's own
 * `/login` on this host (school credentials), so unlike Canvas there is no
 * second login host to leave out.
 */
export const GRADESCOPE_ORIGINS = ["https://www.gradescope.com"] as const;

export const GRADESCOPE_ORIGIN: string = GRADESCOPE_ORIGINS[0];

export const gradescopeHostPermissions: string[] = GRADESCOPE_ORIGINS.map((o) => `${o}/*`);
