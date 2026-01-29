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

// ON-DEMAND: Download specific message media
app.post('/download-media', async (c) => {
  try {
    const syncService = c.get('syncService');
    const body = await c.req.json();
    const { messageId, chatId } = body;
    
    if (!messageId || !chatId) {
      return c.json({ 
        success: false, 
        error: 'messageId and chatId are required' 
      }, 400);
    }
    
    console.log(`[Processor] ON-DEMAND download request for message ${messageId} in chat ${chatId}`);
    
    // Fetch the specific message from DB
    const message = await c.env.DB.prepare(`
      SELECT id, telegram_message_id, chat_id, text, date, media_status, media_type, media_key, grouped_id
      FROM messages 
      WHERE telegram_message_id = ? AND chat_id = ?
      LIMIT 1
    `).bind(String(messageId), String(chatId)).first();
    
    if (!message) {
      return c.json({ 
        success: false, 
        error: 'Message not found' 
      }, 404);
    }
    
    // Check if already completed
    if (message.media_status === 'completed' && message.media_key) {
      console.log(`[Processor] Message ${messageId} already completed, returning existing key`);
      return c.json({
        success: true,
        alreadyCompleted: true,
        mediaKey: message.media_key,
        messageId: message.telegram_message_id
      });
    }
    
    // Process the media
    console.log(`[Processor] Processing media for message ${messageId}`);
    const result = await syncService.processMediaMessage(message);
    
    if (result.success) {
      return c.json({
        success: true,
        mediaKey: result.mediaKey,
        messageId: message.telegram_message_id,
        chatId: message.chat_id
      });
    } else {
      return c.json({
        success: false,
        error: result.error || 'Processing failed',
        skipped: result.skipped,
        skipReason: result.reason
      }, 500);
    }
  } catch (error) {
    console.error('[Processor] ON-DEMAND download error:', error);
    return c.json({ 
      success: false, 
      error: error.message 
    }, 500);
  }
});

