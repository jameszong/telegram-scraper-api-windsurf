import { Hono } from 'hono';
import { cors } from 'hono/cors';
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
  const { phoneNumber, phoneCode, phoneCodeHash, sessionString } = await c.req.json();
  const authService = c.get('authService');
  
  if (!phoneNumber || !phoneCode || !phoneCodeHash || !sessionString) {
    return c.json({ success: false, error: 'All fields are required' }, 400);
  }

  const result = await authService.verifyCode(phoneNumber, phoneCode, phoneCodeHash, sessionString);
  return c.json(result);
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
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const syncService = c.get('syncService');
  
  const result = await syncService.getArchivedMessages(limit, offset);
  return c.json(result);
});

// Sync routes
app.post('/sync', async (c) => {
  const syncService = c.get('syncService');
  const result = await syncService.syncMessages();
  return c.json(result);
});

// Media routes
app.get('/media/:key', async (c) => {
  const key = c.req.param('key');
  
  try {
    const object = await c.env.BUCKET.get(key);
    
    if (!object) {
      return c.json({ error: 'Media not found' }, 404);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag());

    return new Response(object.body, { headers });
  } catch (error) {
    console.error('Error serving media:', error);
    return c.json({ error: 'Failed to serve media' }, 500);
  }
});

export default {
  fetch: app.fetch,
};
