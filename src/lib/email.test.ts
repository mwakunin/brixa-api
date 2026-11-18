import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { keepDevMail } from "./email";

/** A development API keeps each email it would have sent as a file (lib/email.ts). */
describe("keeping a development email", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir)
      await rm(dir, { recursive: true, force: true });
  });

  it("writes the message to a file of its own, with the address inside it and not in its name", async () => {
    dir = path.join(await mkdtemp(path.join(tmpdir(), "dev-mail-")), "not-there-yet");
    const mail = { to: "someone@example.test", subject: "Reset your Brixa HMIS password", body: "Open this link: http://localhost:3000/reset-password?token=abc" };

    const file = await keepDevMail(dir, mail, new Date("2026-11-18T10:00:00.000Z"));

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...mail, at: "2026-11-18T10:00:00.000Z" });
    expect(path.basename(file)).not.toContain("someone");
  });

  it("names files so the newest sorts last", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dev-mail-"));
    const mail = { to: "someone@example.test", subject: "s", body: "b" };

    await keepDevMail(dir, { ...mail, body: "later" }, new Date("2026-11-18T10:00:05.000Z"));
    await keepDevMail(dir, { ...mail, body: "earlier" }, new Date("2026-11-18T10:00:01.000Z"));

    const names = (await readdir(dir)).sort();
    expect(JSON.parse(await readFile(path.join(dir, names.at(-1)!), "utf8")).body).toBe("later");
  });
});
