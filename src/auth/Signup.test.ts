import { describe, expect, it } from "vitest";
import { isSignupHash, signupPending } from "./Signup";

describe("signup page routing", () => {
  it("#/signup (with or without a query) is the signup page; anything else is sign-in", () => {
    for (const h of ["#/signup", "#signup", "#/signup?ref=ad"]) expect(isSignupHash(h)).toBe(true);
    for (const h of ["", "#/", "#/setup", "#/signups", "#/dashboard"]) expect(isSignupHash(h)).toBe(false);
  });

  it("no signup is in flight by default", () => {
    expect(signupPending()).toBe(false);
  });
});
