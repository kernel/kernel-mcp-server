import { z } from "zod";

export function proxyConfigSchema() {
  return z.object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    mode: z.enum(["direct", "default"]).optional(),
  });
}

export function proxySelectorSchema() {
  return z.object({
    id: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
  });
}

export type ProxyConfig = z.infer<ReturnType<typeof proxyConfigSchema>>;
type ProxySelector = z.infer<ReturnType<typeof proxySelectorSchema>>;

function selectedCount(value: ProxyConfig) {
  return Object.values(value).filter((v) => v !== undefined).length;
}

export function proxyConfigError(field: string, proxy: ProxyConfig) {
  return selectedCount(proxy) === 1
    ? undefined
    : `${field} requires exactly one of id, name, or mode.`;
}

export function proxySelectorError(field: string, proxy: ProxySelector) {
  return selectedCount(proxy) === 1
    ? undefined
    : `${field} requires exactly one of id or name.`;
}
