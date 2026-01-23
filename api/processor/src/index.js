import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ProcessorSyncService } from './sync.js';

const app = new Hono();

// STEP 1: CORS Middleware
app.use('/*', cors({
  origin: '*', 
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-Access-Key'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: true,
}));

// STEP 2: Access Key Middleware
app.use('/*', async (c, next) => {
  // Skip check for OPTIONS requests
  if (c.req.method === 'OPTIONS') {
    return next();
  }
  
  // Public endpoints
  const publicPaths = ['/', '/health'];
  if (publicPaths.includes(c.req.path)) {
    return next();
  }
  
  const accessKey = c.req.header('X-Access-Key');
  
  if (!accessKey) {
    return c.json({ error: 'Access key required' }, 401);
  }
  
  // CRITICAL FIX: Read ACCESS_KEY from D1 instead of environment variables
  const storedKey = await c.env.DB.prepare("SELECT value FROM app_config WHERE key = 'ACCESS_KEY'").first();
  
  if (!storedKey || !storedKey.value || storedKey.value !== accessKey) {
    console.error('[Processor Auth] Invalid access key provided');
    return c.json({ error: 'Invalid access key' }, 401);
  }
  
  console.log('[Processor Auth] Access key validated successfully');
  await next();
});

// STEP 3: Dependency Injection
app.use('/*', async (c, next) => {
  const syncService = new ProcessorSyncService(c.env);
  c.set('syncService', syncService);
  
  await next();
});

// Health check
app.get('/', (c) => {
  return c.json({ 
    message: 'Telegram Media Processor - Phase B', 
    status: 'running',
    worker: 'processor'
  });
});

app.get('/health', (c) => {
  return c.json({ status: 'healthy' });
});

// Phase B: Media processing only
app.post('/process-media', async (c) => {
  const syncService = c.get('syncService');
  
  try {
    // Step 1: Fetch pending task with retry logic
    const pendingMessage = await c.env.DB.prepare(`
      SELECT * FROM messages 
      WHERE media_status = 'pending' 
      OR media_status = 'failed'
      ORDER BY 
        CASE WHEN media_status = 'pending' THEN 1 ELSE 2 END,
        id DESC
      LIMIT 1
    `).first();

    if (!pendingMessage) {
      return c.json({ success: true, remaining: 0, message: 'No pending media to process' });
    }

    console.log(`[Processor] Processing media for message ${pendingMessage.telegram_message_id}, type: ${pendingMessage.media_type}, status: ${pendingMessage.media_status}`);

    // Step 2: Process the media
    const result = await syncService.processMediaMessage(pendingMessage);

    // CRITICAL FIX: Update DB status for skipped items to prevent infinite loops
    if (result.skipped) {
      console.log(`[Processor] Updating DB status for skipped message ${pendingMessage.telegram_message_id}: ${result.reason}`);
      
      let skipStatus;
      if (result.reason && result.reason.includes('Non-photo media type')) {
        skipStatus = 'skipped_type'; // Non-photo media
      } else if (result.reason && result.reason.includes('exceeds 20MB limit')) {
        skipStatus = 'skipped_large'; // Too large photos
      } else {
        skipStatus = 'skipped'; // Generic skip
      }
      
      await c.env.DB.prepare(`
        UPDATE messages SET media_status = ? WHERE id = ?
      `).bind(skipStatus, pendingMessage.id).run();
    }

    // Step 3: Count remaining pending tasks
    const remainingCount = await c.env.DB.prepare(`
      SELECT COUNT(*) as count FROM messages 
      WHERE media_status = 'pending' OR media_status = 'failed'
    `).first();

    return c.json({
      success: true,
      processedId: pendingMessage.id,
      messageId: pendingMessage.telegram_message_id,
      mediaType: pendingMessage.media_type,
      remaining: remainingCount.count,
      skipped: result.skipped || false,
      skipReason: result.reason || null,
      result: result
    });

  } catch (error) {
    console.error('[Processor] Process media error:', error);
    return c.json({ 
      success: false, 
      error: error.message 
    }, 500);
  }
});

// Debug routes
app.get('/debug/credentials', async (c) => {
  try {
    const syncService = c.get('syncService');
    const credentials = await syncService.authService.getCredentials();
    
    // Return safe info only (no actual secrets)
    return c.json({ 
      success: true, 
      hasSession: !!credentials.session,
      apiId: credentials.apiId,
      hasApiHash: !!credentials.apiHash,
      hasR2Url: !!credentials.r2PublicUrl
    });
  } catch (error) {
    console.error('[Processor] Debug credentials error:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default {
  fetch: app.fetch,
};
