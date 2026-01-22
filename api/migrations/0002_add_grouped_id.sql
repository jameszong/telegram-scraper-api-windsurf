-- Add grouped_id field for album grouping support
ALTER TABLE messages ADD COLUMN grouped_id TEXT;

-- Create index for grouped_id to improve grouping performance
CREATE INDEX IF NOT EXISTS idx_messages_grouped_id ON messages(grouped_id);
