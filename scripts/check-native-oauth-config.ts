// Runs the server's native OAuth startup check during Vercel builds, so a
// misconfigured environment fails its deployment and the previous one keeps
// serving. Local builds skip it; the dev server runs the same check at startup.
import { nativeOAuthConfig } from "@/lib/native-oauth";

if (!process.env.VERCEL) process.exit(0);

try {
  const config = nativeOAuthConfig();
  console.info(
    config
      ? `native OAuth configuration ok: issuer ${config.issuer}, resource ${config.audience}`
      : "native OAuth disabled for this deployment",
  );
} catch (error) {
  console.error(
    `native OAuth configuration is invalid: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
