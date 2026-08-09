import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  headers: async () => {
    return [
      {
        source: "/oauth-consent",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'",
          },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
  redirects: async () => {
    return [
      {
        source: "/",
        destination: "https://onkernel.com/docs/reference/mcp-server",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
