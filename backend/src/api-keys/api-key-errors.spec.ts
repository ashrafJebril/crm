import { API_KEY_ERROR_KEYS, apiKeyError, apiKeyErrorStatus } from "./api-key-errors";

describe("api key errors", () => {
  it("every key carries its status and itself as the message", () => {
    expect(API_KEY_ERROR_KEYS).toEqual(
      expect.arrayContaining([
        "api_keys.scope_not_allowed",
        "api_keys.invalid_expiry",
        "api_keys.invalid",
        "api_keys.route_not_allowed",
        "api_keys.scope_above_role",
        "api_keys.not_found",
        "api_keys.limit_reached",
        "api_keys.rate_limited",
      ]),
    );
    for (const key of API_KEY_ERROR_KEYS) {
      const e = apiKeyError(key, { x: 1 });
      expect({ key, status: e.getStatus(), body: e.getResponse() }).toEqual({
        key,
        status: apiKeyErrorStatus(key),
        body: { statusCode: apiKeyErrorStatus(key), message: key, x: 1 },
      });
    }
    expect(apiKeyErrorStatus("api_keys.invalid")).toBe(401);
    expect(apiKeyErrorStatus("api_keys.rate_limited")).toBe(429);
  });
});
