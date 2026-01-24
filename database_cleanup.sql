-- Database cleanup script (preserves login credentials)
-- This script removes all messages and media data but keeps authentication data

-- Delete all messages (this will cascade delete media records if foreign keys exist)
DELETE FROM messages;

-- Reset any sequences or counters if they exist
-- Note: SQLite doesn't have sequences, but if you're using a different DB, you might need:
-- DELETE FROM sqlite_sequence WHERE name = 'messages';

-- Keep authentication data in these tables:
-- - kv_store (contains TELEGRAM_SESSION, ACCESS_KEY, target_channel_id, R2_PUBLIC_URL)
-- - app_config (contains configuration)
-- - channels (channel information)

-- Log the cleanup
-- Note: This is for debugging, remove in production
SELECT 'Database cleaned - messages removed, auth data preserved' as status;
