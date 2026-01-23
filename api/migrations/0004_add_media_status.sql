-- Add media processing status columns for async media processing
ALTER TABLE messages ADD COLUMN media_status TEXT DEFAULT 'none';
ALTER TABLE messages ADD COLUMN media_type TEXT;

-- Create index for media_status to improve query performance for pending media
CREATE INDEX IF NOT EXISTS idx_messages_media_status ON messages(media_status);

-- Create index for media_type to improve filtering by media type
CREATE INDEX IF NOT EXISTS idx_messages_media_type ON messages(media_type);
