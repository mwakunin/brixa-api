import { beforeEach, describe, expect, it, vi } from "vitest";

import db from "@/db";
import { makeFacility, resetDb } from "@/test/helpers";

import { createDrainTask, drainTask, INVOKER_AUDIENCE } from "./cloud-tasks";
import { enqueue } from "./outbox";
import { nudgingAfterCommit } from "./outbox-nudge";

const QUEUE = "projects/hms-test/locations/africa-south1/queues/outbox";
const INVOKER = "tasks-invoker@hms-test.iam.gserviceaccount.com";

describe("nudging the outbox after a commit", () => {
  beforeEach(async () => {
    await resetDb();
  });

  function queueOne(facilityId: string, then?: () => void) {
    return db.transaction(async (tx) => {
      await enqueue(tx, { facilityId, operation: "invitation.send", subjectId: facilityId });
      then?.();
    });
  }

  it("nudges each job the transaction queued, once it has committed", async () => {
    const facility = await makeFacility();
    const nudge = vi.fn();

    await nudgingAfterCommit(async () => {
      await queueOne(facility.id, () => expect(nudge).not.toHaveBeenCalled());
      await queueOne(facility.id);
    }, nudge);

    expect(nudge).toHaveBeenCalledTimes(1);
    expect(nudge.mock.calls[0][0]).toHaveLength(2);
  });

  it("nudges nothing when the transaction rolls back", async () => {
    const facility = await makeFacility();
    const nudge = vi.fn();

    await expect(nudgingAfterCommit(() => queueOne(facility.id, () => {
      throw new Error("the business change failed");
    }), nudge)).rejects.toThrow("the business change failed");

    expect(nudge).not.toHaveBeenCalled();
  });

  it("nudges nothing when nothing was queued", async () => {
    const nudge = vi.fn();

    await nudgingAfterCommit(async () => "no jobs", nudge);

    expect(nudge).not.toHaveBeenCalled();
  });
});

describe("a drain task", () => {
  it("calls the drain route with an identity token, under a name unique to the job", () => {
    const { url, data } = drainTask(QUEUE, "11111111-1111-4111-8111-111111111111", INVOKER);

    expect(url).toBe(`https://cloudtasks.googleapis.com/v2/${QUEUE}/tasks`);
    expect(data).toEqual({
      task: {
        name: `${QUEUE}/tasks/outbox-11111111-1111-4111-8111-111111111111`,
        httpRequest: {
          url: `${INVOKER_AUDIENCE}/internal/outbox/drain`,
          httpMethod: "POST",
          oidcToken: { serviceAccountEmail: INVOKER, audience: INVOKER_AUDIENCE },
        },
      },
    });
    // The job's id only: nothing about its subject (rule 10).
    expect(JSON.stringify(data)).not.toMatch(/body|payload/);
  });

  /** A request failing as gaxios reports it, with the status in either place it uses. */
  function failingWith(message: string, fields: Record<string, unknown>) {
    return {
      request: vi.fn(async () => {
        throw Object.assign(new Error(message), fields);
      }),
    };
  }

  it("treats a task already created for the job as done", async () => {
    const client = failingWith("exists", { status: 409 });

    await expect(createDrainTask("job", { queue: QUEUE, invokerEmail: INVOKER, client })).resolves.toBeUndefined();
  });

  it("passes on any other failure, for the sweep to cover", async () => {
    const client = failingWith("denied", { response: { status: 403 } });

    await expect(createDrainTask("job", { queue: QUEUE, invokerEmail: INVOKER, client })).rejects.toThrow("denied");
  });
});
