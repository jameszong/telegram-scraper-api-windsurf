-- Migration: Add error_message column to messages table
-- Purpose: Store detailed error messages when media processing fails
-- Date: 2026-01-28

-- Add error_message column to store failure reasons
ALTER TABLE messages ADD COLUMN error_message TEXT;

-- Create index for faster queries on failed messages
CREATE INDEX IF NOT EXISTS idx_messages_error_status ON messages(media_status) WHERE media_status = 'failed';
