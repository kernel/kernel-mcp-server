import { z } from "zod";
import {
  proxySelectorError,
  proxySelectorSchema,
} from "@/lib/mcp/proxy-config";

export function privateHostsSchema() {
  return z
    .array(z.string().min(1))
    .describe(
      "destinations the browser reaches directly through the session's own network instead of KERNEL-managed egress, such as private hosts on a vpn or tailnet the session joined. entries are hostname patterns or private ip and cidr literals. an explicit list replaces the default private ranges (rfc1918, cgnat, and ipv6 ula); an empty list disables them; omit to keep the defaults.",
    );
}

export function proxyRoutesSchema() {
  return z
    .array(
      z.object({
        hosts: z.array(z.string().min(1)).min(1).max(50),
        proxy: proxySelectorSchema(),
      }),
    )
    .max(10)
    .describe(
      'route requests for 1–50 host patterns per route through a proxy selected by exactly one of proxy.id or proxy.name (max 10 routes). use exact hostnames or leading "*." wildcards, which match subdomains only, not the apex. matching ignores case and ports; the most specific match wins. matched hosts override the top-level proxy; unmatched hosts use the top-level proxy or the browser default. start_url uses the top-level proxy, not routes. if a route proxy is unavailable, matched requests fail closed.',
    );
}

export function allowedHostsSchema() {
  return z.array(z.string().min(1)).min(1).max(100);
}

export function allowedHostsDescription(subject: string, lifecycle: string) {
  return `egress allowlist: the only destinations ${subject} can reach through KERNEL-managed egress. omit for unfiltered egress. unlisted destinations are refused, including fetch() and websockets: navigations get a 403 page whose "X-Kernel-Proxy-Error" header is "network_policy_denied", while page scripts may only see a network error. entries are exact hostnames, a leading "*." wildcard that matches subdomains at any depth but not the apex, public ip addresses (ipv6 in brackets), or public cidr ranges, without ports, paths, or schemes. ip and cidr entries only match urls written with an ip. entries cannot overlap private_hosts, and start_url must be allowed. ${lifecycle} if a request with an allowlist fails, don't drop the allowlist to retry unless the user agrees.`;
}

type ProxyRoute = z.infer<ReturnType<typeof proxyRoutesSchema>>[number];

export function proxyRoutesError(routes: ProxyRoute[] | undefined) {
  return routes
    ?.map((route, i) =>
      proxySelectorError(`network.proxy_routes[${i}].proxy`, route.proxy),
    )
    .find(Boolean);
}
