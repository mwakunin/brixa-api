import { describe, expect, it } from "vitest";

import { InsecureDatabaseUrlError, isLocalDatabase, sslConfigFor } from "./connection";

/**
 * This logic was duplicated once and the copy kept an older, broken version
 * that disabled TLS on a substring match. These cases exist so a third copy,
 * or a regression in this one, fails loudly.
 */
describe("isLocalDatabase", () => {
  it.each([
    "postgresql://hospital:hospital@localhost:5438/hospital_dev",
    "postgresql://u:p@127.0.0.1:5432/db",
    "postgresql://u:p@[::1]:5432/db",
  ])("treats %s as local", (url) => {
    expect(isLocalDatabase(url)).toBe(true);
  });

  it.each([
    ["a remote host", "postgresql://u:p@db.example.com/db?sslmode=require"],
    ["a password containing localhost", "postgresql://localhost:pw@prod.example.com/db"],
    ["localhost in a query parameter", "postgresql://u:p@prod.example.com/db?opts=localhost"],
    ["a hostname merely starting with localhost", "postgresql://u:p@localhost.evil.com/db"],
    ["127.0.0.1 inside the database name", "postgresql://u:p@prod.example.com/db127.0.0.1"],
  ])("does NOT treat %s as local", (_label, url) => {
    expect(isLocalDatabase(url)).toBe(false);
  });

  it("fails closed on an unparseable DSN", () => {
    // Better to attempt TLS against a malformed URL than to downgrade.
    expect(isLocalDatabase("not a url at all")).toBe(false);
    expect(isLocalDatabase("")).toBe(false);
  });
});

describe("sslConfigFor", () => {
  it("disables TLS only for a genuinely local database", () => {
    expect(sslConfigFor("postgresql://u:p@localhost:5432/db")).toBe(false);
  });

  it("requires a verified certificate for anything remote", () => {
    expect(sslConfigFor("postgresql://u:p@db.example.com/db"))
      .toEqual({ rejectUnauthorized: true });
  });

  it("requires TLS when the password contains localhost", () => {
    // The exact downgrade the substring version allowed.
    expect(sslConfigFor("postgresql://localhost:pw@prod.example.com/db"))
      .toEqual({ rejectUnauthorized: true });
  });

  // pg lets these replace the strict setting, so they must not get that far.
  it.each([
    ["sslmode=disable", "turn TLS off"],
    ["ssl=0", "turn TLS off"],
    ["uselibpqcompat=true&sslmode=disable", "turn TLS off"],
    ["sslmode=no-verify", "turn off certificate verification"],
    ["ssl=no-verify", "turn off certificate verification"],
    ["uselibpqcompat=true&sslmode=require", "turn off certificate verification"],
    ["uselibpqcompat=true&sslmode=prefer", "turn off certificate verification"],
  ])("refuses a remote DSN with %s", (params, weakening) => {
    expect(() => sslConfigFor(`postgresql://u:secret-pw@db.example.com/db?${params}`))
      .toThrow(new InsecureDatabaseUrlError(weakening));
  });

  it("keeps the password out of the refusal", () => {
    expect(() => sslConfigFor("postgresql://u:secret-pw@db.example.com/db?sslmode=disable"))
      .toThrow(expect.objectContaining({ message: expect.not.stringContaining("secret-pw") }));
  });

  it.each(["sslmode=verify-full", "ssl=true", "uselibpqcompat=true&sslmode=verify-full"])(
    "accepts a remote DSN with %s, which still verifies the certificate",
    (params) => {
      expect(sslConfigFor(`postgresql://u:p@db.example.com/db?${params}`))
        .toEqual({ rejectUnauthorized: true });
    },
  );

  it("leaves a local DSN's parameters alone", () => {
    expect(sslConfigFor("postgresql://u:p@localhost:5432/db?sslmode=disable")).toBe(false);
  });
});
