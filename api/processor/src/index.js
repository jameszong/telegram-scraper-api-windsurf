import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ProcessorSyncService } from './sync.js';

const app = new Hono();

// STEP 1: CORS Middleware
app.use('/*', cors({
  origin: '*', 
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-Access-Key', 'X-Internal-Key'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: false,
}));

// STEP 2: Internal Service Auth Middleware
app.use('/*', async (c, next) => {
  // Skip check for OPTIONS requests
  if (c.req.method === 'OPTIONS') {
    return next();
  }
  
  // CRITICAL: Log all incoming requests for debugging
  console.log(`[Processor Auth] ${c.req.method} ${c.req.path} - Headers:`, {
    'X-Internal-Key': c.req.header('X-Internal-Key') ? 'PRESENT' : 'MISSING',
    'X-Access-Key': c.req.header('X-Access-Key') ? 'PRESENT' : 'MISSING',
    'Content-Type': c.req.header('Content-Type'),
    'User-Agent': c.req.header('User-Agent')
  });
  
  // Public endpoints
  const publicPaths = ['/', '/health'];
  if (publicPaths.includes(c.req.path)) {
    return next();
  }
  
  const internalKey = c.req.header('X-Internal-Key');
  const accessKey = c.req.header('X-Access-Key');
  
  // Allow either internal key (for microservice communication) or access key (for frontend)
  if (!internalKey && !accessKey) {
    console.error('[Processor Auth] No authentication provided - both keys missing');
    return c.json({ error: 'Authentication required' }, 401);
  }
  
  // Check internal key first (for microservice communication)
  if (internalKey) {
    const expectedKeyRaw = c.env.INTERNAL_SERVICE_KEY;
    const expectedKey = (expectedKeyRaw || '').trim();
    const receivedKey = (internalKey || '').trim();

    // Enhanced debug to diagnose whitespace / desync issues
    console.log('[Processor Auth] DEBUG - Comparing internal keys:', {
      receivedLength: internalKey?.length,
      expectedLength: expectedKeyRaw?.length,
      receivedTrimmedLength: receivedKey.length,
      expectedTrimmedLength: expectedKey.length,
      match: receivedKey === expectedKey,
      receivedFirst10: internalKey?.substring(0, 10),
      expectedFirst10: expectedKeyRaw?.substring(0, 10),
      receivedLast10: internalKey?.slice(-10),
      expectedLast10: expectedKeyRaw?.slice(-10)
    });

    if (!expectedKey) {
      console.error('[Processor Auth] INTERNAL_SERVICE_KEY not configured in environment');
      return c.json({ error: 'Service configuration error' }, 500);
    }

    if (receivedKey !== expectedKey) {
      console.error('[Processor Auth] Invalid internal key provided');
      return c.json({ error: 'Invalid internal key' }, 401);
    }

    console.log('[Processor Auth] Internal key validated successfully');
    await next();
    return;
  }
  
  // Check access key (for frontend communication)
  if (accessKey) {
    // First try environment variable (from GitHub Actions secrets)
    const envAccessKey = c.env.ACCESS_KEY;
    if (envAccessKey && envAccessKey === accessKey) {
      console.log('[Processor Auth] Access key validated from environment');
    } else {
      // Fallback to D1 database
      const storedKey = await c.env.DB.prepare("SELECT value FROM app_config WHERE key = 'ACCESS_KEY'").first();
      if (!storedKey || !storedKey.value || storedKey.value !== accessKey) {
        console.error('[Processor Auth] Invalid access key provided');
        return c.json({ error: 'Invalid access key' }, 401);
      }
      console.log('[Processor Auth] Access key validated from D1');
    }
  }
  
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
    // CRITICAL: Validate credentials exist before processing
    console.log('[Processor] Validating credentials...');
    try {
      await syncService.authService.getCredentials();
    } catch (credentialError) {
      console.error('[Processor] Credential validation failed:', credentialError.message);
      if (credentialError.message.includes('credentials not found')) {
        return c.json({ 
          success: false, 
          error: 'Telegram credentials not found in D1 app_config table. Please ensure Scanner has synced credentials first.' 
        }, 401);
      }
      throw credentialError;
    }
    
    // Check for batch processing parameter
    const batchMode = c.req.query('batch') === 'true';
    const requestedBatchSize = parseInt(c.req.query('size') || '10');
    const batchSize = Number.isFinite(requestedBatchSize)
      ? Math.max(1, Math.min(requestedBatchSize, 10))
      : 10;
    
    // Get chatId parameter for targeted processing
    const chatId = c.req.query('chatId');
    
    if (batchMode) {
      return await processBatchMedia(c, syncService, batchSize, chatId);
    }
    
    // Original single-item processing logic
    return await processSingleMedia(c, syncService, chatId);
    
  } catch (error) {
    console.error('[Processor] Process media error:', error);
    return c.json({ 
      success: false, 
      error: error.message 
    }, 500);
  }
});

