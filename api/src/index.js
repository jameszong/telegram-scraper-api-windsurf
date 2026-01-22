import { Hono } from 'hono';
import { cors } from 'hono/cors';
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
  
  const result = await syncService.getArchivedMessages(channelId, limit, offset);
  
  // Debug: Log fetched data structure
  console.log(`Debug: Fetched ${result.messages.length} messages from DB for channel ${channelId}`);
  if (result.messages.length > 0) {
    console.log('Debug: Sample message structure:', JSON.stringify(result.messages[0], null, 2));
    console.log('Debug: First message keys:', Object.keys(result.messages[0]));
    console.log('Debug: Sample media_key:', result.messages[0].r2_key);
    console.log('Debug: Sample grouped_id:', result.messages[0].grouped_id);
  }
  
  return c.json(result);
});

// Sync routes
app.post('/sync', async (c) => {
  const syncService = c.get('syncService');
  const result = await syncService.syncMessages();
  return c.json(result);
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
