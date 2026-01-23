import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono();

// STEP 1: CORS Middleware
app.use('/*', cors({
  origin: '*', 
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-Access-Key', 'X-Internal-Key'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: true,
}));

// STEP 2: Internal Service Auth Middleware
app.use('/*', async (c, next) => {
  // Skip check for OPTIONS requests
  if (c.req.method === 'OPTIONS') {
    return next();
  }
  
  // Public endpoints
  const publicPaths = ['/', '/health', '/media/*'];
  if (publicPaths.some(path => {
    if (path === '/media/*') {
      return c.req.path.startsWith('/media/');
    }
    return c.req.path === path;
  })) {
    return next();
  }
  
  const internalKey = c.req.header('X-Internal-Key');
  const accessKey = c.req.header('X-Access-Key');
  
  // Allow either internal key (for microservice communication) or access key (for frontend)
  if (!internalKey && !accessKey) {
    return c.json({ error: 'Authentication required' }, 401);
  }
  
  // Check internal key first (for microservice communication)
  if (internalKey) {
    const INTERNAL_SERVICE_KEY = c.env.INTERNAL_SERVICE_KEY;
    if (!INTERNAL_SERVICE_KEY) {
      console.error('[Viewer Auth] INTERNAL_SERVICE_KEY not configured');
      return c.json({ error: 'Service configuration error' }, 500);
    }
    if (internalKey !== INTERNAL_SERVICE_KEY) {
      console.error('[Viewer Auth] Invalid internal key provided');
      return c.json({ error: 'Invalid internal key' }, 401);
    }
    console.log('[Viewer Auth] Internal key validated successfully');
    await next();
    return;
  }
  
  // Check access key (for frontend communication)
  if (accessKey) {
    // First try environment variable (from GitHub Actions secrets)
    const envAccessKey = c.env.ACCESS_KEY;
    if (envAccessKey && envAccessKey === accessKey) {
      console.log('[Viewer Auth] Access key validated from environment');
    } else {
      // Fallback to D1 database
      const storedKey = await c.env.DB.prepare("SELECT value FROM app_config WHERE key = 'ACCESS_KEY'").first();
      if (!storedKey || !storedKey.value || storedKey.value !== accessKey) {
        console.error('[Viewer Auth] Invalid access key provided');
        return c.json({ error: 'Invalid access key' }, 401);
      }
      console.log('[Viewer Auth] Access key validated from D1');
    }
  }
  
  await next();
});

// Health check
app.get('/', (c) => {
  return c.json({ 
    message: 'Telegram Viewer API - Read-only endpoints', 
    status: 'running',
    worker: 'viewer'
  });
});

app.get('/health', (c) => {
  return c.json({ status: 'healthy' });
});

// Channels endpoint (Read-only)
app.get('/channels', async (c) => {
  try {
    console.log('[Viewer] Fetching channels from D1 (no Telegram connection)');
    
    // Get target channel from D1
    const targetChannelResult = await c.env.DB.prepare(
      'SELECT value FROM kv_store WHERE key = ?'
    ).bind('target_channel_id').first();

    const targetChannelId = targetChannelResult ? targetChannelResult.value : null;
    
    // For now, return a simple response with the selected channel
    // In a full implementation, you might cache channel info in D1
    const channels = targetChannelId ? [{
      id: targetChannelId,
      title: `Channel ${targetChannelId}`,
      selected: true
    }] : [];

    return c.json({
      success: true,
      channels,
      selectedChannel: targetChannelId
    });
  } catch (error) {
    console.error('[Viewer] Error getting channels:', error);
    return c.json({
      success: false,
      error: error.message,
      channels: []
    });
  }
});

