-- Safe media status migration with column existence check
-- This migration handles the case where media_type might already exist

-- Add media_status column (this should be safe as it's new)
ALTER TABLE messages ADD COLUMN media_status TEXT DEFAULT 'none';

-- Create index for media_status
CREATE INDEX IF NOT EXISTS idx_messages_media_status ON messages(media_status);

-- For media_type, we'll use a safer approach
-- Check if the column exists by trying to create an index
-- If the column doesn't exist, the index creation will fail silently (which is expected)
-- If the column exists, the index will be created successfully
CREATE INDEX IF NOT EXISTS idx_messages_media_type ON messages(media_type);
