-- VERITY database schema

-- Caller persistent memory
CREATE TABLE IF NOT EXISTS caller_memory (
  caller_id       TEXT PRIMARY KEY,
  claim_count     INT DEFAULT 0,
  domains_monitored JSONB DEFAULT '[]',
  topics          JSONB DEFAULT '[]',
  context         JSONB DEFAULT '{}',
  total_paid_usdc DECIMAL(10,4) DEFAULT 0,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE caller_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access" ON caller_memory
  USING (true) WITH CHECK (true);

-- Verification log
CREATE TABLE IF NOT EXISTS verification_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id       TEXT,
  claim           TEXT NOT NULL,
  verdict         TEXT NOT NULL CHECK (verdict IN ('CURRENT','OUTDATED','DISPUTED','UNVERIFIABLE')),
  confidence      INT CHECK (confidence BETWEEN 0 AND 100),
  sources_found   INT DEFAULT 0,
  url_checked     BOOLEAN DEFAULT FALSE,
  response_tokens INT,
  payment_usdc    DECIMAL(10,4) DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE verification_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access" ON verification_log
  USING (true) WITH CHECK (true);

-- Async task queue
CREATE TABLE IF NOT EXISTS tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id    TEXT,
  query        TEXT,
  status       TEXT DEFAULT 'working' CHECK (status IN ('working','completed','failed')),
  result       JSONB,
  error        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access" ON tasks
  USING (true) WITH CHECK (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_verification_log_caller ON verification_log(caller_id);
CREATE INDEX IF NOT EXISTS idx_verification_log_verdict ON verification_log(verdict);
CREATE INDEX IF NOT EXISTS idx_verification_log_created ON verification_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
