// Next.js runs register() once per server instance before it serves
// requests. A throw here keeps the instance from serving anything, so invalid
// native OAuth settings stop a deployment instead of failing per request.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { describeNativeOAuthConfig } = await import("@/lib/native-oauth");
  console.info(describeNativeOAuthConfig());
}
