-- Migration: Create app_config table for sharing configuration between microservices
-- This table allows workers to share Telegram credentials and other configuration

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert initial configuration keys (values will be synced by Worker A)
INSERT OR IGNORE INTO app_config (key) VALUES 
  ('TELEGRAM_SESSION'),
  ('TELEGRAM_API_ID'),
  ('TELEGRAM_API_HASH'),
  ('R2_PUBLIC_URL');

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_app_config_key ON app_config(key);
