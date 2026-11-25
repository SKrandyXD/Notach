/** Local defaults come from the shared service configuration. */
export function resolveApiBaseUrl(
  value: string | undefined,
  defaultOrigin: string,
): string {
  const configured = value?.trim();
  const url = new URL(configured || defaultOrigin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Invalid VITE_API_BASE_URL.");
  return url.toString().replace(/\/$/, "");
}
