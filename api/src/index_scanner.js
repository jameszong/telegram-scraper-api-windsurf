import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { TelegramAuthService } from './auth.js';
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
  
  // Public endpoints
  const publicPaths = ['/', '/health'];
  if (publicPaths.includes(c.req.path)) {
    return next();
  }
  
  const accessKey = c.req.header('X-Access-Key');
  
  if (!accessKey) {
    return c.json({ error: 'Access key required' }, 401);
  }
  
  // Validate access key against D1
  const result = await c.env.DB.prepare(
    'SELECT value FROM kv_store WHERE key = ?'
  ).bind('access_key').first();
  
  if (!result || result.value !== accessKey) {
    return c.json({ error: 'Invalid access key' }, 401);
  }
  
  await next();
});

// STEP 3: Dependency Injection
app.use('/*', async (c, next) => {
  const authService = new TelegramAuthService(c.env);
  const syncService = new SyncService(c.env);
  
  c.set('authService', authService);
  c.set('syncService', syncService);
  
  await next();
});

// Health check
app.get('/', (c) => {
  return c.json({ 
    message: 'Telegram Archiver API - Scanner & Config Master', 
    status: 'running',
    worker: 'scanner'
  });
});

app.get('/health', (c) => {
  return c.json({ status: 'healthy' });
});

// Auth routes
app.post('/auth/login', async (c) => {
  const { phoneNumber } = await c.req.json();
  const authService = c.get('authService');
  
  try {
    const result = await authService.startAuth(phoneNumber);
    return c.json(result);
  } catch (error) {
    console.error('Login error:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.post('/auth/verify', async (c) => {
  const { phone, code, phoneCodeHash, session } = await c.req.json();
  const authService = c.get('authService');
  
  try {
    const result = await authService.verifyCode(phone, code, phoneCodeHash, session);
    
    // CRITICAL: Sync config to D1 after successful auth
    if (result.success) {
      await authService.syncEnvToDb();
    }
    
    return c.json(result);
  } catch (error) {
    console.error('Verification error:', error);
    return c.json({ error: error.message }, 500);
  }
});

app.post('/auth/verify2fa', async (c) => {
  const { password } = await c.req.json();
  const authService = c.get('authService');
  
  try {
    const result = await authService.verify2FA(password);
    
    // CRITICAL: Sync config to D1 after successful 2FA
    if (result.success) {
      await authService.syncEnvToDb();
    }
    
    return c.json(result);
  } catch (error) {
    console.error('2FA verification error:', error);
    return c.json({ error: error.message }, 500);
  }
});

// Sync routes (Phase A only)
app.post('/sync', async (c) => {
  const syncService = c.get('syncService');
  const authService = c.get('authService');
  
  try {
    // CRITICAL: Ensure config is synced before Phase A
    await authService.syncEnvToDb();
    
    const result = await syncService.syncMessages();
    
    // Calculate dynamic cooldown for Phase A (text-only, should be near-instant)
    const mediaCount = result.media || 0;
    let suggestedCooldown;
    if (mediaCount === 0) {
      suggestedCooldown = 200; // Max 200ms for text-only batches
    } else {
      suggestedCooldown = 200; // Still keep it fast
    }
    
    return c.json({
      ...result,
      suggestedCooldown
    });

  } catch (error) {
    console.error('Sync error:', error);
    return c.json({ 
      success: false, 
      error: error.message 
    }, 500);
  }
});

// Config sync endpoint (manual trigger)
app.post('/config/sync', async (c) => {
  const authService = c.get('authService');
  
  try {
    const result = await authService.syncEnvToDb();
    return c.json(result);
  } catch (error) {
    console.error('Config sync error:', error);
    return c.json({ 
      success: false, 
      error: error.message 
    }, 500);
  }
});

// Debug routes
app.get('/debug/config', async (c) => {
  try {
    const configs = await c.env.DB.prepare('SELECT key, value, updated_at FROM app_config').all();
    return c.json({ success: true, configs: configs.results || [] });
  } catch (error) {
    console.error('Debug config error:', error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

export default {
  fetch: app.fetch,
};