// Single media processing (original logic)
async function processSingleMedia(c, syncService, chatId) {
  // Step 1: Fetch pending task with retry logic, optionally scoped to chatId
  let query = `
    SELECT id, telegram_message_id, chat_id, text, date, media_status, media_type, media_key, grouped_id
    FROM messages 
    WHERE (media_status = 'pending' OR media_status = 'failed')
  `;
  const params = [];
  
  if (chatId) {
    query += ` AND chat_id = ?`;
    params.push(String(chatId));
  }
  
  query += `
    ORDER BY 
      CASE WHEN media_status = 'pending' THEN 1 ELSE 2 END,
      id DESC
    LIMIT 1
  `;
  
  const pendingMessage = await c.env.DB.prepare(query).bind(...params).first();

  if (!pendingMessage) {
    return c.json({ success: true, remaining: 0, message: 'No pending media to process' });
  }

  console.log(`[Processor] Processing media for message ${pendingMessage.telegram_message_id}, type: ${pendingMessage.media_type}, status: ${pendingMessage.media_status}`);
  console.log(`[Processor] Pending message details:`, {
    id: pendingMessage.id,
    telegram_message_id: pendingMessage.telegram_message_id,
    chat_id: pendingMessage.chat_id,
    media_status: pendingMessage.media_status,
    media_key: pendingMessage.media_key,
    telegram_message_id_type: typeof pendingMessage.telegram_message_id,
    chat_id_type: typeof pendingMessage.chat_id
  });

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
    `).bind(skipStatus, String(pendingMessage.id)).run();
  }

  // Step 3: Count remaining pending tasks
  const remainingCount = await c.env.DB.prepare(`
    SELECT COUNT(*) as count FROM messages 
    WHERE media_status = 'pending' OR media_status = 'failed'
  `).first();

  // CRITICAL: Return mediaKey for frontend instant display
  let mediaKey = null;
  if (result.success && result.mediaKey) {
    mediaKey = result.mediaKey;
  }

  return c.json({
    success: true,
    processedId: Number(pendingMessage.id),
    messageId: pendingMessage.telegram_message_id,
    mediaKey: mediaKey, // Add mediaKey for frontend display
    mediaType: pendingMessage.media_type,
    remaining: remainingCount.count,
    skipped: result.skipped || false,
    skipReason: result.reason || null,
    result: result
  });
}

// Batch media processing (new logic)
async function processBatchMedia(c, syncService, batchSize, chatId) {
  console.log(`[Processor] Starting batch processing with size: ${batchSize}, chatId: ${chatId || 'all'}`);
  
  const results = [];
  let processedCount = 0;
  let skippedCount = 0;
  
  // Process multiple items in sequence (due to GramJS session lock)
  for (let i = 0; i < batchSize; i++) {
    // Fetch next pending item, optionally scoped to chatId
    let query = `
      SELECT id, telegram_message_id, chat_id, text, date, media_status, media_type, media_key, grouped_id
      FROM messages 
      WHERE (media_status = 'pending' OR media_status = 'failed')
    `;
    const params = [];
    
    if (chatId) {
      query += ` AND chat_id = ?`;
      params.push(String(chatId));
    }
    
    query += `
      ORDER BY 
        CASE WHEN media_status = 'pending' THEN 1 ELSE 2 END,
        id DESC
      LIMIT 1
    `;
    
    const pendingMessage = await c.env.DB.prepare(query).bind(...params).first();

    if (!pendingMessage) {
      console.log(`[Processor Batch] No more pending items after ${i} iterations`);
      break;
    }

    console.log(`[Processor Batch] Processing item ${i + 1}/${batchSize}: ${pendingMessage.telegram_message_id}`);
    
    try {
      // Process the media
      const result = await syncService.processMediaMessage(pendingMessage);
      
      // Handle skipped items
      if (result.skipped) {
        console.log(`[Processor Batch] Skipping message ${pendingMessage.telegram_message_id}: ${result.reason}`);
        
        let skipStatus;
        if (result.reason && result.reason.includes('Non-photo media type')) {
          skipStatus = 'skipped_type';
        } else if (result.reason && result.reason.includes('exceeds 20MB limit')) {
          skipStatus = 'skipped_large';
        } else {
          skipStatus = 'skipped';
        }
        
        await c.env.DB.prepare(`
          UPDATE messages SET media_status = ? WHERE id = ?
        `).bind(skipStatus, String(pendingMessage.id)).run();
        
        skippedCount++;
        results.push({
          success: true,
          skipped: true,
          skipReason: result.reason,
          messageId: pendingMessage.telegram_message_id
        });
      } else if (result.success) {
        processedCount++;
        results.push({
          success: true,
          processedId: Number(pendingMessage.id),
          messageId: pendingMessage.telegram_message_id,
          mediaKey: result.mediaKey,
          mediaType: pendingMessage.media_type
        });
      } else {
        results.push({
          success: false,
          error: result.error || 'Unknown processing error',
          messageId: pendingMessage.telegram_message_id
        });
      }
    } catch (error) {
      console.error(`[Processor Batch] Error processing item ${pendingMessage.telegram_message_id}:`, error);
      
      // Check for FloodWaitError
      if (error.message && error.message.includes('FloodWaitError')) {
        const waitSeconds = error.message.match(/(\d+)s/) ? parseInt(error.message.match(/(\d+)s/)[1]) : 60;
        console.error(`[Processor Batch] FloodWaitError detected, need to wait ${waitSeconds} seconds`);
        results.push({
          success: false,
          floodWait: waitSeconds,
          error: `FloodWaitError: Need to wait ${waitSeconds} seconds`,
          messageId: pendingMessage.telegram_message_id
        });
      } else {
        results.push({
          success: false,
          error: error.message,
          messageId: pendingMessage.telegram_message_id
        });
      }
    }
  }
  
  // Count remaining pending tasks, optionally scoped to chatId
  let remainingQuery = `
    SELECT COUNT(*) as count FROM messages 
    WHERE (media_status = 'pending' OR media_status = 'failed')
  `;
  const remainingParams = [];
  
  if (chatId) {
    remainingQuery += ` AND chat_id = ?`;
    remainingParams.push(String(chatId));
  }
  
  const remainingCount = await c.env.DB.prepare(remainingQuery).bind(...remainingParams).first();

  console.log(`[Processor Batch] Completed: ${processedCount} processed, ${skippedCount} skipped, ${remainingCount.count} remaining`);
  
  return c.json({
    success: true,
    batchMode: true,
    batchSize: batchSize,
    processedCount: processedCount,
    skippedCount: skippedCount,
    remaining: remainingCount.count,
    hasMore: remainingCount.count > 0,
    results: results
  });
}

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