// Phase B: Media processing only
app.post('/process-media', async (c) => {
  // 顺序处理标记，防止并发请求
  const processingKey = 'processing_' + (c.req.query('chatId') || 'all');
  
  // 检查是否有并发请求
  if (c.env.PROCESSING_LOCK && c.env.PROCESSING_LOCK[processingKey]) {
    console.log(`[Processor] Concurrent request detected for ${processingKey}, returning 429`);
    return c.json({
      success: false,
      error: 'Another request is already processing. Please wait.',
      concurrent: true
    }, 429);
  }
  
  // 设置处理锁
  if (!c.env.PROCESSING_LOCK) c.env.PROCESSING_LOCK = {};
  c.env.PROCESSING_LOCK[processingKey] = true;
  
  // 全局错误处理
  try {
    const syncService = c.get('syncService');
    
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
    
    // Check for FloodWaitError and return 429 with Retry-After header
    if (error.message && error.message.includes('FloodWaitError')) {
      const waitSeconds = error.message.match(/(\d+)s/) ? parseInt(error.message.match(/(\d+)s/)[1]) : 60;
      console.error(`[Processor] FloodWaitError detected, returning 429 with Retry-After: ${waitSeconds}s`);
      
      // Return 429 with Retry-After header for AIMD frontend
      return new Response(JSON.stringify({ 
        success: false, 
        floodWait: waitSeconds,
        error: `FloodWaitError: Need to wait ${waitSeconds} seconds` 
      }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(waitSeconds)
        }
      });
    }
    
    return c.json({ 
      success: false, 
      error: error.message 
    }, 500);
  } finally {
    // 释放处理锁，无论成功或失败
    if (c.env.PROCESSING_LOCK) {
      c.env.PROCESSING_LOCK[processingKey] = false;
      console.log(`[Processor] Released processing lock for ${processingKey}`);
    }
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
      telegram_message_id ASC
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
        telegram_message_id ASC
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
      
      // CRITICAL: Validate result has required properties to prevent fake success
      if (result.success && (!result.mediaKey || result.mediaKey.trim() === '')) {
        console.error(`[Processor Batch] [FAKE SUCCESS DETECTED] Message ${pendingMessage.telegram_message_id} returned success but no mediaKey`);
        throw new Error(`[Validation Failed] Success reported but no mediaKey for message ${pendingMessage.telegram_message_id}`);
      }
      
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
        // CRITICAL: Verify mediaKey exists and is valid before counting as success
        if (!result.mediaKey) {
          throw new Error(`[Validation Failed] Success reported but mediaKey is missing for message ${pendingMessage.telegram_message_id}`);
        }
        
        console.log(`[Processor Batch] [Verified Success] Message ${pendingMessage.telegram_message_id} processed with mediaKey: ${result.mediaKey}`);
        processedCount++;
        results.push({
          success: true,
          id: String(pendingMessage.telegram_message_id), // Use telegram_message_id as frontend key
          processedId: Number(pendingMessage.id),
          messageId: pendingMessage.telegram_message_id,
          chatId: pendingMessage.chat_id,
          media_key: result.mediaKey, // Match DB field name
          media_status: 'completed', // Explicit status for optimistic update
          mediaKey: result.mediaKey, // Keep for backward compatibility
          mediaType: pendingMessage.media_type
        });
      } else {
        // Mark as explicit failure
        console.error(`[Processor Batch] [Explicit Failure] Message ${pendingMessage.telegram_message_id}: ${result.error || 'Unknown error'}`);
        
        // Update message status to failed in DB with defensive error handling
        try {
          // Try to save the specific error message (requires error_message column)
          await c.env.DB.prepare(`
            UPDATE messages SET media_status = 'failed', error_message = ? WHERE id = ?
          `).bind((result.error || 'Unknown error').substring(0, 255), String(pendingMessage.id)).run();
          console.log(`[Processor Batch] Updated message ${pendingMessage.telegram_message_id} to 'failed' with error message`);
        } catch (dbError) {
          console.error(`[Double Fault] Failed to save error to DB. Fallback to simple status update.`, dbError);
          // Fallback: Update status WITHOUT error_message column if schema is still old
          try {
            await c.env.DB.prepare(`
              UPDATE messages SET media_status = 'failed' WHERE id = ?
            `).bind(String(pendingMessage.id)).run();
            console.log(`[Processor Batch] Updated message ${pendingMessage.telegram_message_id} to 'failed' (fallback)`);
          } catch (fallbackError) {
            console.error(`[Critical] Even fallback DB update failed:`, fallbackError);
          }
        }
        
        results.push({
          success: false,
          error: result.error || 'Unknown processing error',
          messageId: pendingMessage.telegram_message_id
        });
      }
    } catch (error) {
      console.error(`[Processor Batch] Error processing item ${pendingMessage.telegram_message_id}:`, error);
      
      // Update message status to failed in DB with defensive error handling
      try {
        // Try to save the specific error message (requires error_message column)
        await c.env.DB.prepare(`
          UPDATE messages SET media_status = 'failed', error_message = ? WHERE id = ?
        `).bind(error.message.substring(0, 255), String(pendingMessage.id)).run();
        console.log(`[Processor Batch] Updated message ${pendingMessage.telegram_message_id} status to 'failed' with error message in DB`);
      } catch (dbError) {
        console.error(`[Double Fault] Failed to save error to DB. Fallback to simple status update.`, dbError);
        // Fallback: Update status WITHOUT error_message column if schema is still old
        try {
          await c.env.DB.prepare(`
            UPDATE messages SET media_status = 'failed' WHERE id = ?
          `).bind(String(pendingMessage.id)).run();
          console.log(`[Processor Batch] Updated message ${pendingMessage.telegram_message_id} status to 'failed' (fallback) in DB`);
        } catch (fallbackError) {
          console.error(`[Critical] Even fallback DB update failed:`, fallbackError);
        }
      }
      
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
        
        // Break out of the loop to handle FloodWaitError at higher level
        throw new Error(`FloodWaitError: Need to wait ${waitSeconds}s`);
      }
      
      // Handle specific data stream errors
      const isDataStreamError = 
        error.message.includes('[Download Failed]') || 
        error.message.includes('[R2 Failed]') || 
        error.message.includes('[Validation Failed]') ||
        error.message.includes('Buffer is empty') ||
        error.message.includes('Buffer too small');
      
      if (isDataStreamError) {
        console.error(`[Processor Batch] [CRITICAL DATA STREAM ERROR] ${error.message}`);
      }
      
      results.push({
        success: false,
        error: error.message,
        errorType: isDataStreamError ? 'DATA_STREAM_ERROR' : 'PROCESSING_ERROR',
        messageId: pendingMessage.telegram_message_id
      });
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
  
  // 添加详细日志以追踪剩余项
  console.log(`[Processor] Remaining count query: ${remainingQuery} with params:`, remainingParams);
  console.log(`[Processor] Remaining count result:`, remainingCount);

  console.log(`[Processor Batch] Completed: ${processedCount} processed, ${skippedCount} skipped, ${remainingCount.count} remaining`);
  
  // Extract processedItems for optimistic UI updates
  const processedItems = results
    .filter(r => r.success && !r.skipped && r.media_key)
    .map(r => ({
      id: r.id,
      telegram_message_id: r.messageId,
      chat_id: r.chatId,
      media_key: r.media_key,
      media_status: r.media_status
    }));
  
  return c.json({
    success: true,
    batchMode: true,
    batchSize: batchSize,
    processedCount: processedCount,
    skippedCount: skippedCount,
    remaining: remainingCount.count,
    hasMore: remainingCount.count > 0,
    processedItems: processedItems, // For optimistic UI updates
    results: results // Keep full results for debugging
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

// Safety Net: Wrap the entire fetch handler in a try-catch to prevent silent crashes
export default {
  async fetch(request, env, ctx) {
    try {
      // Call the original Hono app fetch handler
      return await app.fetch(request, env, ctx);
    } catch (err) {
      // Log the critical error
      console.error(`[CRITICAL WORKER CRASH] ${err.message}`, err.stack);
      
      // Return a proper error response instead of crashing silently
      return new Response(JSON.stringify({
        success: false,
        error: "Critical Worker Crash",
        details: err.message,
        stack: err.stack,
        timestamp: new Date().toISOString()
      }), { 
        status: 500,
        headers: { 
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        }
      });
    }
  }
};
