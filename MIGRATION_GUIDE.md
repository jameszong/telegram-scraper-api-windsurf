# Database Migration Guide - Reset Stuck Media

## Problem
Legacy data may have inconsistent states:
- Messages with `media_key` but status stuck on 'pending'/'processing'
- Messages marked 'completed' but missing `media_key`

## Solution: Migration 0005

### Option 1: Automatic Migration (Recommended)
The migration will run automatically on next deployment via `deploy_all.sh`:

```bash
./deploy_all.sh
```

### Option 2: Manual SQL Execution
If you need to run the cleanup immediately without deployment:

```bash
# Apply migration manually
npx wrangler d1 execute tg-archive-db --remote --file=./api/migrations/0005_reset_stuck_media.sql
```

### Option 3: Wrangler Console
Run in Cloudflare Dashboard D1 Console:

```sql
-- Fix messages with media_key but wrong status
UPDATE messages 
SET media_status = 'completed'
WHERE media_key IS NOT NULL 
  AND media_key != '' 
  AND media_status != 'completed';

-- Reset stuck messages without media_key
UPDATE messages 
SET media_status = 'pending', media_key = NULL 
WHERE (media_status = 'processing' OR media_status = 'failed')
  AND (media_key IS NULL OR media_key = '');
```

## Verification
After running the migration, check the results:

```sql
SELECT 
  media_status,
  COUNT(*) as count,
  SUM(CASE WHEN media_key IS NOT NULL AND media_key != '' THEN 1 ELSE 0 END) as with_key,
  SUM(CASE WHEN media_key IS NULL OR media_key = '' THEN 1 ELSE 0 END) as without_key
FROM messages
GROUP BY media_status;
```

Expected output:
- `completed` status should have `with_key > 0`
- `pending` status should have `without_key > 0`
- No `processing` or `failed` status with missing keys

## Frontend Changes
The frontend now uses **robust filtering**:
- **Old**: Trust `media_status === 'completed'`
- **New**: Trust `media_key` existence (more reliable)

This means even if some messages have stuck status, they will still display correctly if `media_key` exists.

## Re-processing
After cleanup, stuck messages will be re-processed:
1. Messages with `media_key` → Marked as `completed` (fixed)
2. Messages without `media_key` → Reset to `pending` (will be re-downloaded)
