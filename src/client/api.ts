export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Thin wrapper around `fetch` that sends/receives JSON and throws on non-2xx.
 * Extracted verbatim from `main.ts`; behavior is unchanged.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    },
    ...init
  });
  const body = await response.json();
  if (!response.ok) {
    const message = body && typeof body === "object" && typeof body.error === "string"
      ? body.error
      : `Request failed with ${response.status}`;
    throw new ApiError(message, response.status, body);
  }
  return body as T;
}
