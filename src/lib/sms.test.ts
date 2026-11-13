import { describe, expect, it } from "vitest";

import { parseCostCents, resultOf, SmsError } from "./sms";

/** Reading Africa's Talking's answer: what was taken, what was refused, and what cannot be read. */
describe("the answer from Africa's Talking", () => {
  const answer = (recipients: unknown[], message = "Sent to 1/1 Total Cost: KES 0.8000") =>
    ({ SMSMessageData: { Message: message, Recipients: recipients } });

  it("takes a message processed, sent or queued, with its id and cost", () => {
    expect(resultOf(answer([{ statusCode: 101, status: "Success", messageId: "ATXid_1", cost: "KES 0.8000", number: "+254712345678" }])))
      .toEqual({ accepted: true, providerMessageId: "ATXid_1", costCents: 80, reason: null });
    expect(resultOf(answer([{ statusCode: 102, status: "Queued", messageId: "ATXid_2", cost: "0" }])).accepted).toBe(true);
  });

  it("returns a refusal for the number as an answer, not an error", () => {
    expect(resultOf(answer([{ statusCode: 403, status: "InvalidPhoneNumber", messageId: "None", cost: "0" }])))
      .toMatchObject({ accepted: false, reason: "InvalidPhoneNumber" });
    expect(resultOf(answer([], "InvalidSenderId"))).toMatchObject({ accepted: false, reason: "InvalidSenderId" });
  });

  it("throws on an answer it cannot read, so the send is retried", () => {
    expect(() => resultOf({ SMSMessageData: { Recipients: [{ statusCode: "unexpected" }] } })).toThrow(SmsError);
    expect(() => resultOf({ unexpected: true })).toThrow(SmsError);
    expect(() => resultOf(null)).toThrow(SmsError);
  });

  it("reads a cost with its currency", () => {
    expect([parseCostCents("KES 0.8000"), parseCostCents("0"), parseCostCents(1.2), parseCostCents("none")]).toEqual([80, 0, 120, null]);
  });
});