// Messages endpoint (Read-only with pagination)
app.get('/messages', async (c) => {
  const channelId = c.req.query('channelId');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  
  // CRITICAL: Validate channelId to prevent data leakage
  if (!channelId) {
    console.log('[Viewer] Missing channelId parameter - returning empty array');
    return c.json({ success: false, error: 'channelId is required' }, 400);
  }
  
  console.log(`[Viewer] Fetching messages for channel ${channelId}, limit: ${limit}, offset: ${offset}`);
  
  try {
    // CRITICAL FIX: Count total messages for pagination
    const totalResult = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM messages WHERE chat_id = ?
    `).bind(channelId).first();
    const total = totalResult?.count || 0;
    
    console.log(`[Viewer] Total messages for channel ${channelId}: ${total}`);
    
    // Fetch messages with media info
    const messages = await c.env.DB.prepare(`
      SELECT m.id, m.telegram_message_id, m.chat_id, m.text, m.date, m.created_at, m.grouped_id,
             m.media_status, m.media_type, m.media_key
      FROM messages m
      WHERE m.chat_id = ?
      ORDER BY m.date DESC
      LIMIT ? OFFSET ?
    `).bind(channelId, limit, offset).all();

    // Add R2 public URLs to messages with media
    const r2PublicUrl = await c.env.DB.prepare(
      'SELECT value FROM app_config WHERE key = ?'
    ).bind('R2_PUBLIC_URL').first();
    
    const r2Url = r2PublicUrl?.value || '';
    
    if (r2Url && messages.results && messages.results.length > 0) {
      messages.results = messages.results.map(message => {
        if (message.media_key) {
          return {
            ...message,
            media_url: `${r2Url}/${message.media_key}`
          };
        }
        // Explicitly set media_url to null for consistency
        return {
          ...message,
          media_url: null
        };
      });
    } else if (messages.results && messages.results.length > 0) {
      // Ensure media_url field exists even if R2_PUBLIC_URL is not set
      messages.results = messages.results.map(message => ({
        ...message,
        media_url: message.media_key ? null : null
      }));
    }
    
    // Debug: Log fetched data structure
    console.log(`[Viewer] Fetched ${messages.results?.length || 0} messages from DB for channel ${channelId}`);
    
    // CRITICAL FIX: Return pagination data
    const page = Math.floor(offset / limit) + 1;
    return c.json({
      success: true,
      messages: messages.results || [],
      pagination: {
        total,
        page,
        limit,
        hasMore: offset + limit < total
      }
    });
  } catch (error) {
    console.error('[Viewer] Error fetching messages:', error);
    return c.json({ 
      success: false, 
      error: error.message,
      messages: []
    }, 500);
  }
});

// Media routes - Serve from R2 (Read-only)
app.get('/media/*', async (c) => {
  // Extract key: remove the leading '/media/' route prefix
  const key = c.req.path.replace(/^\/media\//, '');
  
  if (!key) {
    return c.json({ error: 'Media key is required' }, 400);
  }
  
  try {
    console.log(`[Viewer] Serving media from R2: ${key}`);
    
    const object = await c.env.BUCKET.get(key);
    
    if (!object) {
      return c.json({ error: 'Media not found' }, 404);
    }
    
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    
    return new Response(object.body, {
      headers,
      status: 200
    });
  } catch (error) {
    console.error('[Viewer] Error serving media:', error);
    return c.json({ error: 'Failed to serve media' }, 500);
  }
});

// Debug routes
app.get('/debug/stats', async (c) => {
  try {
    const messageStats = await c.env.DB.prepare(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN media_status = 'completed' THEN 1 END) as completed_media,
        COUNT(CASE WHEN media_status = 'pending' THEN 1 END) as pending_media,
        COUNT(CASE WHEN media_status = 'failed' THEN 1 END) as failed_media,
        COUNT(CASE WHEN media_status = 'skipped_type' THEN 1 END) as skipped_type,
        COUNT(CASE WHEN media_status = 'skipped_large' THEN 1 END) as skipped_large
      FROM messages
    `).first();

    const channelStats = await c.env.DB.prepare(`
      SELECT chat_id, COUNT(*) as message_count
      FROM messages
      GROUP BY chat_id
      ORDER BY message_count DESC
    `).all();

    return c.json({
      success: true,
      stats: {
        messages: messageStats,
        channels: channelStats.results || []
      }
    });
  } catch (error) {
    console.error('[Viewer] Debug stats error:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default {
  fetch: app.fetch,
};
