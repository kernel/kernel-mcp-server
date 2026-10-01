import { defineOAuthClientConformance } from "./oauth-client-conformance";

defineOAuthClientConformance({
  name: "Vercel Connect",
  clientName: "Vercel Connect",
  redirectUri:
    process.env.VERCEL_CONNECT_REDIRECT_URI ??
    "https://connect.vercel.test/oauth/callback",
  tokenEndpointAuthMethod: "none",
  grantTypes: ["authorization_code", "refresh_token"],
  responseTypes: ["code"],
  scope: "openid",
  codeChallengeMethod: "S256",
});
