// Runs the server's native OAuth startup check during Vercel builds, so a
// misconfigured environment fails its deployment and the previous one keeps
// serving. Local builds skip it; the dev server runs the same check at startup.
export {};

if (process.env.VERCEL) {
  const { describeNativeOAuthConfig } = await import("@/lib/native-oauth");
  console.info(describeNativeOAuthConfig());
}
