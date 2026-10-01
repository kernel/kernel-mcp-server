export function buildSelectOrgRedirectUrl(
  searchParams: Pick<URLSearchParams, "toString">,
): string {
  const query = searchParams.toString();
  return query ? `/select-org?${query}` : "/select-org";
}
