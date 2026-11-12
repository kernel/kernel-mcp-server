// Next.js runs register() once per server instance before it serves
// requests. A throw here keeps the instance from serving anything, so invalid
// native OAuth settings stop a deployment instead of failing per request.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { nativeOAuthConfig } = await import("@/lib/native-oauth");
  const config = nativeOAuthConfig();
  console.info(
    config
      ? `native OAuth enabled: issuer ${config.issuer}, resource ${config.audience}`
      : "native OAuth disabled",
  );
}
