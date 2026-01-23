#!/bin/bash

# Script to clear all objects from R2 bucket
echo "Clearing R2 bucket: tg-archive-bucket"

# List all objects and delete them
echo "Listing objects in bucket..."
npx wrangler r2 object list tg-archive-bucket --remote --json

# Delete all objects (this will need to be done by listing first, then deleting)
echo "To delete all objects, we need to list them first and then delete individually"
echo "Alternatively, you can use the Cloudflare Dashboard to empty the bucket"

# For now, let's try to delete any media files we know might exist
echo "Attempting to delete any media files with common patterns..."

# Try to delete some common media file patterns
npx wrangler r2 object delete tg-archive-bucket/media/ --remote 2>/dev/null || echo "No media/ folder found"

echo "R2 bucket clear attempt completed"
echo "Note: For complete bucket clearing, use Cloudflare Dashboard R2 interface"
