CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'authorized', 'partially_captured', 'captured')
  ),
  authorization_id TEXT,
  captured_minor BIGINT NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payments_capture_within_amount CHECK (captured_minor <= amount_minor)
);
