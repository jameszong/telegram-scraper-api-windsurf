import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { TelegramAuthService } from './auth.js';
import { ChannelsService } from './channels.js';
import { SyncService } from './sync.js';

const app = new Hono();

// STEP 1: CORS Middleware (MUST BE FIRST)
app.use('/*', cors({
  origin: '*', 
  allowMethods: ['POST', 'GET', 'OPTIONS', 'PUT', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Access-Key'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: true,
}));

// STEP 2: Access Key Middleware (AFTER CORS)
app.use('/*', async (c, next) => {
  // ALLOW PUBLIC ACCESS TO MEDIA
  // Browser img tags cannot send headers, so media must be public.
  if (c.req.path.startsWith('/media/') || c.req.path === '/media') {
    return next();
  }
  
  // Skip check for OPTIONS requests (Preflight)
  if (c.req.method === 'OPTIONS') {
    return next();
  }
  
  // Skip access key check for health check
  if (c.req.path === '/' && c.req.method === 'GET') {
    await next();
    return;
  }
  
  const accessKey = c.req.header('X-Access-Key');
  const expectedKey = c.env.ACCESS_KEY;
  
  if (!accessKey || accessKey !== expectedKey) {
    return c.json({ 
      success: false, 
      error: 'Unauthorized - Invalid or missing access key' 
    }, 401);
  }
  
  await next();
});

// Initialize services
app.use('/*', async (c, next) => {
  c.set('authService', new TelegramAuthService(c.env));
  c.set('channelsService', new ChannelsService(c.env));
  c.set('syncService', new SyncService(c.env));
  await next();
});

// Health check
app.get('/', (c) => {
  return c.json({ message: 'Telegram Archiver API', status: 'running' });
});

// Auth routes
app.post('/auth/login', async (c) => {
  const { phoneNumber } = await c.req.json();
  const authService = c.get('authService');
  
  if (!phoneNumber) {
    return c.json({ success: false, error: 'Phone number is required' }, 400);
  }

  const result = await authService.startAuth(phoneNumber);
  return c.json(result);
});

app.post('/auth/verify', async (c) => {
  // 1. Extract inputs
  const { phone, code, phoneCodeHash, session } = await c.req.json();
  
  console.log('Debug: Starting Verify. Phone:', phone, 'Hash:', phoneCodeHash, 'Session Length:', session ? session.length : 'N/A');
  
  if (!phone || !code || !phoneCodeHash || !session) {
    return c.json({ success: false, error: 'All fields are required' }, 400);
  }

  try {
    // 2. Reconstruct Client (STATELESS)
    // We MUST use the session string from step 1 to resurrect the client
    const stringSession = new StringSession(session || ""); 
    const client = new TelegramClient(stringSession, Number(c.env.TELEGRAM_API_ID), c.env.TELEGRAM_API_HASH, {
        connectionRetries: 5,
    });

    // 3. CRITICAL DEBUGGING
    console.log('Debug: Client created. Is instance?', client instanceof TelegramClient);
    
    // 4. CRITICAL: AWAIT CONNECT
    console.log('Debug: Connecting...');
    await client.connect(); 
    console.log('Debug: Connected!');

    // 5. SIGN IN
    // Use raw invoke to bypass missing mixin methods
    console.log('Debug: Invoking raw Api.auth.SignIn...');
    const result = await client.invoke(
        new Api.auth.SignIn({
            phoneNumber: phone,
            phoneCodeHash: phoneCodeHash,
            phoneCode: code,
        })
    );
    console.log('Debug: Raw SignIn successful. User:', result.user ? result.user.id : 'Unknown');
    
    if (result) {
      const finalSessionString = client.session.save();
      
      // Save final authenticated session to D1
      await c.env.DB.prepare(
        'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)'
      ).bind('session_string', finalSessionString).run();

      await client.disconnect();

      return c.json({
        success: true,
        sessionString: finalSessionString,
        message: 'Authentication successful'
      });
    }
    
    await client.disconnect();
    return c.json({ success: false, error: 'Authentication failed' });
    
  } catch (e) {
    console.error('CRITICAL ERROR inside verify:', e);
    console.error('Error Stack:', e.stack);
    return c.json({ error: e.message, stack: e.stack }, 500);
  }
});

// Channels routes
app.get('/channels', async (c) => {
  const channelsService = c.get('channelsService');
  const result = await channelsService.getChannels();
  return c.json(result);
});

app.post('/channels/select', async (c) => {
  const { channelId } = await c.req.json();
  const channelsService = c.get('channelsService');
  
  if (!channelId) {
    return c.json({ success: false, error: 'Channel ID is required' }, 400);
  }

  const result = await channelsService.selectChannel(channelId);
  return c.json(result);
});

app.post('/auth/verify2fa', async (c) => {
  const { password } = await c.req.json();
  const authService = c.get('authService');
  
  if (!password) {
    return c.json({ success: false, error: 'Password is required' }, 400);
  }

  const result = await authService.verify2FA(password);
  return c.json(result);
});

// Messages routes
app.get('/messages', async (c) => {
  const channelId = c.req.query('channelId');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const syncService = c.get('syncService');
  
  // CRITICAL: Validate channelId to prevent data leakage
  if (!channelId) {
    console.log('Debug: Missing channelId parameter - returning empty array');
    return c.json({ success: false, error: 'channelId is required' }, 400);
  }
  
  console.log(`Debug: Fetching messages for channel ${channelId}, limit: ${limit}, offset: ${offset}`);
  
  // CRITICAL FIX: Count total messages for pagination
  const totalResult = await c.env.DB.prepare(`
    SELECT COUNT(*) as count FROM messages WHERE chat_id = ?
  `).bind(channelId).first();
  const total = totalResult?.count || 0;
  
  console.log(`Debug: Total messages for channel ${channelId}: ${total}`);
  
  const result = await syncService.getArchivedMessages(channelId, limit, offset);
  
  // Add R2 public URLs to messages with media
  const r2PublicUrl = c.env.R2_PUBLIC_URL;
  if (r2PublicUrl && result.messages.length > 0) {
    result.messages = result.messages.map(message => {
      if (message.media_key) {
        return {
          ...message,
          media_url: `${r2PublicUrl}/${message.media_key}`
        };
      }
      // Explicitly set media_url to null for consistency
      return {
        ...message,
        media_url: null
      };
    });
  } else if (result.messages.length > 0) {
    // Ensure media_url field exists even if R2_PUBLIC_URL is not set
    result.messages = result.messages.map(message => ({
      ...message,
      media_url: message.media_key ? null : null
    }));
  }
  
  // Debug: Log fetched data structure
  console.log(`Debug: Fetched ${result.messages.length} messages from DB for channel ${channelId}`);
  if (result.messages.length > 0) {
    console.log('Debug: Sample message structure:', JSON.stringify(result.messages[0], null, 2));
    console.log('Debug: First message keys:', Object.keys(result.messages[0]));
    console.log('Debug: Sample media_key:', result.messages[0].r2_key);
    console.log('Debug: Sample grouped_id:', result.messages[0].grouped_id);
  }
  
  // CRITICAL FIX: Return pagination data
  const page = Math.floor(offset / limit) + 1;
  return c.json({
    ...result,
    pagination: {
      total,
      page,
      limit,
      hasMore: offset + limit < total
    }
  });
});

// Sync routes
app.post('/sync', async (c) => {
  const syncService = c.get('syncService');
  const authService = c.get('authService');
  
  // CRITICAL: Sync credentials to D1 before any sync operation
  console.log('[Sync] Syncing credentials to D1...');
  const configSync = await authService.syncEnvToDb();
  if (!configSync.success) {
    console.error('[Sync] Failed to sync credentials to D1:', configSync.error);
    return c.json({ success: false, error: 'Failed to sync credentials to D1' }, 500);
  }
  
  const result = await syncService.syncMessages();
  
  // Calculate dynamic cooldown to prevent Cloudflare 503 errors
  // Phase A is text-only, should be near-instant (max 200ms)
  const mediaCount = result.media || 0;
  
  // CRITICAL: Force fast cooldown for Phase A (text-only sync)
  // Only penalize actual completed downloads, not pending media
  let suggestedCooldown;
  if (mediaCount === 0) {
    suggestedCooldown = 200; // Max 200ms for text-only batches
  } else {
    // This should rarely happen in Phase A since we don't download media
    suggestedCooldown = 200; // Still keep it fast
  }
  
  console.log(`Debug: Phase A sync - synced: ${result.synced}, media_pending: ${mediaCount}, forced_cooldown: ${suggestedCooldown}ms`);
  
  console.log(`Debug: Sync complete - synced: ${result.synced}, media: ${mediaCount}, suggestedCooldown: ${suggestedCooldown}ms`);
  
  return c.json(result);
});

// SSE: Streaming Batch Processing for real-time feedback
app.get('/messages/batch-stream', async (c) => {
  const idsParam = c.req.query('ids');
  const chatId = c.req.query('chatId');
  
  if (!idsParam || !chatId) {
    return c.json({ error: 'ids and chatId parameters required' }, 400);
  }
  
  const messageIds = idsParam.split(',').map(id => id.trim()).filter(Boolean);
  
  if (messageIds.length === 0) {
    return c.json({ error: 'No valid message IDs provided' }, 400);
  }
  
  console.log(`[SSE] Starting batch stream for ${messageIds.length} messages in chat ${chatId}`);
  
  return streamSSE(c, async (stream) => {
    const startTime = Date.now();
    const TIME_BUDGET = 25000; // 25 seconds max
    let processedCount = 0;
    let successCount = 0;
    let failedCount = 0;
    
    try {
      // Send initial event
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'start',
          total: messageIds.length,
          timestamp: Date.now()
        })
      });
      
      // Process each message
      for (const messageId of messageIds) {
        // Check time budget
        const elapsed = Date.now() - startTime;
        if (elapsed > TIME_BUDGET) {
          await stream.writeSSE({
            data: JSON.stringify({
              type: 'timeout',
              processed: processedCount,
              remaining: messageIds.length - processedCount,
              elapsed
            })
          });
          break;
        }
        
        try {
          // Fetch message from DB
          const message = await c.env.DB.prepare(`
            SELECT id, telegram_message_id, chat_id, text, date, media_status, media_type, media_key, grouped_id
            FROM messages 
            WHERE telegram_message_id = ? AND chat_id = ?
            LIMIT 1
          `).bind(String(messageId), String(chatId)).first();
          
          if (!message) {
            await stream.writeSSE({
              data: JSON.stringify({
                type: 'error',
                messageId,
                error: 'Message not found',
                timestamp: Date.now()
              })
            });
            failedCount++;
            processedCount++;
            continue;
          }
          
          // Skip if already completed
          if (message.media_status === 'completed' && message.media_key) {
            await stream.writeSSE({
              data: JSON.stringify({
                type: 'skip',
                messageId,
                reason: 'Already completed',
                mediaKey: message.media_key,
                timestamp: Date.now()
              })
            });
            successCount++;
            processedCount++;
            continue;
          }
          
          // Send processing event
          await stream.writeSSE({
            data: JSON.stringify({
              type: 'processing',
              messageId,
              progress: processedCount + 1,
              total: messageIds.length,
              timestamp: Date.now()
            })
          });
          
          // Process the media using Processor service
          // Note: We need to call the Processor worker here
          const processorUrl = c.env.PROCESSOR_URL || 'http://localhost:8788';
          const response = await fetch(`${processorUrl}/download-media`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Access-Key': c.env.ACCESS_KEY || ''
            },
            body: JSON.stringify({
              messageId: message.telegram_message_id,
              chatId: message.chat_id
            })
          });
          
          const result = await response.json();
          
          if (result.success) {
            await stream.writeSSE({
              data: JSON.stringify({
                type: 'completed',
                messageId,
                mediaKey: result.mediaKey,
                progress: processedCount + 1,
                total: messageIds.length,
                timestamp: Date.now()
              })
            });
            successCount++;
          } else {
            await stream.writeSSE({
              data: JSON.stringify({
                type: 'failed',
                messageId,
                error: result.error || 'Unknown error',
                skipped: result.skipped,
                skipReason: result.skipReason,
                timestamp: Date.now()
              })
            });
            failedCount++;
          }
          
          processedCount++;
          
          // Add small delay between requests (1 second)
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          console.error(`[SSE] Error processing message ${messageId}:`, error);
          await stream.writeSSE({
            data: JSON.stringify({
              type: 'error',
              messageId,
              error: error.message,
              timestamp: Date.now()
            })
          });
          failedCount++;
          processedCount++;
        }
      }
      
      // Send completion event
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'complete',
          processed: processedCount,
          success: successCount,
          failed: failedCount,
          elapsed: Date.now() - startTime,
          timestamp: Date.now()
        })
      });
      
    } catch (error) {
      console.error('[SSE] Stream error:', error);
      await stream.writeSSE({
        data: JSON.stringify({
          type: 'error',
          error: error.message,
          timestamp: Date.now()
        })
      });
    }
  });
});

