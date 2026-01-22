-- Clean up old test data to prepare for fresh sync with grouped_id support
-- This will remove all existing messages and media to ensure clean data

-- Delete all media records first (foreign key constraint)
DELETE FROM media;

-- Delete all message records
DELETE FROM messages;

-- Reset auto-increment IDs (optional, for clean start)
DELETE FROM sqlite_sequence WHERE name = 'messages';
DELETE FROM sqlite_sequence WHERE name = 'media';

-- Verify cleanup
SELECT 'Messages table count:' as info, COUNT(*) as count FROM messages
UNION ALL
SELECT 'Media table count:' as info, COUNT(*) as count FROM media;
