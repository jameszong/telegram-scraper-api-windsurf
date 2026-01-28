import { TelegramClient } from 'telegram';
import { ProcessorAuthService } from './auth.js';

// BigInt helper function
function toBigInt(val) {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'string') return BigInt(val);
  if (typeof val === 'number') return BigInt(val);
  return 0n;
}

export class ProcessorSyncService {
  constructor(env) {
    this.env = env;
    this.authService = new ProcessorAuthService(env);
  }

  async getTargetChannel() {
    try {
      const result = await this.env.DB.prepare(
        'SELECT value FROM kv_store WHERE key = ?'
      ).bind('target_channel_id').first();
      
      return result ? String(result.value) : null;
    } catch (error) {
      console.error('Error getting target channel:', error);
      return null;
    }
  }

  async getClient() {
    return await this.authService.getClient();
  }

  async getR2PublicUrl() {
    return await this.authService.getR2PublicUrl();
  }

  // Phase B: Media processing only
  async processMediaMessage(pendingMessage) {
    // 添加详细日志以追踪消息处理
    console.log(`[Processor] Starting media processing for message ${pendingMessage.telegram_message_id} with detailed logging`);
    
    try {
      console.log(`[Processor] Starting media processing for message ${pendingMessage.telegram_message_id}`);

      const targetChannelId = await this.getTargetChannel();

      if (!targetChannelId) {
        throw new Error('No target channel selected');
      }

      // Connect to Telegram with robust initialization
      console.log(`[Processor] Getting Telegram client...`);
      let client;
      try {
        client = await this.getClient();
        console.log(`[Processor] Client object created successfully`);
      } catch (clientError) {
        console.error(`[CRITICAL] Failed to create Telegram client:`, clientError);
        throw new Error(`Failed to create Telegram client: ${clientError.message}`);
      }
      
      console.log(`[Processor] Initializing Telegram client connection...`);
      
      // Ensure client is properly connected with retry logic
      let connectionAttempts = 0;
      const maxConnectionAttempts = 3;
      
      while (connectionAttempts < maxConnectionAttempts) {
        try {
          // First disconnect to ensure clean state
          console.log(`[Processor] Disconnecting any existing connections...`);
          try { 
            await client.disconnect(); 
            console.log(`[Processor] Successfully disconnected previous connection`);
          } catch (disconnectError) { 
            console.warn(`[Processor] Disconnect error (can be ignored):`, disconnectError.message); 
          }
          
          // Attempt connection with timeout
          console.log(`[Processor] Attempting to connect (attempt ${connectionAttempts + 1})...`);
          const connectPromise = client.connect();
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Connection timeout after 15s')), 15000)
          );
          
          await Promise.race([connectPromise, timeoutPromise]);
          console.log(`[Processor] Telegram client connected successfully (attempt ${connectionAttempts + 1})`);
          
          // Verify connection with timeout
          console.log(`[Processor] Verifying connection with getMe()...`);
          const getMePromise = client.getMe();
          const verifyTimeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('getMe verification timeout after 10s')), 10000)
          );
          