// Media processing routes
app.post('/process-media', async (c) => {
  const syncService = c.get('syncService');
  
  try {
    // Step 1: Fetch pending task with retry logic
    // Prioritize pending, then retry failed items
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

    console.log(`Debug: Processing media for message ${pendingMessage.telegram_message_id}, type: ${pendingMessage.media_type}, status: ${pendingMessage.media_status}`);

    // Step 2: Process the media
    const result = await syncService.processMediaMessage(pendingMessage);

    // CRITICAL FIX: Update DB status for skipped items to prevent infinite loops
    if (result.skipped) {
      console.log(`[Phase B] Updating DB status for skipped message ${pendingMessage.telegram_message_id}: ${result.reason}`);
      
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

    // Step 3: Count remaining pending tasks (including failed for retry)
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
    console.error('Process media error:', error);
    return c.json({ 
      success: false, 
      error: error.message 
    }, 500);
  }
});

// Debug routes
app.get('/debug/schema', async (c) => {
  try {
    const messagesSchema = await c.env.DB.prepare("PRAGMA table_info(messages)").all();
    const mediaSchema = await c.env.DB.prepare("PRAGMA table_info(media)").all();
    
    console.log('Debug: Messages table schema:', JSON.stringify(messagesSchema.results, null, 2));
    console.log('Debug: Media table schema:', JSON.stringify(mediaSchema.results, null, 2));
    
    return c.json({
      messages: messagesSchema.results,
      media: mediaSchema.results
    });
  } catch (error) {
    console.error('Debug: Schema query error:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Debug endpoint to force seed credentials to D1
app.get('/debug/seed-config', async (c) => {
  const authService = c.get('authService');
  
  try {
    console.log('[Debug] Force seeding credentials to D1...');
    
    // Read credentials from environment
    const configs = [
      { key: 'TELEGRAM_API_ID', value: c.env.TELEGRAM_API_ID?.toString() || '' },
      { key: 'TELEGRAM_API_HASH', value: c.env.TELEGRAM_API_HASH || '' },
      { key: 'R2_PUBLIC_URL', value: c.env.R2_PUBLIC_URL || '' },
      { key: 'ACCESS_KEY', value: c.env.ACCESS_KEY || '' }
    ];
    
    // Get session from kv_store
    let sessionString = '';
    try {
      const sessionResult = await c.env.DB.prepare(
        'SELECT value FROM kv_store WHERE key = ?'
      ).bind('session_string').first();
      sessionString = sessionResult?.value || '';
      configs.push({ key: 'TELEGRAM_SESSION', value: sessionString });
    } catch (error) {
      console.log('[Debug] Could not read session from kv_store:', error.message);
      configs.push({ key: 'TELEGRAM_SESSION', value: '' });
    }
    
    const seededKeys = [];
    
    // Write each config to D1
    for (const config of configs) {
      await c.env.DB.prepare(`
        INSERT INTO app_config (key, value, updated_at) 
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET 
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP
      `).bind(config.key, config.value).run();
      
      if (config.value) {
        seededKeys.push(config.key);
        console.log(`[Debug] Seeded ${config.key}:`, config.key === 'TELEGRAM_SESSION' ? '***SESSION***' : config.value);
      } else {
        console.log(`[Debug] Skipped ${config.key}: empty value`);
      }
    }
    
    console.log(`[Debug] Successfully seeded ${seededKeys.length} configurations to D1`);
    
    return c.json({ 
      success: true, 
      seeded: seededKeys,
      message: `Seeded ${seededKeys.length} configurations to D1`
    });
  } catch (error) {
    console.error('[Debug] Failed to seed config:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// Temporary admin cleanup endpoint
app.post('/admin/clear-r2', async (c) => {
  try {
    console.log('Debug: Starting R2 bucket cleanup...');
    
    // List all objects in the bucket
    const listResult = await c.env.BUCKET.list();
    console.log(`Debug: Found ${listResult.objects.length} objects in R2`);
    
    let deletedCount = 0;
    
    // Delete each object
    for (const object of listResult.objects) {
      await c.env.BUCKET.delete(object.key);
      console.log(`Debug: Deleted R2 object: ${object.key}`);
      deletedCount++;
    }
    
    console.log(`Debug: R2 cleanup complete. Deleted ${deletedCount} objects`);
    
    return c.json({
      success: true,
      deleted: deletedCount,
      message: `Successfully deleted ${deletedCount} objects from R2`
    });
    
  } catch (error) {
    console.error('Error clearing R2 bucket:', error);
    return c.json({ 
      success: false, 
      error: error.message 
    }, 500);
  }
});

// Media routes - Allow keys with slashes
app.get('/media/*', async (c) => {
  // Extract key: remove the leading '/media/' route prefix
  // If request is /media/media/filename.jpg -> key is media/filename.jpg (Correct for R2)
  const key = c.req.path.replace(/^\/media\//, '');
  
  console.log(`Debug: Media request - Key: "${key}"`);
  console.log(`Debug: Media request - Full path: "${c.req.path}"`);
  
  try {
    const object = await c.env.BUCKET.get(key);
    
    console.log(`Debug: R2 object found: ${!!object}`);
    
    if (!object) {
      console.log(`Debug: Media not found for key: "${key}"`);
      return c.text('Not Found', 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    // Important: Cache content to make images load fast
    headers.set('Cache-Control', 'public, max-age=31536000');

    console.log(`Debug: Serving media with headers:`, Object.fromEntries(headers.entries()));
    return new Response(object.body, { headers });
  } catch (error) {
    console.error('Error serving media:', error);
    return c.text('Failed to serve media', 500);
  }
});

export default {
  fetch: app.fetch,
};
