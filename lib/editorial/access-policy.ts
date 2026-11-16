/** Environment isolation for synthetic previews, NOT operator authentication. Fail closed. */
export function canAccessEditorialFixtures(nodeEnv: string | undefined, host: string | null): boolean {
  return nodeEnv === "development" && host !== null &&
    /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(host);
}
