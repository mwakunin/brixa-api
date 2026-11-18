import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { keepDevMail } from "./email";

/** A development API keeps each email it would have sent as a file (lib/email.ts). */
describe("keeping a development email", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dev-mail-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const mail = { to: "someone@example.test", subject: "Reset your Brixa HMIS password", body: "Open this link: http://localhost:3000/reset-password?token=abc" };
  const sameInstant = new Date("2026-11-18T10:00:00.000Z");

  it("writes the message to a file of its own, making the folder, with the address inside the file and not in its name", async () => {
    const file = await keepDevMail(path.join(root, "not-there-yet"), mail, sameInstant);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...mail, at: "2026-11-18T10:00:00.000Z" });
    expect(path.basename(file)).not.toContain("someone");
  });

  it("names files so the newest sorts last, and messages of the same instant in the order they were written", async () => {
    await keepDevMail(root, { ...mail, body: "later" }, new Date("2026-11-18T10:00:05.000Z"));
    await keepDevMail(root, { ...mail, body: "earlier" }, new Date("2026-11-18T10:00:01.000Z"));
    // Twenty in one instant: a random suffix would put them in order by chance about once in 2.4 × 10^18.
    const inOneInstant = Array.from({ length: 20 }, (_, n) => `message ${n}`);
    for (const body of inOneInstant)
      await keepDevMail(root, { ...mail, body }, sameInstant);

    const bodies = await Promise.all((await readdir(root)).sort().map(async name => JSON.parse(await readFile(path.join(root, name), "utf8")).body));
    expect(bodies).toEqual([...inOneInstant, "earlier", "later"]);
  });

  it("never replaces a message, and leaves no half-written file behind", async () => {
    await Promise.all(Array.from({ length: 5 }, (_, n) => keepDevMail(root, { ...mail, body: `message ${n}` }, sameInstant)));

    const names = await readdir(root);
    expect(names).toHaveLength(5);
    expect(names.every(name => name.endsWith(".json"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("keeps the folder and its files to their owner, since the links in them work", async () => {
    const dir = path.join(root, "mail");
    const file = await keepDevMail(dir, mail, sameInstant);

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
