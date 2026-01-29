-- Reset stuck messages to allow re-processing with new logic
-- This migration fixes legacy data where media_key exists but status is stuck

-- Reset messages that have media_key but wrong status
UPDATE messages 
SET media_status = 'completed'
WHERE media_key IS NOT NULL 
  AND media_key != '' 
  AND media_status != 'completed';

-- Reset messages that are stuck in pending/processing but have no media_key
UPDATE messages 
SET media_status = 'pending', media_key = NULL 
WHERE (media_status = 'processing' OR media_status = 'failed')
  AND (media_key IS NULL OR media_key = '');

-- Log the cleanup results
SELECT 
  media_status,
  COUNT(*) as count,
  SUM(CASE WHEN media_key IS NOT NULL AND media_key != '' THEN 1 ELSE 0 END) as with_key,
  SUM(CASE WHEN media_key IS NULL OR media_key = '' THEN 1 ELSE 0 END) as without_key
FROM messages
GROUP BY media_status;
