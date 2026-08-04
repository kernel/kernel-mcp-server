export type ManagedAuthFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ManagedAuthFetchState = {
  hostedFallbackAvailable: boolean;
  exchangedJwt: string | null;
  retrieveInitializationFailed: boolean;
};

function retryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function createManagedAuthFetch(
  fetchImpl: ManagedAuthFetch,
  delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
  baseUrl: () => string = () => window.location.href,
) {
  const state: ManagedAuthFetchState = {
    hostedFallbackAvailable: true,
    exchangedJwt: null,
    retrieveInitializationFailed: false,
  };

  const managedAuthFetch: ManagedAuthFetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const pathname = new URL(url, baseUrl()).pathname;
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const isExchange =
      method === "POST" &&
      /\/auth\/connections\/[^/]+\/exchange$/.test(pathname);
    const isRetrieve =
      method === "GET" && /\/auth\/connections\/[^/]+$/.test(pathname);

    if (isExchange && state.exchangedJwt) {
      return new Response(JSON.stringify({ jwt: state.exchangedJwt }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const attempts = isRetrieve ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetchImpl(input, init);
        if (isExchange && !retryable(response.status)) {
          state.hostedFallbackAvailable = false;
          if (response.ok) {
            const data = (await response.clone().json()) as { jwt?: unknown };
            if (typeof data.jwt === "string") state.exchangedJwt = data.jwt;
          }
        }
        if (isRetrieve) {
          if (response.ok) state.retrieveInitializationFailed = false;
          else if (retryable(response.status) && attempt + 1 < attempts) {
            await delay(250 * (attempt + 1));
            continue;
          } else {
            state.retrieveInitializationFailed = retryable(response.status);
          }
        }
        return response;
      } catch (error) {
        if (isRetrieve && attempt + 1 < attempts) {
          await delay(250 * (attempt + 1));
          continue;
        }
        if (isRetrieve) state.retrieveInitializationFailed = true;
        throw error;
      }
    }
    throw new Error("Managed-auth request retry exhausted");
  };

  return { fetch: managedAuthFetch, state };
}
