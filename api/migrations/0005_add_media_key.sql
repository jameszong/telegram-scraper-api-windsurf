-- Add media_key column to store R2 file references
ALTER TABLE messages ADD COLUMN media_key TEXT;

-- Create index for media_key to improve query performance
CREATE INDEX IF NOT EXISTS idx_messages_media_key ON messages(media_key);
