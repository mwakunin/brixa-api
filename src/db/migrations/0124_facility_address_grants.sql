-- The facility's address, printed at the head of every document it issues
-- (the staff walkthrough, decided 2026-11-20): the facility admin sets it, as
-- they set the phone, through the runtime role. Each change is audited as
-- `facility.updated`, which exists.

GRANT UPDATE ("address") ON "facilities" TO hospital_app;