          const self = await Promise.race([getMePromise, verifyTimeoutPromise]);
          if (self) {
            console.log(`[Processor] Connection verified - User: ${self.firstName || self.id}`);
            break;
          } else {
            throw new Error('Connection verification failed - getMe returned empty result');
          }
        } catch (connError) {
          connectionAttempts++;
          console.error(`[CRITICAL] Connection attempt ${connectionAttempts} failed:`, connError.message);
          console.error(`[CRITICAL] Error details:`, connError);
          
          if (connectionAttempts >= maxConnectionAttempts) {
            throw new Error(`Failed to establish Telegram connection after ${maxConnectionAttempts} attempts: ${connError.message}`);
          }
          
          // Exponential backoff
          const waitTime = Math.min(1000 * Math.pow(2, connectionAttempts), 8000); // Max 8 seconds
          console.log(`[Processor] Waiting ${waitTime}ms before next connection attempt`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }

      // Get channel entity
      const channelBigInt = toBigInt(pendingMessage.chat_id);
      console.log(`[Processor] Resolving channel entity for chat_id: ${pendingMessage.chat_id} -> ${channelBigInt}`);
      
      const channel = await client.getEntity(channelBigInt);
      console.log(`[Processor] Successfully resolved channel entity`);

      // Fetch the specific message
      const msgIdNum = Number(pendingMessage.telegram_message_id);
      console.log(`[Processor] Fetching message ID: ${pendingMessage.telegram_message_id} -> ${msgIdNum}`);
      
      const messages = await client.getMessages(channel, {
        ids: [msgIdNum]
      });

      if (!messages || messages.length === 0) {
        throw new Error(`Message ${pendingMessage.telegram_message_id} not found`);
      }

      const message = messages[0];
      
      // === STRICT LIGHTWEIGHT IMAGE FILTER (JPG/PNG < 300KB) ===
      // This "Pre-Download Bouncer" prevents OOM crashes and timeouts
      
      // 1. Safe Extraction - Check if media exists
      const media = message.media;
      if (!media) {
        console.log(`[Filter] No media in message ${message.id}`);
        return {
          success: true,
          skipped: true,
          reason: "No media",
          mediaKey: null
        };
      }

      console.log(`[Filter] Inspecting media for message ${message.id}, className: ${media.className}`);

      // 2. Identify Type & Size using className
      let mimeType = 'unknown';
      let size = 0;

      if (media.className === 'MessageMediaDocument' && media.document) {
        // It's a file/document (video, PDF, GIF, etc.)
        mimeType = media.document.mimeType || 'unknown';
        size = media.document.size || 0;
        console.log(`[Filter] Document detected: ${mimeType}, size: ${(size / 1024).toFixed(1)}KB`);
      } else if (media.className === 'MessageMediaPhoto' && media.photo) {
        // It's a compressed photo (Telegram photos are effectively JPEGs)
        mimeType = 'image/jpeg';
        // Find largest size variant (last is usually largest)
        const sizes = media.photo.sizes || [];
        const largest = sizes[sizes.length - 1];
        size = largest && largest.size ? Number(largest.size) : 0;
        console.log(`[Filter] Photo detected: ${mimeType}, size: ${(size / 1024).toFixed(1)}KB`);
      } else {
        // It's a GeoPoint, Contact, Game, Poll, etc. -> SKIP
        console.log(`[Filter] Unsupported media class: ${media.className}`);
        return {
          success: true,
          skipped: true,
          reason: "Unsupported media class",
          mediaKey: null
        };
      }

      // 3. ENFORCE POLICY (Strict Whitelist: JPG/PNG < 300KB)
      const MAX_SIZE = 300 * 1024; // 300KB strict limit
      const isImage = /image\/(jpeg|jpg|png)/i.test(mimeType);
      const isSmall = size <= MAX_SIZE;

      if (!isImage) {
        console.log(`[Filter] Skipping non-image: ${mimeType}`);
        return {
          success: true,
          skipped: true,
          reason: "Not an image",
          mediaKey: null
        };
      }

      if (!isSmall) {
        console.log(`[Filter] Skipping large file: ${(size / 1024).toFixed(1)}KB > 300KB`);
        return {
          success: true,
          skipped: true,
          reason: "File too large (>300KB)",
          mediaKey: null
        };
      }

      // === DRY RUN MODE - SKIP DOWNLOAD/UPLOAD TO ISOLATE CRASH ===
      // This prevents OOM and network issues to test Worker infrastructure
      
      // SAFE METADATA EXTRACTION (No crash allowed)
      let debugInfo = "No Media";
      let extractedSize = 0;
      try {
        if (message.media) {
          if (message.media.document) {
            extractedSize = message.media.document.size || 0;
            debugInfo = `Document (${message.media.document.mimeType || 'unknown'})`;
          } else if (message.media.photo) {
            extractedSize = size; // Use size from filter check
            debugInfo = "Photo";
          }
        }
      } catch (e) { 
        debugInfo = "Metadata Error";
        console.error(`[DRY RUN] Metadata extraction error:`, e);
      }

      // FORCE SKIP DOWNLOAD (Dry Run)
      console.log(`[DRY RUN] Would process: MsgID ${message.id} | ${debugInfo} | Size: ${extractedSize} bytes`);
      
      // Generate a placeholder key for dry run
      const r2ChatIdStr = String(targetChannelId);
      const messageIdStr = message.id.toString();
      const dryRunKey = `dry_run/${r2ChatIdStr}_${messageIdStr}_placeholder.jpg`;
      
      // Return "Virtual Success" to prove connectivity
      console.log(`[DRY RUN] Virtual success for message ${pendingMessage.telegram_message_id}`);
      
      // Update database with dry run status
      console.log(`[DRY RUN] Updating DB for message ${pendingMessage.telegram_message_id} with dry run key: ${dryRunKey}`);
      
      // CRITICAL: Use telegram_message_id AND chat_id as unique key
      const msgIdStr = String(pendingMessage.telegram_message_id);
      const chatIdStr = String(pendingMessage.chat_id);
      
      const result = await this.env.DB.prepare(`
        UPDATE messages 
        SET media_status = 'completed', media_key = ? 
        WHERE telegram_message_id = ? AND chat_id = ?
      `).bind(dryRunKey, msgIdStr, chatIdStr).run();
      
      if (result.meta.changes === 0) {
        throw new Error(`[DRY RUN] DB UPDATE FAILED - No rows affected for message ${msgIdStr}`);
      }
      
      console.log(`[DRY RUN] DB updated successfully for message ${msgIdStr}`);
      
      // Return "Fake" Success to prove connectivity
      return { 
        success: true, 
        dryRun: true, 
        mediaKey: dryRunKey,
        mediaData: {
          type: 'image',
          extension: 'jpg',
          size: extractedSize,
          mime_type: 'image/jpeg',
          r2_key: dryRunKey
        }
      };
      
      // === COMMENTED OUT: ACTUAL DOWNLOAD/UPLOAD CODE ===
      // The following code is disabled for dry run mode
      /*
      // 4. Safe Download - Filter passed
      console.log(`[Filter Passed] Downloading ${mimeType} (${size} bytes)...`);

      // TURBO MODE: Fast photo download without artificial delays
      const downloadPromise = client.downloadMedia(message, { workers: 1 });
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Download timed out > 30s')), 30000)
      );

      let buffer;
      try {
        buffer = await Promise.race([downloadPromise, timeoutPromise]);
      } catch (error) {
        console.error(`[Processor] Error/Timeout for message ${message.id}:`, error.message);
        
        // Check for FloodWaitError
        if (error.message && error.message.includes('FloodWaitError')) {
          const waitSeconds = error.message.match(/(\d+)s/) ? parseInt(error.message.match(/(\d+)s/)[1]) : 60;
          console.error(`[Processor] FloodWaitError detected: need to wait ${waitSeconds} seconds`);
          
          // Fast-fail: if wait time > 5 seconds, don't wait in the worker
          if (waitSeconds > 5) {
            console.log(`[Processor] Fast-fail: wait time ${waitSeconds}s > 5s, returning immediately`);
            return {
              success: false,
              skipped: true,
              reason: "RateLimit",
              floodWait: waitSeconds,
              error: `Rate limited: Need to wait ${waitSeconds} seconds`
            };
          }
          
          // For short waits (<= 5s), we can wait in the worker
          console.log(`[Processor] Short wait time ${waitSeconds}s, waiting in worker`);
          await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
          // Retry the operation after waiting
          return {
            success: false,
            skipped: true,
            reason: "RateLimit",
            floodWait: waitSeconds,
            error: `Rate limited: Need to wait ${waitSeconds} seconds`
          };
        }
        
        return {
          success: false,
          error: error.message,
          mediaKey: null
        };
      }
      
      // CRITICAL: Verify buffer before uploading
      if (!buffer || buffer.length === 0) {
        console.error(`[Processor] [Download Failed] Buffer is empty for MsgID ${message.id}`);
        throw new Error(`[Download Failed] Buffer is empty for MsgID ${message.id}`);
      }
      
      // Validate buffer size is reasonable (at least 100 bytes for a minimal image)
      if (buffer.length < 100) {
        console.error(`[Processor] [Download Failed] Buffer too small (${buffer.length} bytes) for MsgID ${message.id}`);
        throw new Error(`[Download Failed] Buffer too small (${buffer.length} bytes) for MsgID ${message.id}`);
      }
      
      console.log(`[Data Stream] Downloaded ${buffer.length} bytes for MsgID ${message.id}`);

      // Generate R2 key
      const r2ChatIdStr = String(targetChannelId);
      const messageIdStr = message.id.toString();
      const extension = this.getMediaExtension(message.media.className);
      const key = `media/${r2ChatIdStr}_${messageIdStr}_${Date.now()}.${extension}`;

      console.log(`[Processor] Uploading to R2: ${key}`);

      // Upload to R2 with error handling and validation
      try {
        // Capture the result of the R2 put operation
        const r2Object = await this.env.BUCKET.put(key, buffer, {
          httpMetadata: {
            contentType: this.getContentType(message.media.className)
          }
        });
        
        // Validate the R2 operation returned a valid object
        if (!r2Object || !r2Object.key) {
          console.error(`[Processor] [R2 Failed] Write operation returned null for ${key}`);
          throw new Error(`[R2 Failed] Write operation returned null for ${key}`);
        }
        
        console.log(`[R2 Success] Wrote ${buffer.length} bytes to ${r2Object.key}`);
      } catch (uploadError) {
        console.error(`[Processor] R2 upload failed for message ${message.id}:`, uploadError);
        throw new Error('R2 upload failed: ' + uploadError.message);
      }
      */
      // === DRY RUN COMPLETE ===
      // All actual download/upload code is commented out above

    } catch (error) {
      console.error(`[Processor] Error processing media for message ${pendingMessage.telegram_message_id}:`, error);
      
      // Add detailed error information for debugging
      const errorDetails = {
        success: false,
        error: error.message,
        errorType: error.name,
        messageId: pendingMessage.telegram_message_id,
        chatId: pendingMessage.chat_id,
        mediaType: pendingMessage.media_type,
        // Include stack trace in development only
        stack: error.stack ? error.stack.split('\n').slice(0, 3).join('\n') : null
      };
      
      console.error(`[Processor] [Error Details] ${JSON.stringify(errorDetails)}`);
      
      // Re-throw specific critical errors to prevent batch from continuing with false success
      if (error.message.includes('[Download Failed]') || 
          error.message.includes('[R2 Failed]') || 
          error.message.includes('Buffer is empty') ||
          error.message.includes('Buffer too small')) {
        throw error; // Let the batch processor handle this
      }
      
      return errorDetails;
    }
  }

  // Helper methods for media processing
  getMediaExtension(mediaClassName) {
    switch (mediaClassName) {
      case 'MessageMediaPhoto':
        return 'jpg';
      case 'MessageMediaVideo':
        return 'mp4';
      case 'MessageMediaDocument':
        return 'bin';
      default:
        return 'bin';
    }
  }

  getMediaType(mediaClassName) {
    switch (mediaClassName) {
      case 'MessageMediaPhoto':
        return 'photo';
      case 'MessageMediaVideo':
        return 'video';
      case 'MessageMediaDocument':
        return 'document';
      default:
        return 'unknown';
    }
  }

  getContentType(mediaClassName) {
    switch (mediaClassName) {
      case 'MessageMediaPhoto':
        return 'image/jpeg';
      case 'MessageMediaVideo':
        return 'video/mp4';
      case 'MessageMediaDocument':
        return 'application/octet-stream';
      default:
        return 'application/octet-stream';
    }
  }

  async saveMediaRecord(messageId, mediaData) {
    try {
      await this.env.DB.prepare(`
        INSERT INTO media (message_id, r2_key, file_type, file_size, mime_type)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        messageId,
        mediaData.r2_key,
        mediaData.type,
        mediaData.size,
        mediaData.mime_type
      ).run();

      console.log(`[Processor] Saved media record for message ${messageId}`);
    } catch (error) {
      console.error('[Processor] Error saving media record:', error);
      throw error;
    }
  }
}
