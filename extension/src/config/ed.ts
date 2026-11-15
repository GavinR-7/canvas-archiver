/**
 * Ed Discussion hosts. The web app lives on edstem.org; its JSON API on the
 * regional host (`us.edstem.org` for US schools). Both are listed because
 * which one Cornell's session uses has to be confirmed on a real account.
 */
export const ED_ORIGINS = ["https://edstem.org", "https://us.edstem.org"] as const;
export const ED_API_ORIGIN = "https://us.edstem.org";
export const edHostPermissions: string[] = ED_ORIGINS.map((o) => `${o}/*`);
