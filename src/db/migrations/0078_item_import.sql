-- The item import (P4 slice 1c) writes one audit entry per file.
INSERT INTO "audit_actions" ("action") VALUES
  ('stock_items.imported');
